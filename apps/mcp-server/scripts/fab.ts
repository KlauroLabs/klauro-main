/**
 * fab.ts — a thin CLI over the REAL coordination local-store, so parallel
 * agents on one feature coordinate through the actual fabric (~/.klauro/
 * coordination). This is a live dogfood of claim_work / edit-lock / collision
 * on a real multi-agent build, not a simulation.
 *
 *   npx tsx apps/mcp-server/scripts/fab.ts active
 *   npx tsx apps/mcp-server/scripts/fab.ts claim <agentId> "<intent>" <comma,paths> [symbols]
 *   npx tsx apps/mcp-server/scripts/fab.ts announce <agentId> <comma,files>
 *   npx tsx apps/mcp-server/scripts/fab.ts check <agentId> <comma,paths>
 *   npx tsx apps/mcp-server/scripts/fab.ts release <agentId>
 *   npx tsx apps/mcp-server/scripts/fab.ts watch [agentId]
 *   npx tsx apps/mcp-server/scripts/fab.ts diff <agentId>
 *   npx tsx apps/mcp-server/scripts/fab.ts stash <agentId>
 *   npx tsx apps/mcp-server/scripts/fab.ts extend <agentId> <comma,addPaths> [comma,addSymbols]
 *
 * `diff`/`stash` (W6, SPEC-COORDINATION-FABRIC-V3 §6.3/§8: "scoped primitives")
 * are the direct answer to the stash-clobber incident (§3.2/§6.3): one agent's
 * tree-global `git stash` swept a peer's uncommitted work because git has no
 * concept of "whose paths these are." Both are LIMITED to `agentId`'s own
 * active claim paths (never the whole tree) — `diff` runs `git diff -- <paths>`
 * scoped to them; `stash` runs `git stash push -- <paths>` scoped to them, and
 * REFUSES (prints a clear message, exits non-zero) only in the one dangerous
 * case: `agentId` holds NO claimed paths to scope to AND other agents are
 * currently active, i.e. the exact whole-tree-fallback scenario that caused the
 * incident. This is a guardrail on the DESTRUCTIVE whole-tree command, not a
 * claim/edit-lock arbitration — every other awareness surface in this file
 * still never denies a claim.
 *
 * `extend` (W7, SPEC-COORDINATION-FABRIC-V3 §6.3/§8: "I also need to touch
 * X — is that safe?") appends scope onto `agentId`'s ACTIVE work-claim
 * (`<workspace>:<agentId>`, the id `claim` uses) without losing claim
 * identity — same claim_id, union of old+new paths/symbols. Runs the same
 * overlap scan `claim` does against the ADDED scope only, and surfaces
 * conflicts inline; the extension always succeeds (never denied). LOCAL-ONLY
 * for now (see the `extend` case below) — a remote-fabric mirror is proposed,
 * not yet wired (see the artifact diff referenced in the W6/W7 build report).
 *
 * `watch` (W5, SPEC-COORDINATION-FABRIC-V3 §8) is a foreground process for a
 * human running a fleet from a terminal: it starts the local write-hook
 * (auto-announce/record real edits against active claims) for the resolved
 * repo root + workspace, plus the in-flight publisher when a remote fabric is
 * configured, and prints announced/unclaimed/published events to stdout until
 * Ctrl-C.
 *
 * REMOTE MODE (cross-machine, docs/FABRIC-REMOTE.md) is CONFIG-DRIVEN: run
 * `klauro init` once inside the repo (it enables the fabric by default as
 * part of connecting the project) and every command above goes over
 * HTTPS to the coordination API persisted in the repo's .klaurorc
 * (`fabric.endpoint` / `fabric.workspace`; the Bearer token comes from the
 * same ~/.klauro/auth.json store `klauro init`/`login` maintain) — so agents
 * on different machines coordinate through one shared per-workspace claim
 * log with ZERO per-shell env setup. Full precedence lives in
 * coordination/fabric-config.ts (explicit > .klaurorc > FAB_REMOTE_URL/FAB_WS
 * env escape hatch for CI > local default). Server `seq`/`server_time` are
 * authoritative. Network failure NEVER crashes a command: it warns loudly and
 * degrades to the LOCAL fabric (same-machine peers only) so the advisory
 * system keeps working. No config + no env = byte-for-byte the original
 * local behavior.
 */
import { spawnSync } from 'node:child_process';

import {
  appendClaim,
  getActiveClaims,
  announceEdit,
  checkEditLock, // used by `check` and (belt-and-suspenders) the pre-claim overlap scan
  releaseAgent,
  findAgentInOtherWorkspaces,
  getStoreDir,
  planScopedGitOp, // W6 — scope diff/stash to the caller's own claim paths
  warnIfTreeGlobalOp, // W6 — awareness print before a tree-global git op
  extendClaim, // W7 — mid-task claim-scope extension
} from '../src/coordination/local-store';
import {
  remoteActive,
  remoteCheck,
  remoteClaim,
  remoteRelease,
  RemoteFabricError,
  REMOTE_ADVISORY_DEFAULT_TTL_MS,
} from '../src/coordination/remote-transport';
import { resolveFabricSettings, findFabricProjectRoot } from '../src/coordination/fabric-config';
import { startWriteHook } from '../src/coordination/write-hook';
import { startInFlightWatcher } from '../src/coordination/in-flight-sync';
import { buildWorkingTreeChangeContext } from '../src/remote-source';
import type { InFlightDiffFile } from '../src/coordination/security';

function csv(s: string | undefined): string[] {
  return (s || '').split(',').map((x) => x.trim()).filter(Boolean);
}

/**
 * Advisory-system degrade contract: a remote failure must never crash the
 * caller — warn LOUDLY (so the agent knows cross-machine awareness is
 * currently blind) and fall back to the local fabric so same-machine
 * coordination keeps working.
 */
function warnRemoteDegrade(op: string, err: unknown): void {
  const msg = err instanceof RemoteFabricError ? err.message : String(err);
  console.error(
    `WARNING: remote fabric ${op} failed (${msg}). Degrading to LOCAL fabric — ` +
      `same-machine peers only; agents on OTHER machines can NOT see this. ` +
      `Run \`klauro fabric status\` to inspect the endpoint/credentials and re-run once the service is reachable.`
  );
}

async function main() {
  const [cmd, agentId, a3, a4] = process.argv.slice(2);
  // Config-driven transport (coordination/fabric-config.ts): `klauro fabric
  // on` in this repo makes every command remote; the FAB_* env vars remain a
  // low-priority CI escape hatch. Workspace never defaults to cwd basename
  // (the old wrong-workspace papercut) — explicit > .klaurorc > FAB_WS > 'poc'.
  const settings = await resolveFabricSettings({ cwd: process.cwd() });
  const WS = settings.workspace;
  const REMOTE = settings.remote;
  // Remote claims default to the WAN TTL (30min; heartbeat = re-claim). Local
  // claims keep the original 6h. FAB_TTL_MS overrides either.
  const TTL_MS = process.env.FAB_TTL_MS
    ? Number(process.env.FAB_TTL_MS)
    : REMOTE
      ? REMOTE_ADVISORY_DEFAULT_TTL_MS
      : 6 * 60 * 60 * 1000;
  switch (cmd) {
    case 'active': {
      if (REMOTE) {
        try {
          const res = await remoteActive(REMOTE, WS);
          if (!res.active.length) { console.log(`(no active claims) [remote ${REMOTE.baseUrl}]`); break; }
          for (const c of res.active) {
            console.log(`${c.agent_id} [${c.status}] intent="${c.intent}" paths=${JSON.stringify(c.paths)} symbols=${JSON.stringify(c.symbols)} seq=${c.seq}`);
          }
          console.log(`[remote ${REMOTE.baseUrl} max_seq=${res.max_seq} server_time=${res.server_time}]`);
          break;
        } catch (err) {
          warnRemoteDegrade('active', err);
        }
      }
      const active = await getActiveClaims(WS);
      if (!active.length) { console.log('(no active claims)'); break; }
      for (const c of active) {
        console.log(`${c.agent_id} [${c.status}] intent="${c.intent}" paths=${JSON.stringify(c.scope.paths)} symbols=${JSON.stringify(c.scope.symbols)}`);
      }
      break;
    }
    case 'claim': {
      // claim <agentId> <intent> <comma,paths> [comma,symbols]
      const intent = a3 || 'work';
      const paths = csv(a4);
      const symbols = csv(process.argv[6]);
      if (REMOTE) {
        try {
          const res = await remoteClaim(REMOTE, { workspace: WS, agentId, intent, paths, symbols, ttlMs: TTL_MS });
          if (res.warning) {
            console.error(`WARNING: ${res.warning}`);
            for (const c of res.conflicts) console.error(`  ${c.agent_id} overlaps ${JSON.stringify(c.overlapping_paths)}`);
          }
          console.log(
            `claimed seq=${res.seq} ${agentId} intent="${intent}" -> ${JSON.stringify(paths)} ` +
              `[remote ${REMOTE.baseUrl} ttl=${Math.round(res.ttl_ms / 60000)}m server_time=${res.server_time}]`
          );
          console.log(`(heartbeat: re-run this claim before the TTL elapses; release when done)`);
          break;
        } catch (err) {
          warnRemoteDegrade('claim', err);
        }
      }
      // Belt-and-suspenders (papercut fix): run the SAME overlap scan `check`
      // does BEFORE claiming, and warn inline when the paths are already
      // claimed by another agent. Advisory — the claim still succeeds — but an
      // agent that skipped `check` still gets the collision signal.
      const preConflicts = paths.length ? await checkEditLock(WS, paths, agentId) : [];
      if (preConflicts.length) {
        console.error(`WARNING: ${preConflicts.length} other agent(s) already claim overlapping paths (claim still succeeds — coordinate before writing):`);
        for (const c of preConflicts) console.error(`  ${c.agent_id} overlaps ${JSON.stringify(c.overlapping_paths)}`);
      }
      const now = new Date().toISOString();
      const entry = await appendClaim(WS, {
        claim_id: `${WS}:${agentId}`,
        workspace_id: WS,
        agent_id: agentId,
        agent_kind: 'claude',
        scope: { repo: WS, paths, symbols },
        intent,
        status: 'active',
        created_at: now,
        ttl_ms: TTL_MS,
        heartbeat_at: now,
      });
      console.log(`claimed seq=${entry.seq} ${agentId} intent="${intent}" -> ${JSON.stringify(entry.scope.paths)}`);
      break;
    }
    case 'announce': {
      if (REMOTE) {
        try {
          // Same edit-lock claim_id scheme local announceEdit uses, so a
          // re-announce LWW-supersedes rather than duplicating.
          const res = await remoteClaim(REMOTE, {
            workspace: WS,
            agentId,
            intent: 'edit-lock',
            paths: csv(a3),
            ttlMs: TTL_MS,
            claimId: `edit-lock:${WS}:${agentId}`,
          });
          console.log(`announced edit-lock seq=${res.seq} ${agentId} -> ${JSON.stringify(csv(a3))} [remote ${REMOTE.baseUrl}]`);
          break;
        } catch (err) {
          warnRemoteDegrade('announce', err);
        }
      }
      const entry = await announceEdit(WS, agentId, csv(a3), { agentKind: 'claude', intent: 'edit-lock' });
      console.log(`announced edit-lock seq=${entry.seq} ${agentId} -> ${JSON.stringify(entry.scope.paths)}`);
      break;
    }
    case 'check': {
      if (REMOTE) {
        try {
          const res = await remoteCheck(REMOTE, { workspace: WS, agentId, paths: csv(a3) });
          if (res.ok) { console.log(`OK: no conflicting active claims on those paths [remote ${REMOTE.baseUrl}]`); break; }
          console.log(`CONFLICT: ${res.conflicts.length} other agent(s) claim overlapping paths [remote ${REMOTE.baseUrl}]:`);
          for (const c of res.conflicts) console.log(`  ${c.agent_id} overlaps ${JSON.stringify(c.overlapping_paths)}`);
          break;
        } catch (err) {
          warnRemoteDegrade('check', err);
        }
      }
      const conflicts = await checkEditLock(WS, csv(a3), agentId);
      if (!conflicts.length) { console.log('OK: no conflicting active claims on those paths'); break; }
      console.log(`CONFLICT: ${conflicts.length} other agent(s) claim overlapping paths:`);
      for (const c of conflicts) console.log(`  ${c.agent_id} overlaps ${JSON.stringify(c.overlapping_paths)}`);
      break;
    }
    case 'release': {
      if (REMOTE) {
        try {
          const res = await remoteRelease(REMOTE, { workspace: WS, agentId });
          console.log(
            `released ${agentId} (${res.released_count} claim${res.released_count === 1 ? '' : 's'}) workspace="${WS}" [remote ${REMOTE.baseUrl}]`
          );
          break;
        } catch (err) {
          warnRemoteDegrade('release', err);
        }
      }
      const rel = await releaseAgent(WS, agentId);
      console.log(`released ${agentId} (${rel.length} claim${rel.length === 1 ? '' : 's'}) workspace="${WS}" dir=${getStoreDir(WS)}`);
      if (rel.length === 0) {
        // 0-released is ambiguous: "nothing left to release" (fine) vs. "you
        // targeted the wrong FAB_WS/KLAURO_COORD_DIR and your real claim is
        // still active elsewhere" (silent failure — the bug this CLI must
        // never let recur). Actively check sibling workspaces and surface it
        // instead of letting the caller believe release succeeded.
        const elsewhere = await findAgentInOtherWorkspaces(agentId, WS);
        if (elsewhere.length > 0) {
          console.error(
            `WARNING: no active claim for "${agentId}" under workspace "${WS}", but it IS active under: ${elsewhere.join(', ')}. ` +
              `You likely have the wrong workspace configured (.klaurorc fabric.workspace / FAB_WS / KLAURO_COORD_DIR) — ` +
              `check \`klauro fabric status\` or re-run with FAB_WS=<one of the above>.`
          );
          process.exitCode = 1;
        }
      }
      break;
    }
    case 'diff': {
      // fab diff <agentId> — `git diff` LIMITED to agentId's own active claim
      // paths (W6). Never falls back to a whole-tree diff silently: if the
      // agent holds no claim, say so and let the caller decide (awareness,
      // never a guess at scope).
      const plan = await planScopedGitOp(WS, agentId);
      if (plan.paths.length === 0) {
        console.error(
          `No active claim paths for "${agentId}" in workspace "${WS}" — nothing to scope \`git diff\` to. ` +
            `Claim paths first (\`fab claim\`), or run \`git diff\` directly if you want the whole tree.`
        );
        process.exitCode = 1;
        break;
      }
      const root = findFabricProjectRoot(process.cwd())?.root ?? process.cwd();
      const res = spawnSync('git', ['diff', '--', ...plan.paths], { cwd: root, encoding: 'utf8' });
      process.stdout.write(res.stdout || '');
      if (res.stderr) process.stderr.write(res.stderr);
      process.exitCode = res.status ?? 0;
      break;
    }
    case 'stash': {
      // fab stash <agentId> — `git stash push` LIMITED to agentId's own active
      // claim paths (W6). REFUSES only the one dangerous case: no claim paths
      // to scope to AND other agents are active — the exact whole-tree-fallback
      // that swept a peer's uncommitted work in the incident this exists to
      // answer. Otherwise the stash is already scoped by construction, so it
      // cannot touch anyone else's files regardless of who else is active.
      const plan = await planScopedGitOp(WS, agentId);
      if (plan.paths.length === 0) {
        if (plan.peers.length > 0) {
          console.error(
            `REFUSING: "${agentId}" holds no active claim paths to scope a stash to, and ${plan.peers.length} ` +
              `other agent(s) hold active claims on this tree (${plan.peers
                .map((p) => `${p.agent_id}:${JSON.stringify(p.scope.paths)}`)
                .join(', ')}). A whole-tree \`git stash\` here would sweep up their uncommitted work — this is ` +
              `exactly the incident that nearly clobbered a peer's edits. Claim paths first (\`fab claim\`), or run ` +
              `\`git stash\` yourself if you have already coordinated and are certain this is safe.`
          );
          process.exitCode = 1;
          break;
        }
        console.error(
          `No active claim paths for "${agentId}" and no other agents are currently active — nothing to scope. ` +
            `Run \`git stash\` directly if you intend a whole-tree stash.`
        );
        process.exitCode = 1;
        break;
      }
      // Still print the awareness warning even for a SCOPED stash — peers may
      // be active elsewhere in the tree and benefit from knowing a stash just
      // happened, even though this one cannot touch their paths.
      await warnIfTreeGlobalOp(WS, agentId);
      const root = findFabricProjectRoot(process.cwd())?.root ?? process.cwd();
      const res = spawnSync('git', ['stash', 'push', '--', ...plan.paths], { cwd: root, encoding: 'utf8' });
      console.log(res.stdout?.trim() || `stashed ${plan.paths.length} claimed path(s) for ${agentId}: ${JSON.stringify(plan.paths)}`);
      if (res.stderr) process.stderr.write(res.stderr);
      process.exitCode = res.status ?? 0;
      break;
    }
    case 'extend': {
      // extend <agentId> <comma,addPaths> [comma,addSymbols] — W7 mid-task
      // claim-scope extension. Targets the same claim_id `claim` uses
      // (`<workspace>:<agentId>`); LOCAL-ONLY today (see module header).
      const claimId = `${WS}:${agentId}`;
      const addPaths = csv(a3);
      const addSymbols = csv(a4);
      if (REMOTE) {
        console.error(
          `NOTE: \`extend\` is LOCAL-ONLY for now — this workspace has a remote fabric configured, but the ` +
            `extension below only lands in the LOCAL claim log. Peers on OTHER machines will not see this scope ` +
            `growth until the remote mirror is wired (see the W6/W7 build report's proposed server.ts diff).`
        );
      }
      try {
        const outcome = await extendClaim(WS, claimId, addPaths, addSymbols);
        console.log(
          `extended seq=${outcome.claim.seq} ${agentId} -> paths=${JSON.stringify(outcome.claim.scope.paths)} ` +
            `symbols=${JSON.stringify(outcome.claim.scope.symbols)}`
        );
        if (outcome.conflicts.length) {
          console.error(
            `WARNING: ${outcome.conflicts.length} other agent(s) already claim overlapping paths in the ADDED ` +
              `scope (extend still succeeded — coordinate before writing):`
          );
          for (const c of outcome.conflicts) console.error(`  ${c.agent_id} overlaps ${JSON.stringify(c.overlapping_paths)}`);
        }
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      }
      break;
    }
    case 'watch': {
      // fab.ts watch [agentId] — the human-in-a-terminal counterpart to the
      // MCP-server lifecycle activation in server.ts's `advisoryFabricSettings`
      // (W5, SPEC-COORDINATION-FABRIC-V3 §8): a foreground process that keeps
      // the write-hook running for as long as the terminal is open, printing
      // announced/unclaimed events as they happen. Unlike the MCP-server path,
      // this is opt-in by construction (a human runs it) so it does NOT gate
      // on `shouldActivateWriteHook`/fabric.enabled — running `fab watch` IS
      // the opt-in.
      const root = findFabricProjectRoot(process.cwd())?.root ?? process.cwd();
      console.log(
        `fab watch: observing ${root} for workspace "${WS}" ` +
          `[${REMOTE ? `remote ${REMOTE.baseUrl}` : 'local only'}] — Ctrl-C to stop`
      );
      const hookHandle = startWriteHook(root, WS, {
        onAnnounce: (e) => console.log(`[announce] ${e.agentId} <- ${e.path} (claim ${e.claimId})`),
        onUnclaimedEdit: (e) => console.log(`[unclaimed] ${e.path}`),
        onError: (err) => console.error(`[write-hook error] ${err instanceof Error ? err.message : String(err)}`),
      });
      // Cross-machine in-flight publishing (WS-B) only makes sense when a
      // remote fabric is actually configured — with no remote there is
      // nowhere to publish to, so `fab watch` stays local-only (write-hook)
      // exactly like every other command in this file.
      let inFlightHandle: { stop: () => void } | undefined;
      if (REMOTE) {
        inFlightHandle = startInFlightWatcher(
          root,
          REMOTE.baseUrl,
          REMOTE.token,
          WS,
          agentId || 'fab-watch',
          async (): Promise<InFlightDiffFile[]> => {
            try {
              const ctx = await buildWorkingTreeChangeContext(root);
              return ctx.changed_files
                .filter((f): f is typeof ctx.changed_files[number] & { status: 'added' | 'modified'; content: string } =>
                  f.status !== 'deleted'
                )
                .map((f) => ({ path: f.path, content: f.content }));
            } catch {
              // Best-effort: e.g. .klaurorc upload.allowDirtyTreeSync=false,
              // or not a git repo. Publish nothing rather than crash the watch loop.
              return [];
            }
          },
          {
            onPublished: (r) => console.log(`[in-flight] published ${r.kept_files} file(s), ${r.dropped_files} dropped`),
            onError: (err) => console.error(`[in-flight error] ${err instanceof Error ? err.message : String(err)}`),
          }
        );
      }
      await new Promise<void>((resolve) => {
        const stop = () => {
          hookHandle.close();
          inFlightHandle?.stop();
          console.log('\nfab watch: stopped.');
          resolve();
        };
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
      });
      break;
    }
    default:
      console.error('usage: fab.ts active|claim|announce|check|release|watch|diff|stash|extend ...');
      process.exit(1);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
