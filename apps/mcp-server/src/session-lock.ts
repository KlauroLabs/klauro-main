import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getBuildIdentity } from '../../../packages/analyzer-core/src/analyzer/core/build-identity';

// Best-effort session-lock files, one per running MCP server process:
// ~/.klauro/mcp-sessions/<pid>.json. This exists solely so `klauro update`
// (and `klauro status`) can tell the human "a running MCP session was
// detected — restart it" instead of updating the installed bundle with no
// signal that a client restart is required (MCP servers do not hot-reload;
// see docs on silent staleness in build-identity.ts / SERVER_INSTRUCTIONS).
//
// Deliberately NOT a real lock (no flock, no exclusivity semantics) — multiple
// MCP sessions across multiple repos/windows are normal and all legitimate.
// It is purely an announcement: "a process with this pid, running this
// version, started at this time, is alive." Consumers must treat a stale file
// (pid no longer running) as informational noise, not a hard error, since a
// crash or kill -9 skips the cleanup path.

export interface SessionLockEntry {
  pid: number;
  version: string;
  started_at: string;
}

function sessionsDir(): string {
  return process.env.KLAURO_SESSION_LOCK_DIR || path.join(os.homedir(), '.klauro', 'mcp-sessions');
}

function lockPath(pid: number = process.pid): string {
  return path.join(sessionsDir(), `${pid}.json`);
}

export function writeSessionLock(): void {
  try {
    const dir = sessionsDir();
    fs.mkdirSync(dir, { recursive: true });
    const entry: SessionLockEntry = {
      pid: process.pid,
      version: getBuildIdentity().version,
      started_at: new Date().toISOString(),
    };
    fs.writeFileSync(lockPath(), JSON.stringify(entry, null, 2));
  } catch {
    // best-effort only — a failed write must never block server startup
  }
}

export function removeSessionLock(): void {
  try {
    fs.unlinkSync(lockPath());
  } catch {
    // already gone, or never written — fine either way
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    // signal 0 sends nothing; it only checks whether the pid is
    // signalable (i.e. still alive) without affecting the target process.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * List every live MCP session announced via writeSessionLock(). Prunes stale
 * lock files left behind by a crash/kill -9 (best-effort, non-fatal) so repeat
 * callers (klauro update / klauro status) see a clean, accurate list.
 */
export function listActiveSessions(): SessionLockEntry[] {
  const dir = sessionsDir();
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return [];
  }

  const active: SessionLockEntry[] = [];
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const fullPath = path.join(dir, file);
    try {
      const entry = JSON.parse(fs.readFileSync(fullPath, 'utf8')) as SessionLockEntry;
      if (typeof entry.pid === 'number' && isProcessAlive(entry.pid)) {
        active.push(entry);
      } else {
        fs.unlinkSync(fullPath); // stale — process is gone, prune it
      }
    } catch {
      try { fs.unlinkSync(fullPath); } catch { /* ignore */ }
    }
  }
  return active;
}
