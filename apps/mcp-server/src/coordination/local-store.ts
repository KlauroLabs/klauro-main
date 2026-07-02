/**
 * LOCAL tier of the two-tier coordination store (§1.1 SPEC-COORDINATION-FABRIC.md).
 *
 * Same-machine, zero-network: all agents on one host append to a shared,
 * file-backed, append-only claim log at
 * `process.env.KLAURO_COORD_DIR || ~/.klauro/coordination/<workspace_id>/claims.jsonl`.
 *
 * This module owns ONLY the store/transport concerns (file IO, atomic append,
 * fs.watch). All consistency/derivation logic is delegated to the already-built
 * pure core in `./presence` (`reduceClaimLog`, `deriveActiveClaims`,
 * `derivePresence`) and `./arbiter` — nothing here reimplements LWW.
 *
 * Concurrency: multiple OS processes may append concurrently (that's the point —
 * many agents, one host). Each append opens the file with the `a` (append) flag,
 * which on POSIX filesystems is atomic for writes below the OS pipe buffer size
 * (a single JSON-Lines claim record is always well under that). The monotonic
 * `seq` is assigned by reading the current log length under a lightweight
 * lockfile (`claims.jsonl.lock`) held only for the read-length+append critical
 * section, so `seq` assignment itself is serialized across processes even
 * though the underlying `claims.jsonl` writes are append-only.
 */

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { deriveActiveClaims, derivePresence } from './presence';
import type { AgentPresence, WorkClaim, WorkClaimStatus } from './types';

/** One line of `claims.jsonl`: a `WorkClaim` plus store-assigned bookkeeping. */
export interface ClaimLogEntry extends WorkClaim {
  /** ISO timestamp the local store received/appended this entry (store-assigned). */
  logged_at: string;
}

/** A same-machine edit-lock overlap finding for `checkEditLock`. */
export interface EditLockConflict {
  agent_id: string;
  claim_id: string;
  paths: string[];
  overlapping_paths: string[];
}

/** Result of `attributeChange`: which active agents/claims touch a given path. */
export interface ChangeAttribution {
  path: string;
  attributions: Array<{
    agent_id: string;
    claim_id: string;
    intent: string;
    status: WorkClaimStatus;
  }>;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes — soft edit-locks are short-lived.
const LOCK_STALE_MS = 5000; // treat a lockfile older than this as abandoned.

/** Root directory for one workspace's local coordination store. */
export function getStoreDir(workspaceId: string): string {
  const base = process.env.KLAURO_COORD_DIR || path.join(os.homedir(), '.klauro', 'coordination');
  return path.join(base, workspaceId);
}

function getLogPath(workspaceId: string): string {
  return path.join(getStoreDir(workspaceId), 'claims.jsonl');
}

function getLockPath(workspaceId: string): string {
  return getLogPath(workspaceId) + '.lock';
}

function ensureDirSync(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * Acquire an exclusive lockfile via `open(..., 'wx')` (fails if it already
 * exists), retrying until free or a stale lock is reclaimed. Returns a release
 * function. This only guards the read-length+append critical section for `seq`
 * assignment — it is held for microseconds, not for the life of the process.
 */
async function withLock<T>(workspaceId: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = getLockPath(workspaceId);
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      const fd = await fsp.open(lockPath, 'wx');
      await fd.close();
      break;
    } catch (err: any) {
      if (err?.code !== 'EEXIST') throw err;
      // Reclaim a stale lock (crashed holder) instead of deadlocking forever.
      try {
        const stat = await fsp.stat(lockPath);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          await fsp.rm(lockPath, { force: true });
          continue;
        }
      } catch {
        // lock disappeared between the failed open and stat — retry loop.
      }
      if (Date.now() > deadline) {
        throw new Error(`local-store: timed out acquiring lock at ${lockPath}`);
      }
      await new Promise((r) => setTimeout(r, 10 + Math.random() * 20));
    }
  }
  try {
    return await fn();
  } finally {
    await fsp.rm(lockPath, { force: true });
  }
}

/** Read and parse every line of the claim log for a workspace (empty if none yet). */
export async function readClaimLog(workspaceId: string): Promise<ClaimLogEntry[]> {
  const logPath = getLogPath(workspaceId);
  let raw: string;
  try {
    raw = await fsp.readFile(logPath, 'utf8');
  } catch (err: any) {
    if (err?.code === 'ENOENT') return [];
    throw err;
  }
  const entries: ClaimLogEntry[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed) as ClaimLogEntry);
    } catch {
      // Skip a torn/partial line (e.g. a write interrupted mid-flush); the
      // append-only log tolerates this — the next valid line still parses.
    }
  }
  return entries;
}

/**
 * Append one claim entry to the workspace's log with the next monotonic `seq`,
 * assigning `seq` under the lockfile so concurrent writers never collide.
 * Returns the stored entry (with `seq` and `logged_at` filled in).
 */
export async function appendClaim(
  workspaceId: string,
  claim: Omit<WorkClaim, 'seq'> & { seq?: number }
): Promise<ClaimLogEntry> {
  const dir = getStoreDir(workspaceId);
  ensureDirSync(dir);
  return withLock(workspaceId, async () => {
    const existing = await readClaimLog(workspaceId);
    const nextSeq = existing.reduce((max, e) => Math.max(max, e.seq), 0) + 1;
    const entry: ClaimLogEntry = {
      ...claim,
      seq: claim.seq ?? nextSeq,
      logged_at: new Date().toISOString(),
    };
    const logPath = getLogPath(workspaceId);
    await fsp.appendFile(logPath, JSON.stringify(entry) + '\n', 'utf8');
    return entry;
  });
}

/** Active (non-expired, status==='active') claims for a workspace, LWW-reduced. */
export async function getActiveClaims(workspaceId: string, nowMs?: number): Promise<WorkClaim[]> {
  const log = await readClaimLog(workspaceId);
  return deriveActiveClaims(log, nowMs ?? Date.now()).filter(
    (c) => c.workspace_id === workspaceId
  );
}

/** Live agent presence roster for a workspace, derived from the active claim set. */
export async function getPresence(workspaceId: string, nowMs?: number): Promise<AgentPresence[]> {
  const log = await readClaimLog(workspaceId);
  return derivePresence(log, workspaceId, nowMs ?? Date.now());
}

function normalizePath(p: string): string {
  return p.replace(/\/+$/, '');
}

function pathsOverlap(a: string, b: string): boolean {
  const na = normalizePath(a);
  const nb = normalizePath(b);
  return na === nb || na.startsWith(nb + '/') || nb.startsWith(na + '/');
}

/** Deterministic claim_id for a given agent's edit-lock on a workspace, so re-announcing updates (not duplicates) the lock. */
function editLockClaimId(workspaceId: string, agentId: string): string {
  return `edit-lock:${workspaceId}:${agentId}`;
}

/**
 * Announce a soft edit-lock: agent `agentId` is about to write `paths`.
 * Implemented as a `WorkClaim` with `intent: 'edit-lock'`. Re-announcing while
 * still active refreshes (supersedes) the same claim_id rather than piling up
 * duplicates — the log stays append-only but `reduceClaimLog` LWW-collapses it.
 */
export async function announceEdit(
  workspaceId: string,
  agentId: string,
  paths: string[],
  options: { agentKind?: WorkClaim['agent_kind']; intent?: string; ttlMs?: number } = {}
): Promise<ClaimLogEntry> {
  const claimId = editLockClaimId(workspaceId, agentId);
  const now = new Date().toISOString();
  return appendClaim(workspaceId, {
    claim_id: claimId,
    workspace_id: workspaceId,
    agent_id: agentId,
    agent_kind: options.agentKind ?? 'other',
    scope: { repo: workspaceId, paths, symbols: [] },
    intent: options.intent ?? 'edit-lock',
    status: 'active',
    created_at: now,
    ttl_ms: options.ttlMs ?? DEFAULT_TTL_MS,
    heartbeat_at: now,
  });
}

/** Release a previously-announced edit-lock for `agentId` (marks it released). */
export async function releaseEdit(workspaceId: string, agentId: string): Promise<ClaimLogEntry> {
  const claimId = editLockClaimId(workspaceId, agentId);
  const log = await readClaimLog(workspaceId);
  const prior = [...log].reverse().find((e) => e.claim_id === claimId);
  const now = new Date().toISOString();
  return appendClaim(workspaceId, {
    claim_id: claimId,
    workspace_id: workspaceId,
    agent_id: agentId,
    agent_kind: prior?.agent_kind ?? 'other',
    scope: prior?.scope ?? { repo: workspaceId, paths: [], symbols: [] },
    intent: prior?.intent ?? 'edit-lock',
    status: 'released',
    created_at: prior?.created_at ?? now,
    ttl_ms: prior?.ttl_ms ?? DEFAULT_TTL_MS,
    heartbeat_at: now,
  });
}

/**
 * Same-machine silent-clobber guard: does any OTHER active agent hold an
 * edit-lock (or any active claim) whose paths path-prefix-overlap `paths`?
 * Pass `excludeAgent` to exclude the calling agent's own claims.
 */
export async function checkEditLock(
  workspaceId: string,
  paths: string[],
  excludeAgent?: string
): Promise<EditLockConflict[]> {
  const active = await getActiveClaims(workspaceId);
  const conflicts: EditLockConflict[] = [];
  for (const claim of active) {
    if (excludeAgent && claim.agent_id === excludeAgent) continue;
    const overlapping: string[] = [];
    for (const p of paths) {
      for (const cp of claim.scope.paths) {
        if (pathsOverlap(p, cp)) overlapping.push(cp);
      }
    }
    if (overlapping.length > 0) {
      conflicts.push({
        agent_id: claim.agent_id,
        claim_id: claim.claim_id,
        paths,
        overlapping_paths: [...new Set(overlapping)],
      });
    }
  }
  return conflicts;
}

/**
 * Change attribution: which active agent(s) currently have a claim/edit-lock
 * touching `path`, and what their stated intent is — answers "who changed this
 * and why" in a shared working tree.
 */
export async function attributeChange(
  workspaceId: string,
  filePath: string
): Promise<ChangeAttribution> {
  const active = await getActiveClaims(workspaceId);
  const attributions: ChangeAttribution['attributions'] = [];
  for (const claim of active) {
    const touches = claim.scope.paths.some((p) => pathsOverlap(p, filePath));
    if (touches) {
      attributions.push({
        agent_id: claim.agent_id,
        claim_id: claim.claim_id,
        intent: claim.intent,
        status: claim.status,
      });
    }
  }
  return { path: filePath, attributions };
}

/**
 * Watch `claims.jsonl` for local-peer activity (sub-second same-machine
 * awareness). Returns an unwatch function. Best-effort: if the file doesn't
 * exist yet, watches the directory instead and starts watching the file once
 * it appears (created by the first `appendClaim`).
 */
export function watch(workspaceId: string, cb: () => void): () => void {
  const dir = getStoreDir(workspaceId);
  ensureDirSync(dir);
  const logFile = 'claims.jsonl';
  let fileWatcher: fs.FSWatcher | undefined;
  const dirWatcher = fs.watch(dir, (_event, filename) => {
    if (filename === logFile && !fileWatcher) {
      try {
        fileWatcher = fs.watch(path.join(dir, logFile), () => cb());
      } catch {
        // race: file vanished between events; next dir event will retry.
      }
    }
    if (filename === logFile) cb();
  });
  try {
    fileWatcher = fs.watch(path.join(dir, logFile), () => cb());
  } catch {
    // log file doesn't exist yet — dirWatcher above will pick it up on create.
  }
  return () => {
    dirWatcher.close();
    fileWatcher?.close();
  };
}
