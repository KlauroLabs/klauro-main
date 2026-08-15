import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getBuildIdentity } from '../../../packages/analyzer-core/src/analyzer/core/build-identity';















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

  }
}

export function removeSessionLock(): void {
  try {
    fs.unlinkSync(lockPath());
  } catch {

  }
}

function isProcessAlive(pid: number): boolean {
  try {


    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}






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
        fs.unlinkSync(fullPath);
      }
    } catch {
      try { fs.unlinkSync(fullPath); } catch {   }
    }
  }
  return active;
}
