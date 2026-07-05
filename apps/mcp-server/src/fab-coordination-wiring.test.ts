import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { createServer } from './server';

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

test('fab advisory tools: claim -> list sees it -> check reports collision -> release clears', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-fab-wiring-'));
  const previousCoordDir = process.env.KLAURO_COORD_DIR;
  const previousFabWs = process.env.FAB_WS;
  process.env.KLAURO_COORD_DIR = path.join(root, 'coord');
  delete process.env.FAB_WS; // exercise the stable 'poc' fallback

  try {
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
    assert.equal(claimed.warning, undefined);

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
  } finally {
    if (previousCoordDir === undefined) delete process.env.KLAURO_COORD_DIR;
    else process.env.KLAURO_COORD_DIR = previousCoordDir;
    if (previousFabWs === undefined) delete process.env.FAB_WS;
    else process.env.FAB_WS = previousFabWs;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('fab_list_active_work / fab_check_collision default workspace to $FAB_WS then "poc"', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-fab-default-ws-'));
  const previousCoordDir = process.env.KLAURO_COORD_DIR;
  const previousFabWs = process.env.FAB_WS;
  process.env.KLAURO_COORD_DIR = path.join(root, 'coord');

  try {
    const server = createServer();
    const claim = getToolHandler(server, 'fab_claim_work');
    const list = getToolHandler(server, 'fab_list_active_work');

    // No workspace arg, no FAB_WS -> defaults to 'poc'.
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
  } finally {
    if (previousCoordDir === undefined) delete process.env.KLAURO_COORD_DIR;
    else process.env.KLAURO_COORD_DIR = previousCoordDir;
    if (previousFabWs === undefined) delete process.env.FAB_WS;
    else process.env.FAB_WS = previousFabWs;
    await fs.rm(root, { recursive: true, force: true });
  }
});
