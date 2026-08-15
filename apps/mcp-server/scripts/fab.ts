


































import { spawnSync } from 'node:child_process';

import {
  appendClaim,
  getActiveClaims,
  announceEdit,
  checkEditLock,
  releaseAgent,
  findAgentInOtherWorkspaces,
  getStoreDir,
  planScopedGitOp,
  warnIfTreeGlobalOp,
  extendClaim,
} from '../src/coordination/local-store';
import {
  remoteActive,
  remoteCheck,
  remoteClaim,
  remoteExtend,
  remoteRelease,
  RemoteFabricError,
  REMOTE_ADVISORY_DEFAULT_TTL_MS,
} from '../src/coordination/remote-transport';
import { resolveFabricSettings, findFabricProjectRoot } from '../src/coordination/fabric-config';
import { startWriteHook } from '../src/coordination/write-hook';
import { startInFlightWatcher } from '../src/coordination/in-flight-sync';
import { captureInFlightChanges } from '../src/coordination/in-flight-capture';
import { buildWorkingTreeChangeContext } from '../src/remote-source';
import type { InFlightDiffFile } from '../src/coordination/security';

function csv(s: string | undefined): string[] {
  return (s || '').split(',').map((x) => x.trim()).filter(Boolean);
}







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




  const settings = await resolveFabricSettings({ cwd: process.cwd() });
  const WS = settings.workspace;
  const REMOTE = settings.remote;


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
          for (const snapshot of res.in_flight ?? []) {
            console.log(`${snapshot.agent_id} [in-flight:${snapshot.attribution_source}] changes=${snapshot.changes_count} updated=${snapshot.updated_at}`);
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



      await warnIfTreeGlobalOp(WS, agentId);
      const root = findFabricProjectRoot(process.cwd())?.root ?? process.cwd();
      const res = spawnSync('git', ['stash', 'push', '--', ...plan.paths], { cwd: root, encoding: 'utf8' });
      console.log(res.stdout?.trim() || `stashed ${plan.paths.length} claimed path(s) for ${agentId}: ${JSON.stringify(plan.paths)}`);
      if (res.stderr) process.stderr.write(res.stderr);
      process.exitCode = res.status ?? 0;
      break;
    }
    case 'extend': {



      const claimId = `${WS}:${agentId}`;
      const addPaths = csv(a3);
      const addSymbols = csv(a4);
      if (REMOTE) {
        try {
          const outcome = await remoteExtend(REMOTE, { workspace: WS, claimId, addPaths, addSymbols });
          console.log(
            `extended seq=${outcome.seq} ${agentId} -> paths=${JSON.stringify(outcome.paths)} ` +
              `symbols=${JSON.stringify(outcome.symbols)} [remote ${REMOTE.baseUrl}]`
          );
          if (outcome.conflicts.length) {
            console.error(`WARNING: ${outcome.conflicts.length} other agent(s) already claim overlapping paths in the added scope:`);
            for (const conflict of outcome.conflicts) console.error(`  ${conflict.agent_id} overlaps ${JSON.stringify(conflict.overlapping_paths)}`);
          }
          break;
        } catch (err) {
          warnRemoteDegrade('extend', err);
        }
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








      const root = findFabricProjectRoot(process.cwd())?.root ?? process.cwd();
      console.log(
        `fab watch: observing ${root} for workspace "${WS}" ` +
          `[${REMOTE ? `remote ${REMOTE.baseUrl}` : 'local only'}] — Ctrl-C to stop`
      );
      const hookHandle = startWriteHook(root, WS, {
        onAnnounce: (e) => console.log(`[announce] ${e.agentId} <- ${e.path} (claim ${e.claimId})`),
        onUnclaimedEdit: (e) => console.log(`[unclaimed] ${e.path}`),
        onAmbiguousEdit: (e) => console.log(`[ambiguous] ${e.path} candidates=${e.candidateAgentIds.join(',')}`),
        onError: (err) => console.error(`[write-hook error] ${err instanceof Error ? err.message : String(err)}`),
      });




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


              return [];
            }
          },
          {
            attributionSource: process.argv.includes('--participant-worktree') ? 'participant-worktree' : 'workspace-tree',
            onPublished: (r) => console.log(`[in-flight] published ${r.kept_files} file(s), ${r.dropped_files} dropped`),
            onError: (err) => console.error(`[in-flight error] ${err instanceof Error ? err.message : String(err)}`),
          },
          () => captureInFlightChanges({ repoPath: root, maxFiles: 200 })
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
      console.error('usage: fab.ts active|claim|announce|check|release|watch [agentId] [--participant-worktree]|diff|stash|extend ...');
      process.exit(1);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
