/**
 * Coordination fleet demo (§SPEC-COORDINATION-FABRIC.md) — proves the category
 * bet made measurable: with FLEETS of agents on ONE codebase, does the
 * coordination fabric actually catch what no-coordination misses?
 *
 * This drives the REAL pure-core coordination modules (arbiter.ts, collision.ts,
 * presence.ts) and the REAL local file-backed store (local-store.ts) — nothing
 * here reimplements arbitration or collision detection. It runs two arms over
 * the identical fleet scenario:
 *
 *  - COORDINATED arm: every agent claims work through `appendClaim`, each new
 *    claim is arbitrated via `arbitrate()` against the active set before being
 *    treated as granted, `checkEditLock` guards same-machine silent clobbers,
 *    `detectCollisions()` sweeps the full active set + in-flight snapshots for
 *    duplicate work / edit overlap / contract drift / blast-radius intersection,
 *    and `attributeChange` answers "who's touching this path and why".
 *
 *  - UNCOORDINATED baseline arm: the same N agents perform the same actions,
 *    but nothing is claimed, arbitrated, or checked — it simply records what
 *    each agent *would* have done blind, then shows which of those actions
 *    collide with each other with no mechanism that could have caught it
 *    before the fact (the conflict only "surfaces" if you diff the arm against
 *    ground truth after the fact, i.e. at merge time in the real world).
 *
 * Scenario (6 simulated agents, 1 shared workspace, deliberately overlapping
 * intents):
 *   - alpha & beta:   both pick up capability "refactor-auth-flow" (dup work)
 *   - gamma & zeta:   both touch overlapping paths under src/routes/checkout
 *                     (path-overlap conflict)
 *   - delta:          edits src/lib/shared-utils.ts (a shared lib) with symbol
 *                     `formatCurrency`; epsilon's claim's blast radius (via a
 *                     CAS call-edge) reaches into that same symbol (blast-radius
 *                     conflict) even though their claimed paths/symbols don't
 *                     literally intersect
 *   - epsilon:        has an in-flight (uncommitted) snapshot touching the
 *                     `CheckoutResponse` contract, which gamma's active claim
 *                     scope also covers (drift finding)
 */

import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  appendClaim,
  checkEditLock,
  attributeChange,
  getActiveClaims,
  type EditLockConflict,
} from '../coordination/local-store';
import { arbitrate } from '../coordination/arbiter';
import { detectCollisions } from '../coordination/collision';
import type {
  ArbitrationResult,
  CasEdgeRef,
  CollisionReport,
  InFlightSnapshot,
  WasCapabilityRef,
  WorkClaim,
} from '../coordination/types';

export interface FleetAgentIntent {
  agent_id: string;
  agent_kind: WorkClaim['agent_kind'];
  claim_id: string;
  paths: string[];
  symbols: string[];
  capability?: string;
  intent: string;
}

/** The 6-agent fleet scenario with deliberately overlapping intents. */
export function buildFleetScenario(workspaceId: string): FleetAgentIntent[] {
  return [
    {
      agent_id: 'agent-alpha',
      agent_kind: 'claude',
      claim_id: 'claim-alpha-1',
      paths: ['src/auth/flow.ts'],
      symbols: ['loginHandler'],
      capability: 'refactor-auth-flow',
      intent: 'Refactor the auth login flow for MFA support',
    },
    {
      agent_id: 'agent-beta',
      agent_kind: 'cursor',
      claim_id: 'claim-beta-1',
      // Different file, SAME capability as alpha -> duplicate work, undetectable
      // by path/symbol overlap alone; only capability-name matching catches it.
      paths: ['src/auth/session.ts'],
      symbols: ['refreshSession'],
      capability: 'refactor-auth-flow',
      intent: 'Refactor the auth login flow session handling for MFA support',
    },
    {
      agent_id: 'agent-gamma',
      agent_kind: 'codex',
      claim_id: 'claim-gamma-1',
      paths: ['src/routes/checkout.ts'],
      symbols: ['checkoutHandler', 'CheckoutResponse'],
      intent: 'Add discount-code support to the checkout route',
    },
    {
      agent_id: 'agent-zeta',
      agent_kind: 'human',
      claim_id: 'claim-zeta-1',
      // Nested path under gamma's claimed file -> path-prefix overlap conflict.
      paths: ['src/routes/checkout.ts/handler'],
      symbols: ['checkoutHandler'],
      intent: 'Fix a checkout handler validation bug',
    },
    {
      agent_id: 'agent-delta',
      agent_kind: 'claude',
      claim_id: 'claim-delta-1',
      paths: ['src/lib/shared-utils.ts'],
      symbols: ['formatCurrency'],
      intent: 'Fix rounding bug in the shared currency formatter',
    },
    {
      agent_id: 'agent-epsilon',
      agent_kind: 'other',
      claim_id: 'claim-epsilon-1',
      // Doesn't touch formatCurrency directly, but calls a function that does
      // (see casEdges below) -> blast-radius conflict with delta.
      paths: ['src/routes/pricing.ts'],
      symbols: ['pricingHandler'],
      intent: 'Add bulk-pricing tiers to the pricing route',
    },
  ];
}

/** CAS call-edges: pricingHandler calls formatCurrency (one-hop blast radius). */
export function buildCasEdges(): CasEdgeRef[] {
  return [
    {
      id: 'edge-1',
      source: 'pricingHandler',
      target: 'formatCurrency',
      type: 'calls',
    },
  ];
}

export function buildWasCapabilities(): WasCapabilityRef[] {
  return [{ id: 'was-cap-1', name: 'refactor-auth-flow', project_ids: ['proof-of-concept'] }];
}

/** Epsilon's uncommitted working tree touches the CheckoutResponse contract
 *  that gamma's active claim also covers -> drift finding. */
export function buildInFlightSnapshots(workspaceId: string): InFlightSnapshot[] {
  return [
    {
      workspace: workspaceId,
      agent_id: 'agent-epsilon',
      base_commit: 'deadbeef',
      diff_context: 'pricingHandler now returns a shape compatible with CheckoutResponse',
      touched: {
        entities: [],
        routes: [],
        contracts: ['CheckoutResponse'],
        symbols: ['pricingHandler'],
      },
      updated_at: new Date().toISOString(),
    },
  ];
}

export interface CoordinatedArmResult {
  arbitrations: Array<{ agent_id: string; claim_id: string; result: ArbitrationResult }>;
  dupWorkPrevented: number;
  pathConflictsDenied: number;
  editLockConflicts: Array<{ agent_id: string; conflicts: EditLockConflict[] }>;
  collisionReport: CollisionReport;
  inFlightVisibility: Array<{ path: string; visible_to: string[] }>;
  attributions: Array<{ path: string; agent_ids: string[] }>;
}

/**
 * Coordinated arm: every agent's intent goes through appendClaim -> arbitrate
 * -> checkEditLock, in order, against the REAL local file-backed store so each
 * later agent sees every earlier agent's claims exactly as separate agent
 * processes would on one machine. Finishes with a detectCollisions() sweep
 * across the full active set (this doubles as a safety net catching anything
 * per-claim arbitration let through, e.g. blast-radius, which arbitrate() DOES
 * check but only against literal scope, not full transitive collision-report
 * cross tabulation).
 */
export async function runCoordinatedArm(
  workspaceId: string,
  fleet: FleetAgentIntent[],
  casEdges: CasEdgeRef[],
  wasCapabilities: WasCapabilityRef[],
  inFlightSnapshots: InFlightSnapshot[]
): Promise<CoordinatedArmResult> {
  const arbitrations: CoordinatedArmResult['arbitrations'] = [];
  const editLockConflicts: CoordinatedArmResult['editLockConflicts'] = [];
  let dupWorkPrevented = 0;
  let pathConflictsDenied = 0;

  for (const agent of fleet) {
    // 1. Edit-lock check BEFORE claiming — same-machine silent-clobber guard.
    const lockConflicts = await checkEditLock(workspaceId, agent.paths, agent.agent_id);
    if (lockConflicts.length > 0) {
      editLockConflicts.push({ agent_id: agent.agent_id, conflicts: lockConflicts });
    }

    // 2. Arbitrate the proposed claim against whatever is active so far.
    const activeSoFar = await getActiveClaims(workspaceId);
    const now = new Date().toISOString();
    const proposedClaim: WorkClaim = {
      claim_id: agent.claim_id,
      seq: 0, // placeholder; store assigns the real monotonic seq on append
      workspace_id: workspaceId,
      agent_id: agent.agent_id,
      agent_kind: agent.agent_kind,
      scope: { repo: workspaceId, paths: agent.paths, symbols: agent.symbols, capability: agent.capability },
      intent: agent.intent,
      status: 'active',
      created_at: now,
      ttl_ms: 5 * 60 * 1000,
      heartbeat_at: now,
    };
    const verdict = arbitrate(proposedClaim, activeSoFar, casEdges, wasCapabilities);
    arbitrations.push({ agent_id: agent.agent_id, claim_id: agent.claim_id, result: verdict });

    if (verdict.verdict === 'duplicate') dupWorkPrevented++;
    if (verdict.verdict === 'conflict' && verdict.kind === 'path') pathConflictsDenied++;

    // Whether granted or flagged, still append so the claim log reflects what
    // was ATTEMPTED (arbitration denies/flags — it does not silently drop the
    // record — matching the spec's "surface, don't hide" posture). Every
    // subsequent agent's arbitration/collision check sees this claim.
    await appendClaim(workspaceId, {
      claim_id: proposedClaim.claim_id,
      workspace_id: proposedClaim.workspace_id,
      agent_id: proposedClaim.agent_id,
      agent_kind: proposedClaim.agent_kind,
      scope: proposedClaim.scope,
      intent: proposedClaim.intent,
      status: 'active',
      created_at: proposedClaim.created_at,
      ttl_ms: proposedClaim.ttl_ms,
      heartbeat_at: proposedClaim.heartbeat_at,
    });
  }

  // 3. Full-set collision sweep, including in-flight (uncommitted) snapshots —
  // this is where drift (epsilon's in-flight vs gamma's claim) and blast-radius
  // (delta vs epsilon via the CAS edge) get caught even when they weren't the
  // *first* conflict a given agent's per-claim arbitration hit.
  const finalActive = await getActiveClaims(workspaceId);
  const collisionReport = detectCollisions(finalActive, inFlightSnapshots, casEdges, wasCapabilities);

  // 4. In-flight visibility: does agent B (gamma) actually see agent A's
  // (epsilon's) uncommitted claim/contract touch? We answer this directly off
  // the drift findings — if gamma's claim_id appears as `with_agent_id` for a
  // drift keyed off epsilon's snapshot, gamma's tooling would have surfaced it.
  const inFlightVisibility: CoordinatedArmResult['inFlightVisibility'] = [];
  for (const snapshot of inFlightSnapshots) {
    const visibleTo = collisionReport.drifts
      .filter((d) => d.agent_id === snapshot.agent_id)
      .map((d) => d.with_agent_id);
    inFlightVisibility.push({
      path: snapshot.touched.contracts.join(','),
      visible_to: [...new Set(visibleTo)],
    });
  }

  // 5. Attribution: for every claimed path, who's on it and why.
  const attributions: CoordinatedArmResult['attributions'] = [];
  const allPaths = [...new Set(fleet.flatMap((a) => a.paths))];
  for (const p of allPaths) {
    const attribution = await attributeChange(workspaceId, p);
    attributions.push({ path: p, agent_ids: attribution.attributions.map((a) => a.agent_id) });
  }

  return {
    arbitrations,
    dupWorkPrevented,
    pathConflictsDenied,
    editLockConflicts,
    collisionReport,
    inFlightVisibility,
    attributions,
  };
}

export interface UncoordinatedArmResult {
  actionsTaken: Array<{ agent_id: string; claim_id: string; paths: string[]; symbols: string[]; capability?: string }>;
  /** Conflicts that exist in ground truth but were NEVER surfaced to any agent before acting (no claim log, no arbitration, no lock check) — these only get found by an after-the-fact audit (i.e. at merge time), which is what this field represents: a diagnostic run after the fact, not a live signal any agent had. */
  wouldHaveCollided: CollisionReport;
  /** In-flight visibility: because nothing is announced, no agent can see any other agent's uncommitted work while acting — always empty/0 by construction. */
  inFlightVisibility: number;
  /** Dup-work instances actually committed (both agents did real, separate work on the same capability) because nothing warned either of them beforehand. */
  dupWorkCommitted: number;
}

/**
 * Uncoordinated baseline: same fleet, same intents, but agents never call
 * appendClaim/arbitrate/checkEditLock — they just act. We still capture what
 * "acting" would have produced as plain data (no store writes at all, by
 * design: there IS no coordination store in this arm) and then, as a
 * post-hoc-only diagnostic (standing in for "what a human discovers at merge
 * time"), run detectCollisions() over that same data to show the conflicts
 * that existed the whole time but that no agent had any way to see while
 * working.
 */
export function runUncoordinatedArm(
  workspaceId: string,
  fleet: FleetAgentIntent[],
  casEdges: CasEdgeRef[],
  wasCapabilities: WasCapabilityRef[],
  inFlightSnapshots: InFlightSnapshot[]
): UncoordinatedArmResult {
  const actionsTaken = fleet.map((agent) => ({
    agent_id: agent.agent_id,
    claim_id: agent.claim_id,
    paths: agent.paths,
    symbols: agent.symbols,
    capability: agent.capability,
  }));

  const now = new Date().toISOString();
  const asClaims: WorkClaim[] = fleet.map((agent) => ({
    claim_id: agent.claim_id,
    seq: 0,
    workspace_id: workspaceId,
    agent_id: agent.agent_id,
    agent_kind: agent.agent_kind,
    scope: { repo: workspaceId, paths: agent.paths, symbols: agent.symbols, capability: agent.capability },
    intent: agent.intent,
    status: 'active',
    created_at: now,
    ttl_ms: 5 * 60 * 1000,
    heartbeat_at: now,
  }));

  // Post-hoc-only: nobody ran this while acting. Standing in for a merge-time
  // discovery, not a live warning.
  const wouldHaveCollided = detectCollisions(asClaims, inFlightSnapshots, casEdges, wasCapabilities);

  const dupWorkCommitted = wouldHaveCollided.duplicates.length;

  return {
    actionsTaken,
    wouldHaveCollided,
    inFlightVisibility: 0, // by construction: no announcement mechanism exists in this arm
    dupWorkCommitted,
  };
}

export interface FleetDemoReport {
  workspaceId: string;
  fleetSize: number;
  coordinated: CoordinatedArmResult;
  uncoordinated: UncoordinatedArmResult;
}

/**
 * Run both arms over the same scenario in a fresh throwaway workspace id
 * (caller is responsible for pointing KLAURO_COORD_DIR at a temp dir so this
 * never touches a real ~/.klauro store).
 */
export async function runFleetDemo(workspaceId: string): Promise<FleetDemoReport> {
  const fleet = buildFleetScenario(workspaceId);
  const casEdges = buildCasEdges();
  const wasCapabilities = buildWasCapabilities();
  const inFlightSnapshots = buildInFlightSnapshots(workspaceId);

  const coordinated = await runCoordinatedArm(workspaceId, fleet, casEdges, wasCapabilities, inFlightSnapshots);
  const uncoordinated = runUncoordinatedArm(workspaceId, fleet, casEdges, wasCapabilities, inFlightSnapshots);

  return { workspaceId, fleetSize: fleet.length, coordinated, uncoordinated };
}

/** Create an isolated throwaway coordination dir under the OS temp dir and
 *  point KLAURO_COORD_DIR at it. Returns a cleanup function. Never touches
 *  the real ~/.klauro store. */
export async function withIsolatedCoordDir<T>(fn: () => Promise<T>): Promise<T> {
  const prior = process.env.KLAURO_COORD_DIR;
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'klauro-fleet-demo-'));
  process.env.KLAURO_COORD_DIR = dir;
  try {
    return await fn();
  } finally {
    if (prior === undefined) delete process.env.KLAURO_COORD_DIR;
    else process.env.KLAURO_COORD_DIR = prior;
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

/** CLI entry point: `tsx src/gauntlet/coordination-fleet-demo.ts` — prints a
 *  human-readable report of the two-arm comparison. */
async function main() {
  await withIsolatedCoordDir(async () => {
    const workspaceId = `fleet-demo-${Date.now()}`;
    const report = await runFleetDemo(workspaceId);

    console.log('=== Coordination Fleet Demo ===');
    console.log(`Workspace: ${report.workspaceId} | Fleet size: ${report.fleetSize}\n`);

    console.log('--- COORDINATED ARM ---');
    for (const a of report.coordinated.arbitrations) {
      console.log(`  ${a.agent_id} (${a.claim_id}) -> ${a.result.verdict}${a.result.kind ? ` (${a.result.kind})` : ''}`);
    }
    console.log(`  Dup-work claims DENIED: ${report.coordinated.dupWorkPrevented}`);
    console.log(`  Path-conflict claims DENIED: ${report.coordinated.pathConflictsDenied}`);
    console.log(`  Edit-lock conflicts flagged: ${report.coordinated.editLockConflicts.length}`);
    console.log(`  Collision report: duplicates=${report.coordinated.collisionReport.duplicates.length} overlaps=${report.coordinated.collisionReport.overlaps.length} drifts=${report.coordinated.collisionReport.drifts.length} blast_intersections=${report.coordinated.collisionReport.blast_intersections.length}`);
    console.log(`  In-flight visibility:`, report.coordinated.inFlightVisibility);

    console.log('\n--- UNCOORDINATED BASELINE ARM ---');
    console.log(`  Actions taken blind: ${report.uncoordinated.actionsTaken.length}`);
    console.log(`  Dup-work COMMITTED (nobody warned): ${report.uncoordinated.dupWorkCommitted}`);
    console.log(`  In-flight visibility while acting: ${report.uncoordinated.inFlightVisibility}`);
    console.log(`  Conflicts only discoverable post-hoc (merge time): duplicates=${report.uncoordinated.wouldHaveCollided.duplicates.length} overlaps=${report.uncoordinated.wouldHaveCollided.overlaps.length} drifts=${report.uncoordinated.wouldHaveCollided.drifts.length} blast_intersections=${report.uncoordinated.wouldHaveCollided.blast_intersections.length}`);
  });
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
