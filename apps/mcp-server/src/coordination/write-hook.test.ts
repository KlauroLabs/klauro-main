import test from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { appendClaim, getActiveClaims, readClaimLog } from './local-store';
import {
  startWriteHook,
  ensureWriteHookStarted,
  closeAllWriteHooks,
  shouldActivateWriteHook,
  type WriteHookHandle,
} from './write-hook';

/** Point KLAURO_COORD_DIR at a fresh temp dir per test so tests don't collide. */
async function freshCoordDir(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'klauro-coord-test-'));
  process.env.KLAURO_COORD_DIR = dir;
  return dir;
}

async function freshWorkspaceRoot(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'klauro-write-hook-test-'));
}

/** Wait until `predicate()` is true or `timeoutMs` elapses, polling every `stepMs`. */
async function waitFor(predicate: () => boolean, timeoutMs = 5000, stepMs = 25): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  assert.fail(`waitFor: condition not met within ${timeoutMs}ms`);
}

test('write-hook: a change under a claimed path auto-announces an edit attributed to the claim\'s agent', async (t) => {
  const coordDir = await freshCoordDir();
  const root = await freshWorkspaceRoot();
  const ws = 'ws-write-hook';

  const now = new Date().toISOString();
  await appendClaim(ws, {
    claim_id: `${ws}:agent-claim`,
    workspace_id: ws,
    agent_id: 'agent-claim',
    agent_kind: 'claude',
    scope: { repo: ws, paths: ['claimed.ts'], symbols: [] },
    intent: 'refactor claimed.ts',
    status: 'active',
    created_at: now,
    ttl_ms: 60_000,
    heartbeat_at: now,
  });

  const announced: Array<{ path: string; agentId: string; claimId: string }> = [];
  const errors: unknown[] = [];
  const handle = startWriteHook(root, ws, {
    debounceMs: 30,
    onAnnounce: (e) => announced.push(e),
    onError: (e) => errors.push(e),
  });
  t.after(() => handle.close());

  await fsp.writeFile(path.join(root, 'claimed.ts'), 'export const x = 1;\n', 'utf8');

  await waitFor(() => announced.length > 0);
  assert.equal(errors.length, 0, `no errors expected: ${JSON.stringify(errors)}`);
  assert.equal(announced[0].path, 'claimed.ts');
  assert.equal(announced[0].agentId, 'agent-claim');

  // The announced edit shows up as a real active edit-lock claim for that agent.
  const active = await getActiveClaims(ws);
  const editLock = active.find((c) => c.agent_id === 'agent-claim' && c.intent.startsWith('write-hook:'));
  assert.ok(editLock, 'write-hook auto-announced an edit-lock claim for agent-claim');
  assert.deepEqual(editLock!.scope.paths, ['claimed.ts']);

  handle.close();
  await fsp.rm(coordDir, { recursive: true, force: true });
  await fsp.rm(root, { recursive: true, force: true });
});

test('write-hook: a change under NO active claim records an unclaimed-edit event, not a claim', async (t) => {
  const coordDir = await freshCoordDir();
  const root = await freshWorkspaceRoot();
  const ws = 'ws-write-hook-unclaimed';

  const unclaimed: Array<{ path: string }> = [];
  const errors: unknown[] = [];
  const handle = startWriteHook(root, ws, {
    debounceMs: 30,
    onUnclaimedEdit: (e) => unclaimed.push(e),
    onError: (e) => errors.push(e),
  });
  t.after(() => handle.close());

  await fsp.writeFile(path.join(root, 'surprise.ts'), 'export const y = 2;\n', 'utf8');

  // Note: on some platforms/timings, `fs.watch(..., {recursive:true})` can
  // deliver a spurious event or two right around directory creation (e.g. an
  // event naming the watched root itself) — harmless under the write-hook's
  // awareness model (worst case: one extra 'unclaimed-edit' event for a path
  // nobody cares about), but it means we must look for OUR specific path
  // among whatever arrived rather than assuming it's the very first event.
  await waitFor(() => unclaimed.some((e) => e.path === 'surprise.ts'));
  assert.equal(errors.length, 0, `no errors expected: ${JSON.stringify(errors)}`);

  // It is logged as an event, but NEVER as an active claim.
  const active = await getActiveClaims(ws);
  assert.equal(active.length, 0, 'an unclaimed edit never becomes an active claim');
  const log = await readClaimLog(ws);
  assert.equal(log.filter((e) => e.kind === 'unclaimed-edit' && e.scope.paths[0] === 'surprise.ts').length, 1);

  handle.close();
  await fsp.rm(coordDir, { recursive: true, force: true });
  await fsp.rm(root, { recursive: true, force: true });
});

test('write-hook: overlapping claims produce an ambiguous observation without crediting either participant', async (t) => {
  const coordDir = await freshCoordDir();
  const root = await freshWorkspaceRoot();
  const ws = 'ws-write-hook-overlap';
  const now = new Date().toISOString();
  for (const agentId of ['agent-a', 'agent-b']) {
    await appendClaim(ws, {
      claim_id: `${ws}:${agentId}`,
      workspace_id: ws,
      agent_id: agentId,
      agent_kind: 'other',
      scope: { repo: ws, paths: ['shared.ts'], symbols: [] },
      intent: 'edit shared behavior',
      status: 'active',
      created_at: now,
      ttl_ms: 60_000,
      heartbeat_at: now,
    });
  }

  const announced: unknown[] = [];
  const ambiguous: Array<{ path: string; candidateAgentIds: string[] }> = [];
  const handle = startWriteHook(root, ws, {
    debounceMs: 30,
    onAnnounce: (event) => announced.push(event),
    onAmbiguousEdit: (event) => ambiguous.push(event),
  });
  t.after(() => handle.close());
  await fsp.writeFile(path.join(root, 'shared.ts'), 'export const shared = true;\n', 'utf8');
  await waitFor(() => ambiguous.length > 0);

  assert.deepEqual(ambiguous[0], { path: 'shared.ts', candidateAgentIds: ['agent-a', 'agent-b'] });
  assert.deepEqual(announced, []);
  const event = (await readClaimLog(ws)).find((entry) => entry.kind === 'ambiguous-edit');
  assert.deepEqual(event?.candidate_agent_ids, ['agent-a', 'agent-b']);
  assert.equal((await getActiveClaims(ws)).filter((claim) => claim.intent.startsWith('write-hook:')).length, 0);

  await fsp.rm(coordDir, { recursive: true, force: true });
  await fsp.rm(root, { recursive: true, force: true });
});

test('write-hook: excluded directories (node_modules, .git, dist) never announce or record anything', async (t) => {
  const coordDir = await freshCoordDir();
  const root = await freshWorkspaceRoot();
  const ws = 'ws-write-hook-excluded';

  await fsp.mkdir(path.join(root, 'node_modules', 'some-pkg'), { recursive: true });
  await fsp.mkdir(path.join(root, '.git'), { recursive: true });
  await fsp.mkdir(path.join(root, 'dist'), { recursive: true });
  // A real (non-excluded) file too, so we have a positive signal that the
  // watcher is actually running and would have fired for a legitimate path.
  await fsp.mkdir(path.join(root, 'src'), { recursive: true });

  const announced: unknown[] = [];
  const unclaimed: Array<{ path: string }> = [];
  const errors: unknown[] = [];
  const handle = startWriteHook(root, ws, {
    debounceMs: 30,
    onAnnounce: (e) => announced.push(e),
    onUnclaimedEdit: (e) => unclaimed.push(e),
    onError: (e) => errors.push(e),
  });
  t.after(() => handle.close());

  await fsp.writeFile(path.join(root, 'node_modules', 'some-pkg', 'index.js'), 'module.exports = 1;\n', 'utf8');
  await fsp.writeFile(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
  await fsp.writeFile(path.join(root, 'dist', 'bundle.js'), '// bundled\n', 'utf8');
  // The real signal: this one MUST fire.
  await fsp.writeFile(path.join(root, 'src', 'real.ts'), 'export const z = 3;\n', 'utf8');

  await waitFor(() => unclaimed.some((e) => e.path.includes('real.ts')));
  assert.equal(errors.length, 0, `no errors expected: ${JSON.stringify(errors)}`);
  assert.equal(announced.length, 0, 'excluded-dir paths never announce');
  assert.ok(
    unclaimed.every((e) => !e.path.includes('node_modules') && !e.path.includes('.git') && !e.path.includes('dist')),
    `excluded-dir paths must never be recorded, got: ${JSON.stringify(unclaimed)}`
  );

  handle.close();
  await fsp.rm(coordDir, { recursive: true, force: true });
  await fsp.rm(root, { recursive: true, force: true });
});

test('write-hook: close() stops the watcher (no leaked handle)', async () => {
  const coordDir = await freshCoordDir();
  const root = await freshWorkspaceRoot();
  const ws = 'ws-write-hook-close';

  const events: unknown[] = [];
  const handle = startWriteHook(root, ws, {
    debounceMs: 20,
    onAnnounce: (e) => events.push(e),
    onUnclaimedEdit: (e) => events.push(e),
  });

  handle.close();
  // Idempotent close must not throw.
  handle.close();

  // A write AFTER close must produce no events (give the debounce window a
  // moment to prove a negative, then move on — this test's real assertion is
  // that the process can exit cleanly afterward, verified by running this
  // file directly with `node --test` and no --test-force-exit, per the task's
  // verification step).
  await fsp.writeFile(path.join(root, 'after-close.ts'), 'export const w = 4;\n', 'utf8');
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(events.length, 0, 'no events after close()');

  await fsp.rm(coordDir, { recursive: true, force: true });
  await fsp.rm(root, { recursive: true, force: true });
});

// -- W5 activation primitives (ensureWriteHookStarted / closeAllWriteHooks /
// shouldActivateWriteHook) — the pieces server.ts's `advisoryFabricSettings`
// and `fab watch` both call, tested directly per the task's own guidance
// ("extract the activation into a small exported helper ... and test THAT").
// Every test below passes its OWN registry Map (never the module-level
// `DEFAULT_WRITE_HOOK_REGISTRY` singleton) so tests never leak state into
// each other or into the shared registry a real server process would use.

test('ensureWriteHookStarted: idempotent by workspace id — a second call returns the SAME handle, not a second watcher', async (t) => {
  const coordDir = await freshCoordDir();
  const root = await freshWorkspaceRoot();
  const ws = 'ws-ensure-idempotent';
  const registry = new Map<string, WriteHookHandle>();

  const announced: Array<{ path: string; agentId: string; claimId: string }> = [];
  const first = ensureWriteHookStarted(root, ws, { debounceMs: 30, onAnnounce: (e) => announced.push(e) }, registry);
  const second = ensureWriteHookStarted(root, ws, { debounceMs: 30, onAnnounce: (e) => announced.push(e) }, registry);
  t.after(() => closeAllWriteHooks(registry));

  assert.equal(first, second, 'a repeat call for the same workspace id must return the existing handle, not start a new watcher');
  assert.equal(registry.size, 1);

  await fsp.rm(coordDir, { recursive: true, force: true });
  await fsp.rm(root, { recursive: true, force: true });
});

test('ensureWriteHookStarted: different workspace ids each get their own handle', async (t) => {
  const coordDir = await freshCoordDir();
  const root = await freshWorkspaceRoot();
  const registry = new Map<string, WriteHookHandle>();

  const a = ensureWriteHookStarted(root, 'ws-ensure-a', { debounceMs: 30 }, registry);
  const b = ensureWriteHookStarted(root, 'ws-ensure-b', { debounceMs: 30 }, registry);
  t.after(() => closeAllWriteHooks(registry));

  assert.notEqual(a, b);
  assert.equal(registry.size, 2);

  await fsp.rm(coordDir, { recursive: true, force: true });
  await fsp.rm(root, { recursive: true, force: true });
});

test('closeAllWriteHooks: closes every handle in the registry, clears it, and stops further events', async () => {
  const coordDir = await freshCoordDir();
  const root = await freshWorkspaceRoot();
  const ws = 'ws-close-all';
  const registry = new Map<string, WriteHookHandle>();

  const events: unknown[] = [];
  ensureWriteHookStarted(
    root,
    ws,
    { debounceMs: 20, onAnnounce: (e) => events.push(e), onUnclaimedEdit: (e) => events.push(e) },
    registry
  );
  assert.equal(registry.size, 1);

  closeAllWriteHooks(registry);
  assert.equal(registry.size, 0, 'registry is cleared after closeAllWriteHooks');

  // Calling it again on an already-empty registry must not throw.
  closeAllWriteHooks(registry);

  await fsp.writeFile(path.join(root, 'after-close-all.ts'), 'export const v = 5;\n', 'utf8');
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(events.length, 0, 'no events after closeAllWriteHooks');

  await fsp.rm(coordDir, { recursive: true, force: true });
  await fsp.rm(root, { recursive: true, force: true });
});

test('shouldActivateWriteHook: gates on .klaurorc fabric.enabled or the KLAURO_WRITE_HOOK=1 escape hatch, inert otherwise', () => {
  assert.equal(shouldActivateWriteHook({ fabric: { enabled: true } }, {}), true, 'fabric.enabled:true activates');
  assert.equal(shouldActivateWriteHook({ fabric: { enabled: false } }, {}), false, 'an explicit `klauro fabric off` stays inert');
  assert.equal(shouldActivateWriteHook({}, {}), false, 'no .klaurorc fabric section at all (local default) stays inert');
  assert.equal(
    shouldActivateWriteHook({}, { KLAURO_WRITE_HOOK: '1' }),
    true,
    'the KLAURO_WRITE_HOOK=1 escape hatch activates even with no fabric config'
  );
  assert.equal(
    shouldActivateWriteHook({}, { KLAURO_WRITE_HOOK: '0' }),
    false,
    'any value other than the literal "1" does not activate'
  );
});
