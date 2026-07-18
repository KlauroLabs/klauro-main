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
  /**
   * Event kind for this log line (W5, SPEC-COORDINATION-FABRIC-V3 §6.3/§8:
   * write-hook auto-announce). Additive and OPTIONAL — every existing reader
   * of `claims.jsonl` (`reduceClaimLog`/`deriveActiveClaims`/`derivePresence`
   * in `./presence`, `compactIfNeeded` above, and every MCP/CLI surface in
   * server.ts / remote-analyzer-service.ts / fab.ts) was written against
   * `WorkClaim`'s existing fields only and never switches on `kind` — an
   * absent or unrecognized `kind` is silently treated exactly as a plain
   * claim entry, so old code paths are unaffected by this field's existence.
   * Absent (undefined) = a normal claim/edit-lock/release entry (unchanged
   * meaning). `'unclaimed-edit'` = a write-hook observation that a path
   * changed under NO active claim (see `recordUnclaimedEdit` below) — these
   * entries are ALWAYS logged with `status: 'released'` so they can never be
   * picked up by `deriveActiveClaims`/`derivePresence`/`checkEditLock`'s
   * active-claim view; they are a pure event-log record for visibility, not
   * a claim on anything.
   */
  kind?: 'claim' | 'unclaimed-edit' | 'surprise';
  /**
   * Present only when `kind === 'surprise'` (W4 step 2, SPEC-COORDINATION-FABRIC-V3
   * §5/§9 "surprise -> 0" pushed from a metric into an ambient event): a
   * `contract-divergence` finding from `planIntentMergeFromSubstrate` that
   * PASSES textual merge, persisted so the affected participant can learn of
   * it via the log instead of first learning at merge time. Like
   * `unclaimed-edit`, always logged with `status: 'released'` so it can never
   * be picked up as an active claim — pure event-log visibility, not a claim
   * on anything. `agent_id` on the entry is the AFFECTED agent (the one this
   * surprise is addressed to), matching `unclaimed-edit`'s convention of
   * using `agent_id` as "who this event is about."
   */
  surprise?: SurpriseDetail;
}

/**
 * One contract-divergence surprise (W4 step 2): `changer` altered `symbol`'s
 * contract while `affected`'s concurrent, claim/write-hook-attributed edit
 * touches a caller that still assumes the old contract — a finding that
 * passes textual merge, so git would land it silently. Persisted addressed to
 * `affected` (see `ClaimLogEntry.surprise`) so the ambient awareness surface
 * can deliver it without `affected` having to re-run `plan_intent_merge`
 * itself and read `surprises[]` proactively.
 */
export interface SurpriseDetail {
  symbol: string;
  changer: string;
  affected: string;
  explanation: string;
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
  claim: Omit<WorkClaim, 'seq'> & { seq?: number; kind?: ClaimLogEntry['kind']; surprise?: ClaimLogEntry['surprise'] },
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
  fn: (ctx: { log: ClaimLogEntry[]; append: (claim: Omit<WorkClaim, 'seq'> & { seq?: number; kind?: ClaimLogEntry['kind']; surprise?: ClaimLogEntry['surprise'] }) => Promise<ClaimLogEntry> }) => Promise<T>
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
  claim: Omit<WorkClaim, 'seq'> & { seq?: number; kind?: ClaimLogEntry['kind']; surprise?: ClaimLogEntry['surprise'] }
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
 * Release exactly ONE active claim by its EXACT `claim_id`, scoped to
 * `agentId` (defensive: never release a claim that belongs to someone else
 * just because the id string matched). This is the single shared lookup that
 * BOTH the advisory claim log AND the enforced grant-manager markers live in
 * (grant-manager.ts's header: "grants are NOT a new store... appended to the
 * same same-machine claim log local-store.ts already owns") — grant-manager's
 * own `releaseGrant` wraps its `grantId` argument in `grant:<ws>:<id>` before
 * looking it up, which only ever matches claim_ids IT wrote. A caller passing
 * back the exact `claim_id` an ADVISORY claim's response handed them (e.g.
 * `wsp_x:agent_y`, or a caller-supplied custom `claim_id`) has no matching
 * lookup at all today — this fills that gap so a single release-by-id call
 * works regardless of which path originally created the claim, without the
 * caller needing to know or guess which "mode" it was claimed under.
 * Returns the released entry, or `undefined` if no ACTIVE claim with that
 * exact id (and agent) exists (caller decides what "not found" means: already
 * released, expired, wrong id, or — most likely for this exact-id lookup —
 * an enforced-grant id that needs the wrapped form instead).
 */
export async function releaseClaimById(
  workspaceId: string,
  agentId: string,
  claimId: string
): Promise<ClaimLogEntry | undefined> {
  return withWorkspaceLock(workspaceId, async ({ log, append }) => {
    const nowMs = Date.now();
    const active = deriveActiveClaims(log, nowMs).find(
      (c) => c.workspace_id === workspaceId && c.agent_id === agentId && c.claim_id === claimId
    );
    if (!active) return undefined;
    const now = new Date(nowMs).toISOString();
    const { seq: _priorSeq, ...rest } = active;
    return append({ ...rest, status: 'released', heartbeat_at: now });
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
 * Record that `path` changed on disk with NO active claim covering it (W5,
 * SPEC-COORDINATION-FABRIC-V3 §6.3/§8: "when the changed path is covered by
 * NO active claim, record an 'unclaimed-edit' event ... so drift is VISIBLE
 * the moment it happens instead of at merge"). This is a pure event-log
 * record, never a claim: `status` is always `'released'` and `kind` is always
 * `'unclaimed-edit'`, so it can never be picked up by
 * `deriveActiveClaims`/`derivePresence`/`checkEditLock` — those keep behaving
 * exactly as before this function existed. `claim_id` includes a timestamp +
 * random suffix (unlike every other claim_id scheme in this module) because
 * each occurrence is its own history entry, not something later occurrences
 * should LWW-supersede — a fleet needs to see EVERY unclaimed edit to `path`,
 * not just the latest.
 */
export async function recordUnclaimedEdit(
  workspaceId: string,
  changedPath: string,
  options: { detectedBy?: string } = {}
): Promise<ClaimLogEntry> {
  const now = new Date().toISOString();
  return appendClaim(workspaceId, {
    claim_id: `unclaimed-edit:${workspaceId}:${changedPath}:${now}:${Math.random().toString(36).slice(2, 8)}`,
    workspace_id: workspaceId,
    agent_id: options.detectedBy ?? 'unknown',
    agent_kind: 'other',
    scope: { repo: workspaceId, paths: [changedPath], symbols: [] },
    intent: 'unclaimed-edit',
    status: 'released',
    created_at: now,
    ttl_ms: 0,
    heartbeat_at: now,
    kind: 'unclaimed-edit',
  });
}

/** Deterministic claim_id for a surprise, so re-planning the same finding
 *  DEDUPES against the log instead of appending a duplicate every time
 *  `plan_intent_merge` re-runs (unlike `recordUnclaimedEdit`'s
 *  timestamp-suffixed id, which deliberately wants every occurrence visible —
 *  a surprise is the same fact re-observed, not a new event each time). */
function surpriseClaimId(workspaceId: string, detail: Pick<SurpriseDetail, 'symbol' | 'changer' | 'affected'>): string {
  return `surprise:${workspaceId}:${detail.symbol}:${detail.changer}:${detail.affected}`;
}

/**
 * Persist a `contract-divergence` surprise (W4 step 2, SPEC-COORDINATION-FABRIC-V3
 * §5/§9) to the claim log, addressed to `detail.affected`, so that participant
 * learns of it ambiently instead of first at merge time — "kills
 * learn-at-merge-time." Deduped by `(symbol, changer, affected)`: if this
 * exact finding was already persisted (any time in the log's history — the
 * dedup check reads the FULL log, not just active entries), this is a no-op
 * and returns `null` rather than appending a duplicate on every re-plan.
 * Never a claim: always `status: 'released'`, `kind: 'surprise'`.
 */
export async function persistSurprise(
  workspaceId: string,
  detail: SurpriseDetail
): Promise<ClaimLogEntry | null> {
  const dir = getStoreDir(workspaceId);
  ensureDirSync(dir);
  return withLock(workspaceId, async () => {
    let existing = await readClaimLog(workspaceId);
    existing = await compactIfNeeded(workspaceId, existing);
    const claimId = surpriseClaimId(workspaceId, detail);
    const alreadyLogged = existing.some((e) => e.kind === 'surprise' && e.claim_id === claimId);
    if (alreadyLogged) return null;

    const now = new Date().toISOString();
    return appendClaimLocked(
      workspaceId,
      {
        claim_id: claimId,
        workspace_id: workspaceId,
        agent_id: detail.affected,
        agent_kind: 'other',
        scope: { repo: workspaceId, paths: [], symbols: [detail.symbol] },
        intent: `surprise: ${detail.explanation}`,
        status: 'released',
        created_at: now,
        ttl_ms: 0,
        heartbeat_at: now,
        kind: 'surprise',
        surprise: detail,
      },
      existing
    );
  });
}

/**
 * Every surprise currently persisted for `agentId` in `workspaceId` — the
 * ambient-delivery read side of `persistSurprise`. Reads the full log (a
 * surprise is never superseded/expired the way an active claim is; once
 * persisted, it stays visible history), filters to `kind === 'surprise'`
 * entries addressed to `agentId`.
 */
export async function readSurprisesFor(workspaceId: string, agentId: string): Promise<SurpriseDetail[]> {
  const log = await readClaimLog(workspaceId);
  return log
    .filter((e): e is ClaimLogEntry & { surprise: SurpriseDetail } => e.kind === 'surprise' && e.agent_id === agentId && !!e.surprise)
    .map((e) => e.surprise);
}

/** Result of `releaseAgentWithReason`: the released entries, plus (only when
 *  nothing was released) an explicit, never-silent reason why. */
export interface ReleaseOutcome {
  released: ClaimLogEntry[];
  /**
   * Present ONLY when `released.length === 0` (W5, SPEC-COORDINATION-FABRIC-V3
   * §6.3/§8 "fixing the release/complete semantics defect", carried over from
   * v2 §6 finding #4 / v3 §6.3 `released_count: 0`). `releaseAgent` itself is
   * already race-safe and truthful about WHICH claims it released (see the
   * module header SCALE note + the `releaseAgent race-safe` test) — the
   * remaining defect is that a caller-facing `released_count: 0` is
   * ambiguous: it could mean "already released" (legitimate no-op, e.g. a
   * double-release), "never claimed anything here" (also legitimate), or
   * "you targeted the wrong workspace_id and the real claim is active
   * elsewhere" (the silent-failure mode `findAgentInOtherWorkspaces` exists
   * to catch). This function distinguishes all three so `released_count: 0`
   * is NEVER returned to a caller without an explanation attached.
   */
  reason?: string;
}

/**
 * `releaseAgent`, plus an explicit `reason` whenever `released.length === 0`
 * — never a silent zero. Callers that need to distinguish "nothing to
 * release" from "you're looking in the wrong workspace" (server.ts's
 * `fab_release_work` MCP tool, remote-analyzer-service.ts's
 * `/v1/coordination/release`, `fab.ts release`) should call this instead of
 * `releaseAgent` directly and surface `reason` in their response. Does not
 * change `releaseAgent`'s own behavior or return shape — purely additive.
 */
export async function releaseAgentWithReason(
  workspaceId: string,
  agentId: string
): Promise<ReleaseOutcome> {
  const released = await releaseAgent(workspaceId, agentId);
  if (released.length > 0) return { released };

  const log = await readClaimLog(workspaceId);
  const everClaimedHere = log.some((e) => e.workspace_id === workspaceId && e.agent_id === agentId);
  if (!everClaimedHere) {
    const elsewhere = await findAgentInOtherWorkspaces(agentId, workspaceId);
    return {
      released,
      reason:
        elsewhere.length > 0
          ? `No claim was ever recorded for agent "${agentId}" in workspace "${workspaceId}", but it IS active under: ${elsewhere.join(', ')}. This usually means a workspace-id mismatch ($FAB_WS / .klaurorc fabric.workspace / KLAURO_COORD_DIR) — the real claim is still active and unreleased there.`
          : `No claim was ever recorded for agent "${agentId}" in workspace "${workspaceId}" — nothing to release.`,
    };
  }
  return {
    released,
    reason: `Agent "${agentId}" has no ACTIVE claims left in workspace "${workspaceId}" (already released, superseded, or TTL-expired) — this release is a no-op, not an error.`,
  };
}

/**
 * W6 — scoped primitives (SPEC-COORDINATION-FABRIC-V3 §6.3/§8: "diff/isolate
 * ONLY my claimed paths, so participants never reach for `git stash`"). Direct
 * answer to the stash-clobber incident (§6.3/§3.2): one agent's tree-global
 * `git stash` swept a peer's uncommitted edits because git has no concept of
 * "whose paths these are" — only the fabric's claim log does. `planScopedGitOp`
 * is the pure lookup a CLI verb (`fab diff`/`fab stash`, scripts/fab.ts) uses to
 * find the SAFE scope for a git operation instead of defaulting to the whole
 * tree: the union of `agentId`'s own active claim paths, plus every OTHER active
 * agent's claims (so the caller can decide what a whole-tree fallback would put
 * at risk). Read-only — takes no claim, never blocks; the CLI verb decides what
 * to do with the plan (§2: awareness, never enforcement).
 */
export interface ScopedGitOpPlan {
  /** Union of `agentId`'s own active claim paths — the safe scope for a git op. Empty if the agent holds no active claim. */
  paths: string[];
  /** Every OTHER active agent's claims at decision time (what a whole-tree op would put at risk). */
  peers: WorkClaim[];
}

export async function planScopedGitOp(workspaceId: string, agentId: string): Promise<ScopedGitOpPlan> {
  const active = await getActiveClaims(workspaceId);
  const paths = [...new Set(active.filter((c) => c.agent_id === agentId).flatMap((c) => c.scope.paths))];
  const peers = active.filter((c) => c.agent_id !== agentId);
  return { paths, peers };
}

/**
 * W6 — tree-global-op warning (SPEC-COORDINATION-FABRIC-V3 §6.3/§8). Fires
 * (returns non-empty `peers`, and prints via `print`) only when OTHER agents
 * currently hold active claims — i.e. only when a tree-global git operation
 * (`git stash`/`checkout`/`reset`/`clean` with no pathspec) could actually
 * clobber someone else's uncommitted work. This is an AWARENESS affordance,
 * never a block (§2 "informed concurrency"): it always returns normally and
 * never throws or prevents the caller from proceeding; the caller (a `fab`
 * verb, or any tree-global git wrapper) decides what to do with the warning.
 * Exported from `write-hook.ts` too (its "public surface") so any tree-global
 * wrapper that already imports write-hook helpers can reach this without a
 * second import of local-store.
 */
export async function warnIfTreeGlobalOp(
  workspaceId: string,
  agentId: string,
  options: { print?: (message: string) => void } = {}
): Promise<{ peers: WorkClaim[] }> {
  const active = await getActiveClaims(workspaceId);
  const peers = active.filter((c) => c.agent_id !== agentId);
  if (peers.length > 0) {
    const print = options.print ?? ((m: string) => console.error(m));
    print(
      `WARNING: ${peers.length} other agent(s) hold active claims on this tree — a tree-global git operation ` +
        `(stash/checkout/reset/clean with no pathspec) can sweep up their uncommitted work: ` +
        peers.map((p) => `${p.agent_id} (${p.intent}) -> ${JSON.stringify(p.scope.paths)}`).join('; ') +
        `. Advisory only — never a block — but scope the operation to your own claimed paths where possible.`
    );
  }
  return { peers };
}

/**
 * W7 — claim extension (SPEC-COORDINATION-FABRIC-V3 §6.3/§8: "I also need to
 * touch X — safe?"). Direct answer to the incident where an agent doing the
 * CORRECT fix needed 3 files outside its declared claim, with no affordance to
 * extend scope — it either under-fixed or went dark. Appends an LWW-superseding
 * entry under the SAME `claim_id` (so the claim's identity — who, what, since
 * when — is preserved, not replaced) whose `scope` is the UNION of the prior
 * scope and `addPaths`/`addSymbols`. Runs the identical overlap scan `appendClaim`
 * callers already run before claiming (belt-and-suspenders): conflicts are
 * returned INLINE, never denied — the extension always succeeds (§2/§4: awareness
 * is never gated). The whole read-decide-append sequence runs under ONE
 * `withWorkspaceLock` acquisition (same reasoning as `releaseAgent`'s own
 * comment above) so a concurrent extend/claim on the identical `claim_id`
 * cannot interleave an unseen append between this call's read and its append.
 */
export async function extendClaim(
  workspaceId: string,
  claimId: string,
  addPaths: string[],
  addSymbols: string[] = []
): Promise<{ claim: ClaimLogEntry; conflicts: EditLockConflict[] }> {
  return withWorkspaceLock(workspaceId, async ({ log, append }) => {
    const nowMs = Date.now();
    const activeSet = deriveActiveClaims(log, nowMs);
    const prior = activeSet.find((c) => c.workspace_id === workspaceId && c.claim_id === claimId);
    if (!prior) {
      throw new Error(
        `extendClaim: no ACTIVE claim "${claimId}" in workspace "${workspaceId}" — nothing to extend ` +
          `(already released/superseded/expired, or never claimed).`
      );
    }

    const mergedPaths = [...new Set([...prior.scope.paths, ...addPaths])];
    const mergedSymbols = [...new Set([...prior.scope.symbols, ...addSymbols])];

    // Same overlap scan `checkEditLock` runs — but ONLY against the newly
    // ADDED scope (the prior scope was already scanned when it was first
    // claimed/extended; re-flagging it here would just be noise on every
    // heartbeat/re-extend).
    const conflicts: EditLockConflict[] = [];
    for (const claim of activeSet) {
      if (claim.agent_id === prior.agent_id) continue;
      const overlapping: string[] = [];
      for (const p of addPaths) {
        for (const cp of claim.scope.paths) {
          if (pathsOverlap(p, cp)) overlapping.push(cp);
        }
      }
      if (overlapping.length > 0) {
        conflicts.push({
          agent_id: claim.agent_id,
          claim_id: claim.claim_id,
          paths: addPaths,
          overlapping_paths: [...new Set(overlapping)],
        });
      }
    }

    const now = new Date().toISOString();
    const entry = await append({
      claim_id: claimId,
      workspace_id: workspaceId,
      agent_id: prior.agent_id,
      agent_kind: prior.agent_kind,
      scope: { ...prior.scope, paths: mergedPaths, symbols: mergedSymbols },
      intent: prior.intent,
      status: 'active',
      created_at: prior.created_at,
      ttl_ms: prior.ttl_ms,
      heartbeat_at: now,
      base_commit: prior.base_commit,
      branch: prior.branch,
      org_id: prior.org_id,
    });
    return { claim: entry, conflicts };
  });
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
