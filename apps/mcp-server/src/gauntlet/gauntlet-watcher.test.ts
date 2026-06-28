import test from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs-extra';

import {
  installGauntletWatcher,
  listGauntletWatchers,
  stopGauntletWatcher,
  startInstalledWatchers,
} from './gauntlet-watcher';
import { cleanupAllWatches } from '../watcher';

// Redirect HOME so persisted watchers.json lands in a temp dir.
const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;
const tmpHome = path.join(os.tmpdir(), `klauro-gw-test-${process.pid}-${Date.now()}`);
// A real, existing directory to point the watch at (tmpHome itself).
const repoPath = tmpHome;

test.before(async () => {
  await fs.ensureDir(tmpHome);
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
});

test.after(async () => {
  // Tear down any real fs.watch handles this test created.
  try { cleanupAllWatches(); } catch { /* ignore */ }
  process.env.HOME = ORIGINAL_HOME;
  process.env.USERPROFILE = ORIGINAL_USERPROFILE;
  try { await fs.remove(tmpHome); } catch { /* best effort */ }
});

test('install -> list -> stop lifecycle, with persistence and de-dup', async () => {
  const gw = await installGauntletWatcher(repoPath);
  assert.ok(gw.id, 'has id');
  assert.equal(gw.enabled, true);
  assert.equal(path.resolve(gw.repoPath), path.resolve(repoPath));
  assert.ok(gw.watchId, 'has underlying watchId');
  assert.equal(gw.runs, 0);

  // De-dup: installing again on the same path returns the same watcher id.
  const again = await installGauntletWatcher(repoPath);
  assert.equal(again.id, gw.id, 'duplicate install reuses existing watcher');

  // List merges persisted config with live status.
  const listed = await listGauntletWatchers();
  const found = listed.find(w => w.id === gw.id);
  assert.ok(found, 'watcher appears in list');
  assert.ok('watch' in found!, 'list includes live watch status field');

  // Stop disables it and persists.
  const res = await stopGauntletWatcher(gw.id);
  assert.equal(res.ok, true);
  const afterStop = (await listGauntletWatchers()).find(w => w.id === gw.id);
  assert.equal(afterStop?.enabled, false, 'watcher marked disabled after stop');
});

test('stopGauntletWatcher on unknown id returns ok:false', async () => {
  const res = await stopGauntletWatcher('no-such-watcher-id');
  assert.equal(res.ok, false);
});

test('startInstalledWatchers is idempotent and skips missing paths', async () => {
  // Install a watcher whose path will be removed -> startInstalledWatchers must
  // skip it without throwing.
  const gonePath = path.join(tmpHome, 'will-vanish');
  await fs.ensureDir(gonePath);
  const gw = await installGauntletWatcher(gonePath);
  assert.ok(gw.enabled);

  await fs.remove(gonePath); // path now gone

  // Should not throw; started count excludes the missing path.
  const r1 = await startInstalledWatchers();
  assert.ok(typeof r1.started === 'number', 'returns a started count');
  assert.ok(r1.started >= 0);

  // Idempotent: a second call also does not throw.
  const r2 = await startInstalledWatchers();
  assert.ok(typeof r2.started === 'number');

  await stopGauntletWatcher(gw.id);
});
