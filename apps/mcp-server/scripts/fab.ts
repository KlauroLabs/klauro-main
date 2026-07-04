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
 */
import {
  appendClaim,
  getActiveClaims,
  announceEdit,
  checkEditLock,
  releaseAgent,
  findAgentInOtherWorkspaces,
  getStoreDir,
} from '../src/coordination/local-store';

const WS = process.env.FAB_WS || 'deployable-detection-build';

function csv(s: string | undefined): string[] {
  return (s || '').split(',').map((x) => x.trim()).filter(Boolean);
}

async function main() {
  const [cmd, agentId, a3, a4] = process.argv.slice(2);
  switch (cmd) {
    case 'active': {
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
        ttl_ms: 6 * 60 * 60 * 1000,
        heartbeat_at: now,
      });
      console.log(`claimed seq=${entry.seq} ${agentId} intent="${intent}" -> ${JSON.stringify(entry.scope.paths)}`);
      break;
    }
    case 'announce': {
      const entry = await announceEdit(WS, agentId, csv(a3), { agentKind: 'claude', intent: 'edit-lock' });
      console.log(`announced edit-lock seq=${entry.seq} ${agentId} -> ${JSON.stringify(entry.scope.paths)}`);
      break;
    }
    case 'check': {
      const conflicts = await checkEditLock(WS, csv(a3), agentId);
      if (!conflicts.length) { console.log('OK: no conflicting active claims on those paths'); break; }
      console.log(`CONFLICT: ${conflicts.length} other agent(s) claim overlapping paths:`);
      for (const c of conflicts) console.log(`  ${c.agent_id} overlaps ${JSON.stringify(c.overlapping_paths)}`);
      break;
    }
    case 'release': {
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
              `You likely have the wrong FAB_WS (or KLAURO_COORD_DIR) set — re-run with FAB_WS=<one of the above>.`
          );
          process.exitCode = 1;
        }
      }
      break;
    }
    default:
      console.error('usage: fab.ts active|claim|announce|check|release ...');
      process.exit(1);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
