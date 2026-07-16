import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { createServer } from './server';
import { DEFAULT_WRITE_HOOK_REGISTRY, closeAllWriteHooks } from './coordination/write-hook';

/**
 * Verifies the ADVISORY coordination-fabric MCP tools (CLI-parity for
 * apps/mcp-server/scripts/fab.ts) end to end through the registered MCP surface:
 * fab_claim_work / fab_check_collision / fab_release_work / fab_list_active_work.
 * These are the same-machine, awareness-first local-store primitives exposed as
 * MCP tools so a fleet coordinates through the product, not a private script.
 *
 * Asserts: claim -> list_active_work sees it -> check_collision from a peer
 * reports the overlap -> claiming the same paths from a peer returns an inline
 * advisory warning (belt-and-suspenders) -> release clears it.
 */
function getToolHandler(server: ReturnType<typeof createServer>, name: string): (args: any) => Promise<any> {
  const registered = (server as any)._registeredTools[name];
  assert.ok(registered, `tool ${name} should be registered`);
  return registered.callback ?? registered.handler;
}

function payload(result: any): any {
  assert.ok(!result.isError, `expected success, got ${result.content?.[0]?.text}`);
  return JSON.parse(result.content[0].text);
}

/**
 * Hermetic fabric environment for the fab_* handlers. They resolve their tier
 * and workspace via resolveFabricSettings, searching the analysis registry's
 * project roots AND process.cwd() for a .klaurorc. Run unisolated from inside
 * this repo — whose .klaurorc enables the fabric with a remote endpoint and a
 * config workspace that beats $FAB_WS — and these tests would exercise the
 * LIVE endpoint (nondeterministic: prior runs' claims persist there for their
 * TTL) instead of the local store under KLAURO_COORD_DIR. Point the storage
 * registry at an empty temp dir and chdir into a config-less temp root so the
 * chain resolves to the LOCAL tier deterministically.
 */
async function withHermeticFabricEnv<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-fab-hermetic-'));
  const previousCoordDir = process.env.KLAURO_COORD_DIR;
  const previousFabWs = process.env.FAB_WS;
  const previousStorage = process.env.KLAURO_STORAGE_PATH;
  const previousFabricCwd = process.env.KLAURO_FABRIC_CWD;
  const previousCwd = process.cwd();
  process.env.KLAURO_COORD_DIR = path.join(root, 'coord');
  process.env.KLAURO_STORAGE_PATH = path.join(root, 'storage');
  delete process.env.KLAURO_FABRIC_CWD;
  process.chdir(root);
  try {
    return await fn(root);
  } finally {
    process.chdir(previousCwd);
    if (previousCoordDir === undefined) delete process.env.KLAURO_COORD_DIR;
    else process.env.KLAURO_COORD_DIR = previousCoordDir;
    if (previousFabWs === undefined) delete process.env.FAB_WS;
    else process.env.FAB_WS = previousFabWs;
    if (previousStorage === undefined) delete process.env.KLAURO_STORAGE_PATH;
    else process.env.KLAURO_STORAGE_PATH = previousStorage;
    if (previousFabricCwd === undefined) delete process.env.KLAURO_FABRIC_CWD;
    else process.env.KLAURO_FABRIC_CWD = previousFabricCwd;
    await fs.rm(root, { recursive: true, force: true });
  }
}

test('fab advisory tools: claim -> list sees it -> check reports collision -> release clears', async () => {
  await withHermeticFabricEnv(async () => {
  delete process.env.FAB_WS; // exercise the stable 'poc' fallback
  {
    const server = createServer();
    const claim = getToolHandler(server, 'fab_claim_work');
    const check = getToolHandler(server, 'fab_check_collision');
    const release = getToolHandler(server, 'fab_release_work');
    const list = getToolHandler(server, 'fab_list_active_work');

    const ws = 'ws-fab-test';

    // Agent A claims a path.
    const claimed = payload(await claim({
      agent_id: 'agent-a',
      intent: 'refactor foo handler',
      paths: ['src/foo.ts'],
      symbols: ['fooHandler'],
      workspace: ws,
    }));
    assert.equal(claimed.status, 'claimed');
    assert.equal(claimed.agent_id, 'agent-a');
    assert.deepEqual(claimed.paths, ['src/foo.ts']);
    assert.equal(claimed.conflicts.length, 0, 'no conflict on a fresh claim');
    // A fresh claim carries no OVERLAP advisory. (In this hermetic env the
    // response may carry the informational local-tier diagnostic — "no
    // .klaurorc fabric config found ... LOCAL fabric only" — which is the
    // intended remote-vs-local honesty surfacing, not a conflict warning.)
    assert.ok(
      !claimed.warning || !/ADVISORY/.test(claimed.warning),
      `unexpected overlap advisory on a fresh claim: ${claimed.warning}`,
    );

    // list_active_work sees agent A's claim.
    const listed = payload(await list({ workspace: ws }));
    assert.equal(listed.count, 1);
    assert.equal(listed.active[0].agent_id, 'agent-a');
    assert.equal(listed.active[0].intent, 'refactor foo handler');
    assert.deepEqual(listed.active[0].paths, ['src/foo.ts']);

    // Agent B's check_collision on the overlapping path reports the conflict.
    const collision = payload(await check({
      agent_id: 'agent-b',
      paths: ['src/foo.ts'],
      workspace: ws,
    }));
    assert.equal(collision.ok, false);
    assert.equal(collision.conflicts.length, 1);
    assert.equal(collision.conflicts[0].agent_id, 'agent-a');
    assert.ok(collision.conflicts[0].overlapping_paths.includes('src/foo.ts'));

    // Agent B's check_collision on a DISJOINT path is clean.
    const clean = payload(await check({
      agent_id: 'agent-b',
      paths: ['src/bar.ts'],
      workspace: ws,
    }));
    assert.equal(clean.ok, true);
    assert.equal(clean.conflicts.length, 0);

    // Belt-and-suspenders: agent B claims the SAME path (skipping check) — the
    // claim still succeeds but carries an inline advisory warning + conflicts.
    const claimedB = payload(await claim({
      agent_id: 'agent-b',
      intent: 'also touch foo',
      paths: ['src/foo.ts'],
      workspace: ws,
    }));
    assert.equal(claimedB.status, 'claimed', 'advisory claim always succeeds');
    assert.equal(claimedB.conflicts.length, 1);
    assert.equal(claimedB.conflicts[0].agent_id, 'agent-a');
    assert.ok(claimedB.warning && claimedB.warning.includes('agent-a'), 'inline warning names the other agent');

    // Release agent A -> its claim disappears from the active set; B remains.
    const released = payload(await release({ agent_id: 'agent-a', workspace: ws }));
    assert.equal(released.status, 'released');
    assert.equal(released.released_count, 1);

    const afterRelease = payload(await list({ workspace: ws }));
    assert.equal(afterRelease.count, 1, 'only agent-b remains active');
    assert.equal(afterRelease.active[0].agent_id, 'agent-b');

    // Now agent A's path is free: agent-c sees no collision on it.
    const freed = payload(await check({
      agent_id: 'agent-c',
      paths: ['src/foo.ts'],
      workspace: ws,
    }));
    // agent-b still holds src/foo.ts, so this remains a collision with b (not a) —
    // assert the awareness correctly attributes it to the remaining holder.
    assert.equal(freed.ok, false);
    assert.equal(freed.conflicts[0].agent_id, 'agent-b');
  }
  });
});

test('fab workspace default chain: .klaurorc fabric.workspace > $FAB_WS > "poc"', async () => {
  await withHermeticFabricEnv(async (root) => {
    const server = createServer();
    const claim = getToolHandler(server, 'fab_claim_work');
    const list = getToolHandler(server, 'fab_list_active_work');

    // No workspace arg, no .klaurorc in reach, no FAB_WS -> stable 'poc'
    // fallback (never the cwd basename — that was the original papercut).
    delete process.env.FAB_WS;
    const claimedPoc = payload(await claim({ agent_id: 'agent-a', intent: 'work', paths: ['a.ts'] }));
    assert.equal(claimedPoc.workspace, 'poc');
    const listedPoc = payload(await list({}));
    assert.equal(listedPoc.workspace, 'poc');
    assert.equal(listedPoc.count, 1);

    // FAB_WS set -> that workspace is used when no arg is passed.
    process.env.FAB_WS = 'my-feature';
    const listedFeature = payload(await list({}));
    assert.equal(listedFeature.workspace, 'my-feature');
    assert.equal(listedFeature.count, 0, 'different workspace, no claims yet');

    // A .klaurorc fabric.workspace in reach (here: the test cwd) is the FIRST
    // link of the chain — it beats $FAB_WS. fabric.enabled=false keeps the
    // tier LOCAL (an explicit `klauro fabric off` still names its workspace).
    await fs.writeJson(path.join(root, '.klaurorc'), {
      version: 1,
      kind: 'project',
      project: { name: 'fab-default-chain-fixture' },
      fabric: { enabled: false, workspace: 'config-ws' },
    });
    const listedConfig = payload(await list({}));
    assert.equal(listedConfig.workspace, 'config-ws', '.klaurorc fabric.workspace beats $FAB_WS');
  });
});

/**
 * W5 MCP-server lifecycle activation (SPEC-COORDINATION-FABRIC-V3 §8): every
 * fab_* tool call resolves fabric settings via `advisoryFabricSettings`
 * (server.ts), which is now also the write-hook activation choke-point. These
 * tests drive that path through the REAL registered tool (not a private
 * helper — the wiring itself is what's under test) and inspect the shared
 * `DEFAULT_WRITE_HOOK_REGISTRY` write-hook.ts exports for exactly that
 * reason. Every test closes what it started so the module singleton never
 * leaks a live `fs.watch` handle past its own test.
 */
test('W5 activation: a fabric.enabled:true workspace auto-starts the write-hook exactly once (idempotent)', async () => {
  await withHermeticFabricEnv(async (root) => {
    // A deliberately unreachable endpoint: activation must not depend on the
    // remote call itself succeeding — resolveFabricSettings only needs to see
    // `fabric.enabled: true` to flip `shouldActivateWriteHook` on, and the
    // fab_claim_work call is expected to warn-and-degrade to LOCAL exactly
    // like any other remote failure (fab-coordination's own advisory-degrade
    // contract), never crash.
    await fs.writeJson(path.join(root, '.klaurorc'), {
      version: 1,
      kind: 'project',
      project: { name: 'w5-activation-fixture' },
      fabric: { enabled: true, endpoint: 'http://127.0.0.1:1', workspace: 'w5-ws' },
    });

    const before = DEFAULT_WRITE_HOOK_REGISTRY.size;
    try {
      const server = createServer();
      const claim = getToolHandler(server, 'fab_claim_work');

      await claim({ agent_id: 'agent-w5', intent: 'w5 activation', paths: ['a.ts'], workspace: 'w5-ws' });
      assert.equal(DEFAULT_WRITE_HOOK_REGISTRY.size, before + 1, 'write-hook started for the fabric-enabled workspace');
      assert.ok(DEFAULT_WRITE_HOOK_REGISTRY.has('w5-ws'));

      // A second call for the SAME workspace must not start a second watcher.
      await claim({ agent_id: 'agent-w5', intent: 'w5 activation again', paths: ['a.ts'], workspace: 'w5-ws' });
      assert.equal(DEFAULT_WRITE_HOOK_REGISTRY.size, before + 1, 'repeat calls are idempotent — no second watcher');
    } finally {
      closeAllWriteHooks(DEFAULT_WRITE_HOOK_REGISTRY);
    }
  });
});

test('W5 activation: a workspace with no fabric config (or fabric.enabled:false) never starts a write-hook', async () => {
  await withHermeticFabricEnv(async () => {
    const before = DEFAULT_WRITE_HOOK_REGISTRY.size;
    try {
      const server = createServer();
      const claim = getToolHandler(server, 'fab_claim_work');

      // No .klaurorc at all -> local default ('poc'-style fallback workspace).
      await claim({ agent_id: 'agent-w5b', intent: 'no fabric config', paths: ['b.ts'], workspace: 'w5-ws-unconfigured' });
      assert.equal(DEFAULT_WRITE_HOOK_REGISTRY.size, before, 'no write-hook without an opted-in fabric config');
      assert.ok(!DEFAULT_WRITE_HOOK_REGISTRY.has('w5-ws-unconfigured'));
    } finally {
      closeAllWriteHooks(DEFAULT_WRITE_HOOK_REGISTRY);
    }
  });
});
