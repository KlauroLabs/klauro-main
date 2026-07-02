import test from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  buildFleetScenario,
  buildCasEdges,
  buildWasCapabilities,
  buildInFlightSnapshots,
  runCoordinatedArm,
  runUncoordinatedArm,
  runFleetDemo,
  withIsolatedCoordDir,
} from './coordination-fleet-demo';

/** Point KLAURO_COORD_DIR at a fresh temp dir per test so tests don't collide
 *  and never touch the real ~/.klauro store. Mirrors the pattern already used
 *  in coordination/local-store.test.ts. */
async function freshCoordDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'klauro-fleet-demo-test-'));
  const prior = process.env.KLAURO_COORD_DIR;
  process.env.KLAURO_COORD_DIR = dir;
  return {
    dir,
    cleanup: async () => {
      if (prior === undefined) delete process.env.KLAURO_COORD_DIR;
      else process.env.KLAURO_COORD_DIR = prior;
      await fsp.rm(dir, { recursive: true, force: true });
    },
  };
}

test('coordinated arm: fleet scenario builds 6 deliberately-overlapping agent intents', () => {
  const fleet = buildFleetScenario('ws-test');
  assert.equal(fleet.length, 6);
  const ids = fleet.map((a) => a.agent_id);
  assert.deepEqual(
    new Set(ids),
    new Set(['agent-alpha', 'agent-beta', 'agent-gamma', 'agent-zeta', 'agent-delta', 'agent-epsilon'])
  );
});

test('coordinated arm: duplicate capability claim (alpha vs beta) is DENIED by arbitrate()', async (t) => {
  const { cleanup } = await freshCoordDir();
  t.after(cleanup);

  const workspaceId = 'ws-dup-test';
  const fleet = buildFleetScenario(workspaceId);
  const casEdges = buildCasEdges();
  const wasCapabilities = buildWasCapabilities();
  const inFlight = buildInFlightSnapshots(workspaceId);

  const result = await runCoordinatedArm(workspaceId, fleet, casEdges, wasCapabilities, inFlight);

  const betaVerdict = result.arbitrations.find((a) => a.agent_id === 'agent-beta');
  assert.ok(betaVerdict, 'expected an arbitration record for agent-beta');
  assert.equal(betaVerdict!.result.verdict, 'duplicate');
  assert.equal(betaVerdict!.result.kind, 'capability');
  assert.equal(betaVerdict!.result.with_claim?.agent_id, 'agent-alpha');
  assert.equal(result.dupWorkPrevented, 1, 'exactly one duplicate-capability claim should be denied');
});

test('coordinated arm: path-prefix overlap (gamma vs zeta) is DENIED as a conflict', async (t) => {
  const { cleanup } = await freshCoordDir();
  t.after(cleanup);

  const workspaceId = 'ws-path-test';
  const fleet = buildFleetScenario(workspaceId);
  const casEdges = buildCasEdges();
  const wasCapabilities = buildWasCapabilities();
  const inFlight = buildInFlightSnapshots(workspaceId);

  const result = await runCoordinatedArm(workspaceId, fleet, casEdges, wasCapabilities, inFlight);

  const zetaVerdict = result.arbitrations.find((a) => a.agent_id === 'agent-zeta');
  assert.ok(zetaVerdict);
  assert.equal(zetaVerdict!.result.verdict, 'conflict');
  assert.equal(zetaVerdict!.result.kind, 'path');
  assert.equal(zetaVerdict!.result.with_claim?.agent_id, 'agent-gamma');
  assert.equal(result.pathConflictsDenied, 1, 'exactly one path-overlap claim should be denied');
});

test('coordinated arm: blast-radius conflict (delta vs epsilon via CAS edge) is caught by detectCollisions()', async (t) => {
  const { cleanup } = await freshCoordDir();
  t.after(cleanup);

  const workspaceId = 'ws-blast-test';
  const fleet = buildFleetScenario(workspaceId);
  const casEdges = buildCasEdges();
  const wasCapabilities = buildWasCapabilities();
  const inFlight = buildInFlightSnapshots(workspaceId);

  const result = await runCoordinatedArm(workspaceId, fleet, casEdges, wasCapabilities, inFlight);

  const blastFindings = result.collisionReport.blast_intersections;
  const deltaEpsilonPair = blastFindings.filter(
    (f) =>
      (f.claim_id === 'claim-delta-1' && f.with_claim_id === 'claim-epsilon-1') ||
      (f.claim_id === 'claim-epsilon-1' && f.with_claim_id === 'claim-delta-1')
  );
  assert.ok(
    deltaEpsilonPair.length > 0,
    `expected a blast-radius finding between delta and epsilon via the pricingHandler->formatCurrency CAS edge; got ${JSON.stringify(blastFindings)}`
  );
});

test('coordinated arm: in-flight drift (epsilon uncommitted vs gamma claim on CheckoutResponse) is VISIBLE cross-agent', async (t) => {
  const { cleanup } = await freshCoordDir();
  t.after(cleanup);

  const workspaceId = 'ws-drift-test';
  const fleet = buildFleetScenario(workspaceId);
  const casEdges = buildCasEdges();
  const wasCapabilities = buildWasCapabilities();
  const inFlight = buildInFlightSnapshots(workspaceId);

  const result = await runCoordinatedArm(workspaceId, fleet, casEdges, wasCapabilities, inFlight);

  const drifts = result.collisionReport.drifts;
  const epsilonGammaDrift = drifts.find(
    (d) => d.agent_id === 'agent-epsilon' && d.with_agent_id === 'agent-gamma'
  );
  assert.ok(
    epsilonGammaDrift,
    `expected a drift finding: agent-epsilon's in-flight CheckoutResponse touch visible to agent-gamma; got ${JSON.stringify(drifts)}`
  );
  assert.ok(epsilonGammaDrift!.contracts.includes('CheckoutResponse'));

  // In-flight visibility measure: gamma should appear as able to see epsilon's
  // uncommitted change before either commits.
  const visibility = result.inFlightVisibility.find((v) => v.path === 'CheckoutResponse');
  assert.ok(visibility);
  assert.ok(
    visibility!.visible_to.includes('agent-gamma'),
    `expected agent-gamma to be listed as able to see agent-epsilon's in-flight change; got ${JSON.stringify(visibility)}`
  );
});

test('coordinated arm: attribution correctly identifies which agents are on a claimed path', async (t) => {
  const { cleanup } = await freshCoordDir();
  t.after(cleanup);

  const workspaceId = 'ws-attr-test';
  const fleet = buildFleetScenario(workspaceId);
  const casEdges = buildCasEdges();
  const wasCapabilities = buildWasCapabilities();
  const inFlight = buildInFlightSnapshots(workspaceId);

  const result = await runCoordinatedArm(workspaceId, fleet, casEdges, wasCapabilities, inFlight);

  const checkoutAttr = result.attributions.find((a) => a.path === 'src/routes/checkout.ts');
  assert.ok(checkoutAttr);
  assert.ok(checkoutAttr!.agent_ids.includes('agent-gamma'));

  const sharedUtilsAttr = result.attributions.find((a) => a.path === 'src/lib/shared-utils.ts');
  assert.ok(sharedUtilsAttr);
  assert.deepEqual(sharedUtilsAttr!.agent_ids, ['agent-delta']);
});

test('coordinated arm: edit-lock check flags zeta writing into gamma-locked checkout path', async (t) => {
  const { cleanup } = await freshCoordDir();
  t.after(cleanup);

  const workspaceId = 'ws-lock-test';
  const fleet = buildFleetScenario(workspaceId);
  const casEdges = buildCasEdges();
  const wasCapabilities = buildWasCapabilities();
  const inFlight = buildInFlightSnapshots(workspaceId);

  const result = await runCoordinatedArm(workspaceId, fleet, casEdges, wasCapabilities, inFlight);

  const zetaLock = result.editLockConflicts.find((e) => e.agent_id === 'agent-zeta');
  assert.ok(
    zetaLock,
    `expected agent-zeta's edit-lock check to flag a conflict against gamma's already-claimed checkout path; got ${JSON.stringify(result.editLockConflicts)}`
  );
  assert.ok(zetaLock!.conflicts.some((c) => c.agent_id === 'agent-gamma'));
});

test('uncoordinated baseline arm: has ZERO in-flight visibility by construction', () => {
  const workspaceId = 'ws-baseline-test';
  const fleet = buildFleetScenario(workspaceId);
  const casEdges = buildCasEdges();
  const wasCapabilities = buildWasCapabilities();
  const inFlight = buildInFlightSnapshots(workspaceId);

  const result = runUncoordinatedArm(workspaceId, fleet, casEdges, wasCapabilities, inFlight);
  assert.equal(result.inFlightVisibility, 0);
});

test('uncoordinated baseline arm: dup-work and path/blast/drift conflicts ALL land uncaught until a post-hoc audit', () => {
  const workspaceId = 'ws-baseline-2';
  const fleet = buildFleetScenario(workspaceId);
  const casEdges = buildCasEdges();
  const wasCapabilities = buildWasCapabilities();
  const inFlight = buildInFlightSnapshots(workspaceId);

  const result = runUncoordinatedArm(workspaceId, fleet, casEdges, wasCapabilities, inFlight);

  // The same ground-truth conflicts exist (they're the same scenario) but
  // nothing in this arm's live path (actionsTaken) ever surfaced them —
  // wouldHaveCollided is only computable in hindsight/after this test calls it,
  // standing in for a merge-time discovery an agent never got warned about.
  assert.equal(result.dupWorkCommitted, 1);
  assert.ok(result.wouldHaveCollided.overlaps.length >= 1);
  assert.ok(result.wouldHaveCollided.blast_intersections.length >= 1);
  assert.ok(result.wouldHaveCollided.drifts.length >= 1);
});

test('two-arm comparison: coordinated arm catches strictly more (or equal, never less) than what the uncoordinated arm even could catch live', async (t) => {
  const { cleanup } = await freshCoordDir();
  t.after(cleanup);

  const workspaceId = 'ws-compare-test';
  const report = await runFleetDemo(workspaceId);

  // Coordinated arm actively denied real claims before they were recorded as granted.
  assert.equal(report.coordinated.dupWorkPrevented, 1);
  assert.equal(report.coordinated.pathConflictsDenied, 1);

  // Uncoordinated arm has no live denial mechanism at all: every one of the 6
  // actions is unconditionally "taken" regardless of conflicts.
  assert.equal(report.uncoordinated.actionsTaken.length, 6);
  assert.equal(report.uncoordinated.inFlightVisibility, 0);

  // Same ground-truth collisions are present in both post-hoc collision reports
  // (proving this isn't a rigged scenario) but only the coordinated arm had a
  // LIVE mechanism (arbitrate/checkEditLock) that fired during the run itself.
  assert.equal(
    report.coordinated.collisionReport.duplicates.length,
    report.uncoordinated.wouldHaveCollided.duplicates.length
  );
});

test('runFleetDemo cleans up via withIsolatedCoordDir and does not leak into a real coord dir', async () => {
  let capturedDirDuring: string | undefined;
  await withIsolatedCoordDir(async () => {
    capturedDirDuring = process.env.KLAURO_COORD_DIR;
    assert.ok(capturedDirDuring);
    const stat = await fsp.stat(capturedDirDuring!);
    assert.ok(stat.isDirectory());
    await runFleetDemo('ws-cleanup-test');
  });

  // After withIsolatedCoordDir returns, KLAURO_COORD_DIR should be restored
  // (unset here, since we didn't have one set before this test) and the temp
  // dir should be gone.
  assert.equal(process.env.KLAURO_COORD_DIR, undefined);
  await assert.rejects(() => fsp.stat(capturedDirDuring!), /ENOENT/);
});
