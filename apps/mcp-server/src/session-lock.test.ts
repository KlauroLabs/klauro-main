import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Isolate KLAURO_SESSION_LOCK_DIR to a fresh temp dir per test run so this
// suite never touches the real ~/.klauro/mcp-sessions or collides with other
// concurrently-running klauro processes on this machine.
process.env.KLAURO_SESSION_LOCK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-session-lock-test-'));

// Imported AFTER the env var is set, since sessionsDir() reads it at call time
// (not module load time) — but importing after keeps intent obvious either way.
import { writeSessionLock, removeSessionLock, listActiveSessions } from './session-lock';

test('writeSessionLock announces the current process; listActiveSessions reports it', () => {
  writeSessionLock();
  try {
    const active = listActiveSessions();
    const mine = active.find(s => s.pid === process.pid);
    assert.ok(mine, 'expected the current process to show up in listActiveSessions()');
    assert.ok(mine!.version.length > 0);
    assert.ok(mine!.started_at.length > 0);
  } finally {
    removeSessionLock();
  }
});

test('removeSessionLock cleans up; the process no longer appears', () => {
  writeSessionLock();
  removeSessionLock();
  const active = listActiveSessions();
  assert.equal(active.find(s => s.pid === process.pid), undefined);
});

test('listActiveSessions prunes a lock file for a pid that is no longer running (crash/kill -9 case)', () => {
  const dir = process.env.KLAURO_SESSION_LOCK_DIR!;
  const deadPid = 999999; // extremely unlikely to be a live pid on any dev machine or CI runner
  const lockFile = path.join(dir, `${deadPid}.json`);
  fs.writeFileSync(lockFile, JSON.stringify({ pid: deadPid, version: '0.0.1-stale', started_at: new Date(0).toISOString() }));

  const active = listActiveSessions();
  assert.equal(active.find(s => s.pid === deadPid), undefined, 'a dead pid must not be reported as active');
  assert.equal(fs.existsSync(lockFile), false, 'the stale lock file should have been pruned from disk');
});

test('listActiveSessions returns [] when the lock directory does not exist yet (fresh install, no session ever started)', () => {
  process.env.KLAURO_SESSION_LOCK_DIR = path.join(os.tmpdir(), `klauro-session-lock-missing-${Date.now()}`);
  assert.deepEqual(listActiveSessions(), []);
});
