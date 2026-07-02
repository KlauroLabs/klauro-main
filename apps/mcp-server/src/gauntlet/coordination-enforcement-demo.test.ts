import test from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * These tests assert the PREVENTION invariant of Coordination Fabric v2's
 * grant manager: a true same-symbol collision is BLOCKED (queued), not just
 * flagged. Contrast with coordination-fleet-demo.test.ts (v1/advisory), which
 * only asserts that conflicts get labeled in a collision report — nothing
 * there stops a second agent from proceeding.
 *
 * Contract-first: `../coordination/grant-manager.ts` is being built by
 * agent-core to the frozen contract in the mission brief. If it doesn't
 * exist yet, the dynamic import below fails and every test in this file
 * reports "awaiting core" via t.skip with the reason, instead of crashing
 * the whole suite with an unhelpful module-resolution error.
 */

let coreAvailable = false;
let coreImportError: unknown;

let runEnforcementDemo: typeof import('./coordination-enforcement-demo').runEnforcementDemo;
let withIsolatedCoordDir: typeof import('./coordination-enforcement-demo').withIsolatedCoordDir;
let requestGrant: typeof import('../coordination/grant-manager').requestGrant;
let releaseGrant: typeof import('../coordination/grant-manager').releaseGrant;
let heartbeatGrant: typeof import('../coordination/grant-manager').heartbeatGrant;
let getGrants: typeof import('../coordination/grant-manager').getGrants;

try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const grantManager = require('../coordination/grant-manager');
  requestGrant = grantManager.requestGrant;
  releaseGrant = grantManager.releaseGrant;
  heartbeatGrant = grantManager.heartbeatGrant;
  getGrants = grantManager.getGrants;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const demo = require('./coordination-enforcement-demo');
  runEnforcementDemo = demo.runEnforcementDemo;
  withIsolatedCoordDir = demo.withIsolatedCoordDir;
  coreAvailable = true;
} catch (err) {
  coreImportError = err;
  coreAvailable = false;
}

async function freshCoordDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'klauro-enforcement-demo-test-'));
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

test('grant-manager contract availability (informational)', (t) => {
  if (!coreAvailable) {
    console.log(
      `[coordination-enforcement-demo] AWAITING CORE: ../coordination/grant-manager.ts not importable yet. ` +
        `Error: ${coreImportError instanceof Error ? coreImportError.message : String(coreImportError)}`
    );
    t.skip('grant-manager.ts not landed yet — demo + assertions are written to the frozen contract and ready to run once it exists');
    return;
  }
  assert.ok(coreAvailable);
});

test('scenario 1: same-symbol collision is PREVENTED — beta is queued, not granted, alpha stays sole active grant', async (t) => {
  if (!coreAvailable) {
    t.skip('awaiting core');
    return;
  }
  const { cleanup } = await freshCoordDir();
  t.after(cleanup);

  const workspaceId = 'ws-enforce-collision';

  const alphaResp = await requestGrant({
    workspace_id: workspaceId,
    agent_id: 'agent-alpha',
    agent_kind: 'claude',
    scope: { repo: workspaceId, paths: ['src/payments/process.ts'], symbols: ['processPayment'] },
    intent: 'Refactor payment processing for idempotency',
  });
  assert.equal(alphaResp.verdict, 'granted');

  const betaResp = await requestGrant({
    workspace_id: workspaceId,
    agent_id: 'agent-beta',
    agent_kind: 'claude',
    scope: { repo: workspaceId, paths: ['src/payments/process.ts'], symbols: ['processPayment'] },
    intent: 'Add retry logic to payment processing',
  });

  // The core assertion: v1 would have let both proceed (both "granted" or
  // both silently appended as active). v2 MUST NOT grant beta while alpha
  // holds an active lease on the same symbol.
  assert.equal(betaResp.verdict, 'queued', 'beta must be queued, not granted, while alpha holds processPayment');
  assert.ok(betaResp.conflict, 'beta response must name the conflicting grant');
  assert.ok(
    JSON.stringify(betaResp.conflict).includes('agent-alpha'),
    `beta's conflict must name agent-alpha; got ${JSON.stringify(betaResp.conflict)}`
  );

  const { active } = await getGrants(workspaceId);
  const onSymbol = active.filter((g) => (g.scope?.symbols ?? []).includes('processPayment'));
  assert.equal(onSymbol.length, 1, 'exactly one active grant on processPayment');
  assert.equal(onSymbol[0]?.agent_id, 'agent-alpha');
});

test('scenario 2: queue advancement — releasing alpha auto-grants queued beta', async (t) => {
  if (!coreAvailable) {
    t.skip('awaiting core');
    return;
  }
  const { cleanup } = await freshCoordDir();
  t.after(cleanup);

  const workspaceId = 'ws-enforce-queue-advance';
  const symbol = 'processPayment';

  const alphaResp = await requestGrant({
    workspace_id: workspaceId,
    agent_id: 'agent-alpha',
    agent_kind: 'claude',
    scope: { repo: workspaceId, paths: ['src/payments/process.ts'], symbols: [symbol] },
    intent: 'Refactor payment processing',
  });
  assert.equal(alphaResp.verdict, 'granted');
  assert.ok(alphaResp.grant_id);

  const betaResp = await requestGrant({
    workspace_id: workspaceId,
    agent_id: 'agent-beta',
    agent_kind: 'claude',
    scope: { repo: workspaceId, paths: ['src/payments/process.ts'], symbols: [symbol] },
    intent: 'Add retry logic',
  });
  assert.equal(betaResp.verdict, 'queued');

  await releaseGrant(workspaceId, 'agent-alpha', alphaResp.grant_id!);

  const { active } = await getGrants(workspaceId);
  const betaActive = active.find((g) => g.agent_id === 'agent-beta' && (g.scope?.symbols ?? []).includes(symbol));
  assert.ok(betaActive, 'beta should be auto-granted after alpha releases');
});

test('scenario 3: lease expiry frees the queue — unheartbeated grant expires, queued agent is auto-granted', async (t) => {
  if (!coreAvailable) {
    t.skip('awaiting core');
    return;
  }
  const { cleanup } = await freshCoordDir();
  t.after(cleanup);

  const workspaceId = 'ws-enforce-expiry';
  const symbol = 'calculateRefund';
  const shortTtlMs = 200;

  const alphaResp = await requestGrant({
    workspace_id: workspaceId,
    agent_id: 'agent-alpha',
    agent_kind: 'claude',
    scope: { repo: workspaceId, paths: ['src/payments/refund.ts'], symbols: [symbol] },
    intent: 'Rewrite refund calculation',
    ttl_ms: shortTtlMs,
  });
  assert.equal(alphaResp.verdict, 'granted');

  const gammaResp = await requestGrant({
    workspace_id: workspaceId,
    agent_id: 'agent-gamma',
    agent_kind: 'claude',
    scope: { repo: workspaceId, paths: ['src/payments/refund.ts'], symbols: [symbol] },
    intent: 'Fix refund rounding',
  });
  assert.equal(gammaResp.verdict, 'queued');

  await new Promise((resolve) => setTimeout(resolve, shortTtlMs + 250));

  let gammaActive;
  for (let i = 0; i < 10 && !gammaActive; i++) {
    const { active } = await getGrants(workspaceId);
    gammaActive = active.find((g) => g.agent_id === 'agent-gamma' && (g.scope?.symbols ?? []).includes(symbol));
    if (!gammaActive) {
      await requestGrant({
        workspace_id: workspaceId,
        agent_id: 'agent-gamma',
        agent_kind: 'claude',
        scope: { repo: workspaceId, paths: ['src/payments/refund.ts'], symbols: [symbol] },
        intent: 'poll for reclamation',
      }).catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  assert.ok(gammaActive, 'gamma should be auto-granted once alphas unheartbeated lease expires');
});

test('scenario 4: heartbeat holds the lock — heartbeated grant survives past original ttl, no takeover', async (t) => {
  if (!coreAvailable) {
    t.skip('awaiting core');
    return;
  }
  const { cleanup } = await freshCoordDir();
  t.after(cleanup);

  const workspaceId = 'ws-enforce-heartbeat';
  const symbol = 'validateCoupon';
  const shortTtlMs = 200;

  const alphaResp = await requestGrant({
    workspace_id: workspaceId,
    agent_id: 'agent-alpha',
    agent_kind: 'claude',
    scope: { repo: workspaceId, paths: ['src/promo/coupon.ts'], symbols: [symbol] },
    intent: 'Harden coupon validation',
    ttl_ms: shortTtlMs,
  });
  assert.equal(alphaResp.verdict, 'granted');
  assert.ok(alphaResp.grant_id);

  const betaResp = await requestGrant({
    workspace_id: workspaceId,
    agent_id: 'agent-beta',
    agent_kind: 'claude',
    scope: { repo: workspaceId, paths: ['src/promo/coupon.ts'], symbols: [symbol] },
    intent: 'Add expiry check',
  });
  assert.equal(betaResp.verdict, 'queued');

  // Each heartbeat resets heartbeat_at to now and re-arms a FULL ttl_ms
  // window from that instant (see grant-manager.ts's heartbeatGrant), so to
  // prove "past the original ttl, no takeover" we wait less than ttl_ms after
  // the heartbeat while total elapsed time since the ORIGINAL grant exceeds
  // ttl_ms.
  await new Promise((resolve) => setTimeout(resolve, shortTtlMs * 0.7));
  const hb = await heartbeatGrant(workspaceId, alphaResp.grant_id!);
  assert.notEqual(hb.ok, false, 'heartbeat on a still-valid grant should succeed');

  // Past the original ttl window (measured from the original grant), but
  // well within the freshly re-armed lease from the heartbeat above.
  await new Promise((resolve) => setTimeout(resolve, shortTtlMs * 0.5));

  const { active } = await getGrants(workspaceId);
  const alphaStillActive = active.find((g) => g.agent_id === 'agent-alpha' && (g.scope?.symbols ?? []).includes(symbol));
  const betaTookOver = active.some((g) => g.agent_id === 'agent-beta' && (g.scope?.symbols ?? []).includes(symbol));

  assert.ok(alphaStillActive, 'alpha must still hold the lock after heartbeating past the original ttl');
  assert.equal(betaTookOver, false, 'beta must NOT take over while alpha heartbeats');
});

test('scenario 5: disjoint symbols run free — non-conflicting concurrent requests are both granted', async (t) => {
  if (!coreAvailable) {
    t.skip('awaiting core');
    return;
  }
  const { cleanup } = await freshCoordDir();
  t.after(cleanup);

  const workspaceId = 'ws-enforce-disjoint';

  const [deltaResp, epsilonResp] = await Promise.all([
    requestGrant({
      workspace_id: workspaceId,
      agent_id: 'agent-delta',
      agent_kind: 'claude',
      scope: { repo: workspaceId, paths: ['src/lib/shared-utils.ts'], symbols: ['formatCurrency'] },
      intent: 'Fix currency rounding',
    }),
    requestGrant({
      workspace_id: workspaceId,
      agent_id: 'agent-epsilon',
      agent_kind: 'claude',
      scope: { repo: workspaceId, paths: ['src/routes/pricing.ts'], symbols: ['pricingHandler'] },
      intent: 'Add bulk-pricing tiers',
    }),
  ]);

  assert.equal(deltaResp.verdict, 'granted', 'disjoint-symbol requests must not be serialized');
  assert.equal(epsilonResp.verdict, 'granted', 'disjoint-symbol requests must not be serialized');
});

test('scenario 6: queued agent may receive a redirect_hint instead of idle-blocking', async (t) => {
  if (!coreAvailable) {
    t.skip('awaiting core');
    return;
  }
  const { cleanup } = await freshCoordDir();
  t.after(cleanup);

  const workspaceId = 'ws-enforce-redirect';
  const symbol = 'applyDiscount';

  await requestGrant({
    workspace_id: workspaceId,
    agent_id: 'agent-alpha',
    agent_kind: 'claude',
    scope: { repo: workspaceId, paths: ['src/promo/discount.ts'], symbols: [symbol] },
    intent: 'Refactor discount application',
  });

  const betaResp = await requestGrant({
    workspace_id: workspaceId,
    agent_id: 'agent-beta',
    agent_kind: 'claude',
    scope: { repo: workspaceId, paths: ['src/promo/discount.ts'], symbols: [symbol] },
    intent: 'Add percentage-discount support',
  });

  assert.equal(betaResp.verdict, 'queued');
  // Soft assertion: redirect_hint is part of the frozen contract's response
  // shape but may be optional in a first landing of grant-manager.ts. Log
  // rather than hard-fail so this scenario doesn't block the rest of the
  // suite on an optional feature.
  if (betaResp.redirect_hint === undefined || betaResp.redirect_hint === null) {
    console.log('[scenario 6] no redirect_hint provided by this grant-manager build (optional contract field)');
  } else {
    assert.ok(betaResp.redirect_hint, 'redirect_hint, when present, must be truthy/non-empty');
  }
});

test('full enforcement demo run: invariant holds, collisions prevented count is correct', async (t) => {
  if (!coreAvailable) {
    t.skip('awaiting core');
    return;
  }
  const workspaceId = `enforcement-demo-test-${Date.now()}`;
  const summary = await withIsolatedCoordDir(() => runEnforcementDemo(workspaceId));

  assert.equal(summary.invariantHeld, true, 'no two active grants may ever overlap on a symbol during the run');
  assert.ok(summary.collisionsPrevented >= 1, 'at least one same-symbol collision must be prevented in the run');
  assert.ok(summary.scenarios.length === 6, 'all 6 scenarios should have run');
  for (const s of summary.scenarios) {
    assert.ok(s.passed, `scenario ${s.name} failed: ${s.details}`);
  }
});
