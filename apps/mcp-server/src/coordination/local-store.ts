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
 *
 * SCALE (100-200+ concurrent agents, docs/SPEC-GIANT-FLEET.md): two bottlenecks
 * were measured (fabric-fleet-stress.ts at N=100/200 before this change: p50
 * 1068ms/3714ms, p99 3184ms/9796ms, and 33 hard lock-timeout errors at N=200)
 * and fixed here:
 *
 * 1. **Full-log re-parse on every read.** `readClaimLog` used to
 *    `fsp.readFile` + `JSON.parse` every line, on EVERY call — including every
 *    call made INSIDE the lock-held critical section of `requestGrant`/
 *    `releaseGrant`/`getGrants` (via `withWorkspaceLock`). As the log grows,
 *    this makes each critical section O(n), so total lock-hold time across N
 *    operations trends toward O(n^2). Fixed with a process-local cache
 *    (`parsedLogCache`), keyed by absolute log path, invalidated by
 *    `(size, mtimeMs)` from a cheap `fstat` — a change to the file (this
 *    process's own append, or a sibling process's) is detected and the file
 *    is re-read; otherwise the cached, already-parsed array is returned in
 *    O(1). This is safe under `withWorkspaceLock` because the cache is
 *    revalidated against the CURRENT on-disk stat every time `readClaimLog`
 *    is called, including inside the lock — a caller can never observe a log
 *    older than what's actually on disk at call time; the cache only saves
 *    re-parsing bytes that provably haven't changed.
 * 2. **Unbounded log growth.** `claims.jsonl` only ever grew (append-only),
 *    so both the per-call parse cost AND the on-disk file size grow without
 *    bound over a long-running fleet session. Fixed with `compactIfNeeded`:
 *    once the log exceeds `COMPACT_THRESHOLD_ENTRIES`, the NEXT append (which
 *    already holds the lock and already has the full log in memory) rewrites
 *    the file to just the LWW-latest entry per `claim_id` for claims that are
 *    still `active` (grant/queue markers not yet released/expired) plus a
 *    bounded tail of the most-recent `released` entries (kept for
 *    attribution/debugging), dropping the rest of the released/superseded
 *    history. Compaction preserves each entry's original `seq` (so ordering
 *    and "distinct monotonic seq" guarantees are undisturbed) and runs inside
 *    the SAME lock-held critical section as the triggering append, so it can
 *    never race a concurrent reader/writer.
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

/** Compact once the log exceeds this many entries (tunable via env for testing/tuning). */
const COMPACT_THRESHOLD_ENTRIES = Number(process.env.KLAURO_COORD_COMPACT_THRESHOLD || 500);
/** How many most-recent `released`/terminal entries to retain post-compaction (attribution/debug history). */
const COMPACT_KEEP_RELEASED = Number(process.env.KLAURO_COORD_COMPACT_KEEP_RELEASED || 50);

/** Root directory for one workspace's local coordination store. */
export function getStoreDir(workspaceId: string): string {
  const base = process.env.KLAURO_COORD_DIR || path.join(os.homedir(), '.klauro', 'coordination');
  return path.join(base, workspaceId);
}

function getLogPath(workspaceId: string): string {
  return path.join(getStoreDir(workspaceId), 'claims.jsonl');
}

/** Root directory containing ALL workspaces' coordination stores (parent of `getStoreDir`). */
function getCoordRoot(): string {
  return process.env.KLAURO_COORD_DIR || path.join(os.homedir(), '.klauro', 'coordination');
}

/**
 * Diagnostic for the "release found nothing" case: is `agentId` actually
 * active under some OTHER workspace_id at this same `KLAURO_COORD_DIR`? This
 * is how a wrong-`FAB_WS`/wrong-`KLAURO_COORD_DIR` mistake gets caught instead
 * of silently reported as "released 0 claims" (indistinguishable from
 * legitimately having nothing left to release). Best-effort: scans sibling
 * workspace directories under the same coordination root.
 */
export async function findAgentInOtherWorkspaces(
  agentId: string,
  excludeWorkspaceId: string
): Promise<string[]> {
  const root = getCoordRoot();
  let dirents: string[];
  try {
    dirents = (await fsp.readdir(root, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const wsId of dirents) {
    if (wsId === excludeWorkspaceId) continue;
    const active = await getActiveClaims(wsId);
    if (active.some((c) => c.agent_id === agentId)) found.push(wsId);
  }
  return found;
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
 *
 * IMPORTANT for callers composing multi-step read-decide-append sequences
 * (e.g. grant-manager.ts's requestGrant/releaseGrant/advanceQueue): a
 * SEPARATE `withLock` acquisition per step does NOT make the overall sequence
 * atomic — two concurrent callers can each pass their own read-decide step
 * before either appends, both observing "no conflict yet" and both being
 * granted overlapping scope. Use the exported `withWorkspaceLock` to wrap the
 * ENTIRE read + decide + append(s) sequence in one lock acquisition instead.
 */
async function withLock<T>(workspaceId: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = getLockPath(workspaceId);
  const deadline = Date.now() + 20_000;
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
      // Jittered backoff, capped, so contention among many waiters (100-200
      // agents) doesn't degenerate into thundering-herd retries all firing at
      // once — a fixed small jitter window (10-30ms) is fine at N<=64 but at
      // N=200 the constant retry rate outpaces how fast the holder can cycle
      // through the queue, so the average waiter's poll interval should grow
      // mildly with contention. Kept intentionally simple (bounded linear
      // jitter, not full exponential backoff) since the critical section
      // itself was shrunk toward O(1) below — the deeper fix is making the
      // lock be held for less time, not making waiters poll more patiently.
      await new Promise((r) => setTimeout(r, 5 + Math.random() * 15));
    }
  }
  try {
    return await fn();
  } finally {
    await fsp.rm(lockPath, { force: true });
  }
}

// ---------------------------------------------------------------------------
// Parsed-log cache: avoid re-reading + re-JSON.parsing the entire file on
// every readClaimLog call (see module header SCALE note #1).
// ---------------------------------------------------------------------------

interface CachedLog {
  size: number;
  mtimeMs: number;
  entries: ClaimLogEntry[];
}

const parsedLogCache = new Map<string, CachedLog>();

function parseLogText(raw: string): ClaimLogEntry[] {
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

/** Read and parse every line of the claim log for a workspace (empty if none yet). */
export async function readClaimLog(workspaceId: string): Promise<ClaimLogEntry[]> {
  const logPath = getLogPath(workspaceId);
  let stat: fs.Stats;
  try {
    stat = await fsp.stat(logPath);
  } catch (err: any) {
    if (err?.code === 'ENOENT') {
      parsedLogCache.delete(logPath);
      return [];
    }
    throw err;
  }

  const cached = parsedLogCache.get(logPath);
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
    // Return a fresh array copy — callers (e.g. appendClaimLocked's `existing`
    // in-lock snapshot) push into what they get back, and must never mutate
    // the shared cached array as a side effect of doing so.
    return cached.entries.slice();
  }

  let raw: string;
  try {
    raw = await fsp.readFile(logPath, 'utf8');
  } catch (err: any) {
    if (err?.code === 'ENOENT') {
      parsedLogCache.delete(logPath);
      return [];
    }
    throw err;
  }
  const entries = parseLogText(raw);
  // Re-stat isn't strictly necessary (a concurrent writer between our stat and
  // readFile would just mean we cache against a slightly stale (size,mtime)
  // pair and re-read again next call — never wrong, only occasionally an
  // extra read), so caching the stat we already have keeps this cheap.
  parsedLogCache.set(logPath, { size: stat.size, mtimeMs: stat.mtimeMs, entries });
  return entries.slice();
}

/** Invalidate the cache entry for a workspace (used after a compaction rewrite
 *  or whenever this process is about to observe a size/mtime it can't trust
 *  its own optimistic bookkeeping for). */
function invalidateCache(workspaceId: string): void {
  parsedLogCache.delete(getLogPath(workspaceId));
}

/** Update the cache directly after this process's own write, from the stat we
 *  already have in hand (avoids one extra `fstat` round-trip on the very next
 *  `readClaimLog` call in the same critical section). */
async function primeCacheAfterWrite(logPath: string, entries: ClaimLogEntry[]): Promise<void> {
  try {
    const stat = await fsp.stat(logPath);
    parsedLogCache.set(logPath, { size: stat.size, mtimeMs: stat.mtimeMs, entries: entries.slice() });
  } catch {
    // best-effort; a miss here just means the next readClaimLog re-reads.
  }
}

/**
 * Append one entry to the log while already holding the workspace lock.
 * Internal — callers must be running inside `withLock`/`withWorkspaceLock`.
 * Factored out so multi-entry operations (like `releaseAgent`) can read the
 * log, decide what to append, and append — all under one lock acquisition,
 * with no gap in which a concurrent process's append can land unseen.
 */
async function appendClaimLocked(
  workspaceId: string,
  claim: Omit<WorkClaim, 'seq'> & { seq?: number },
  existing: ClaimLogEntry[]
): Promise<ClaimLogEntry> {
  const nextSeq = existing.reduce((max, e) => Math.max(max, e.seq), 0) + 1;
  const entry: ClaimLogEntry = {
    ...claim,
    seq: claim.seq ?? nextSeq,
    logged_at: new Date().toISOString(),
  };
  const logPath = getLogPath(workspaceId);
  // Defend against a prior crash-mid-write leaving a torn (unterminated) final
  // line on disk: if we blindly append `JSON.stringify(entry) + '\n'`, our
  // bytes land glued onto the tail of that dangling fragment, producing ONE
  // unparseable line that swallows THIS append too (readClaimLog skips the
  // whole merged line) — a single crash can silently cascade into losing every
  // subsequent claim until someone manually truncates the file. Repro:
  // local-store.test.ts "appendClaim recovers after a torn trailing line left
  // by a mid-write crash". Guard: if the file exists and its last byte isn't
  // already a newline, prefix our write with one so the torn fragment stays
  // isolated on its own (still-unparseable, but no longer corrupts new data).
  let prefix = '';
  try {
    const fd = await fsp.open(logPath, 'r');
    try {
      const { size } = await fd.stat();
      if (size > 0) {
        const buf = Buffer.alloc(1);
        await fd.read(buf, 0, 1, size - 1);
        if (buf[0] !== 0x0a /* '\n' */) prefix = '\n';
      }
    } finally {
      await fd.close();
    }
  } catch (err: any) {
    if (err?.code !== 'ENOENT') throw err;
    // file doesn't exist yet — no prefix needed, appendFile will create it.
  }
  await fsp.appendFile(logPath, prefix + JSON.stringify(entry) + '\n', 'utf8');
  existing.push(entry); // keep the in-lock snapshot current for subsequent appends in this critical section
  await primeCacheAfterWrite(logPath, existing);
  return entry;
}

/**
 * Rewrite `claims.jsonl` to a compacted form once it grows past
 * `COMPACT_THRESHOLD_ENTRIES` (module header SCALE note #2). Keeps:
 *   - every entry that is currently `active` (LWW-latest per claim_id) — this
 *     includes both real grants/edit-locks AND queued grant-manager markers,
 *     since both must remain visible for `deriveActiveClaims`/queue-advance
 *     to keep working exactly as before;
 *   - the `COMPACT_KEEP_RELEASED` most-recent non-active (released/expired)
 *     entries, purely for attribution/debug history — dropping the rest.
 * Every KEPT entry's original `seq` and `logged_at` are preserved verbatim,
 * so `seq` stays monotonic (no renumbering) and nothing downstream that reads
 * `seq`/`logged_at` can observe a difference from the uncompacted log, other
 * than older fully-superseded/released noise no longer being present.
 * MUST be called only from within the lock-held critical section (same
 * constraint as `appendClaimLocked`) — returns the (possibly unchanged) log
 * array to use for the remainder of that critical section.
 */
async function compactIfNeeded(
  workspaceId: string,
  existing: ClaimLogEntry[]
): Promise<ClaimLogEntry[]> {
  if (existing.length <= COMPACT_THRESHOLD_ENTRIES) return existing;

  const nowMs = Date.now();
  const activeIds = new Set(deriveActiveClaims(existing, nowMs).map((c) => c.claim_id));
  // LWW-latest entry per claim_id (mirrors reduceClaimLog's own tie-break),
  // since a compacted log must still resolve to the identical active-set on
  // its next read — we're only trimming SUPERSEDED history, never rewriting
  // the outcome.
  const latestById = new Map<string, ClaimLogEntry>();
  for (const e of existing) {
    const prior = latestById.get(e.claim_id);
    if (!prior || e.seq > prior.seq) latestById.set(e.claim_id, e);
  }
  const activeEntries = [...latestById.values()].filter((e) => activeIds.has(e.claim_id));
  const inactiveEntries = [...latestById.values()]
    .filter((e) => !activeIds.has(e.claim_id))
    .sort((a, b) => b.seq - a.seq)
    .slice(0, COMPACT_KEEP_RELEASED);

  const compacted = [...activeEntries, ...inactiveEntries].sort((a, b) => a.seq - b.seq);
  if (compacted.length >= existing.length) return existing; // nothing to gain; skip the rewrite.

  const logPath = getLogPath(workspaceId);
  const tmpPath = `${logPath}.compact-${process.pid}-${nowMs}`;
  const body = compacted.map((e) => JSON.stringify(e)).join('\n') + (compacted.length > 0 ? '\n' : '');
  await fsp.writeFile(tmpPath, body, 'utf8');
  await fsp.rename(tmpPath, logPath); // atomic on the same filesystem — no window where readers see a truncated file.
  await primeCacheAfterWrite(logPath, compacted);
  return compacted;
}

/**
 * Public escape hatch for callers OUTSIDE this module that need to compose a
 * read-decide-append(s) sequence as ONE atomic critical section against the
 * same per-workspace lockfile `appendClaim`/`releaseAgent` use — e.g.
 * grant-manager.ts's `requestGrant` must read the active-grant set, decide
 * whether the requested scope conflicts, and append the grant/queue entry,
 * all without a concurrent `requestGrant` call being able to interleave its
 * own read in the gap (which would let two overlapping grants both see "no
 * conflict" and both get appended — the exact invariant this fabric exists to
 * enforce). `fn` receives the current log (safe to append to logically; use
 * `appendClaimWithLog` to actually persist an entry and keep the passed-in
 * array current for any further appends within the same `fn` call).
 *
 * Also runs opportunistic compaction (module header SCALE note #2) BEFORE
 * invoking `fn`, so the log a caller reasons over inside its critical section
 * is already trimmed — keeping both the read-cost and the lock-hold time for
 * every subsequent operation bounded instead of growing with total fleet
 * history.
 */
export async function withWorkspaceLock<T>(
  workspaceId: string,
  fn: (ctx: { log: ClaimLogEntry[]; append: (claim: Omit<WorkClaim, 'seq'> & { seq?: number }) => Promise<ClaimLogEntry> }) => Promise<T>
): Promise<T> {
  const dir = getStoreDir(workspaceId);
  ensureDirSync(dir);
  return withLock(workspaceId, async () => {
    let log = await readClaimLog(workspaceId);
    log = await compactIfNeeded(workspaceId, log);
    const append = (claim: Omit<WorkClaim, 'seq'> & { seq?: number }) => appendClaimLocked(workspaceId, claim, log);
    return fn({ log, append });
  });
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
    let existing = await readClaimLog(workspaceId);
    existing = await compactIfNeeded(workspaceId, existing);
    return appendClaimLocked(workspaceId, claim, existing);
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
 * Release EVERY active claim held by `agentId` — by `agent_id`, regardless of
 * claim_id scheme (a `claim`ed work-claim `<ws>:<agent>`, an `announce`d
 * edit-lock `edit-lock:<ws>:<agent>`, or anything else). "An agent finished /
 * `fab.ts release <agent>`" both mean "drop all my claims"; the old path only
 * released the edit-lock id, so `claim`ed work lingered as active until TTL and
 * polluted the awareness view (and produced false overlap conflicts against a
 * peer that was actually done). Returns the released entries (empty if the
 * agent held nothing active).
 */
export async function releaseAgent(workspaceId: string, agentId: string): Promise<ClaimLogEntry[]> {
  const dir = getStoreDir(workspaceId);
  ensureDirSync(dir);
  // CRITICAL: read-the-active-set, decide-what's-mine, and append-the-releases
  // must happen under ONE lock acquisition. Doing the read outside the lock
  // (as a plain `getActiveClaims` call followed by separate `appendClaim`
  // calls) left a window where a concurrent `claim` append — in flight but not
  // yet on disk when this function took its snapshot — would be invisible to
  // `mine`, so nothing for that claim_id got released. The claim then landed
  // AFTER this call returned "released N claims", leaving it active until TTL
  // with `fab.ts release` having already reported success. Repro:
  // local-store.test.ts "releaseAgent is race-safe against a concurrent
  // appendClaim for the same agent".
  return withLock(workspaceId, async () => {
    let existing = await readClaimLog(workspaceId);
    existing = await compactIfNeeded(workspaceId, existing);
    const active = deriveActiveClaims(existing, Date.now()).filter(
      (c) => c.workspace_id === workspaceId && c.agent_id === agentId
    );
    const now = new Date().toISOString();
    const released: ClaimLogEntry[] = [];
    for (const c of active) {
      const { seq: _priorSeq, ...rest } = c;
      released.push(
        await appendClaimLocked(workspaceId, { ...rest, status: 'released', heartbeat_at: now }, existing)
      );
    }
    return released;
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
