/**
 * Local tier of the two-tier coordination store (§1.1 SPEC-COORDINATION-FABRIC.md).
 * Same-machine, zero-network: all agents on one host append to a shared,
 * file-backed, append-only claim log at
 * `process.env.KLAURO_COORD_DIR || ~/.klauro/coordination/<workspace_id>/claims.jsonl`.
 *
 * Owns only store/transport concerns (file IO, atomic append, fs.watch); all
 * consistency/derivation logic is delegated to `./presence` and `./arbiter` —
 * nothing here reimplements LWW.
 *
 * Concurrency: each append uses the `a` flag (atomic below the OS pipe buffer
 * size). The monotonic `seq` is assigned under a lightweight lockfile held
 * only for the read-length+append critical section.
 *
 * Must stay O(1) per read at fleet scale: `parsedLogCache` is invalidated by
 * (size, mtimeMs) from a cheap fstat, revalidated against the current on-disk
 * stat on every call (including inside the lock), so a caller never observes a
 * stale log. `compactIfNeeded` bounds on-disk growth: once the log exceeds
 * COMPACT_THRESHOLD_ENTRIES, the next append rewrites it to the LWW-latest
 * entry per claim_id for active claims plus a bounded tail of recent released
 * entries, preserving each entry's original `seq`, inside the same lock-held
 * critical section as the triggering append.
 */

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { deriveActiveClaims, derivePresence, reduceClaimLog } from './presence';
import type { AgentPresence, WorkClaim, WorkClaimStatus } from './types';

/** One line of `claims.jsonl`: a `WorkClaim` plus store-assigned bookkeeping. */
export interface ClaimLogEntry extends WorkClaim {
  /** ISO timestamp the local store received/appended this entry (store-assigned). */
  logged_at: string;
  /**
   * Event kind for this log line. Additive and optional — an absent or
   * unrecognized `kind` must be treated exactly as a plain claim entry, so old
   * readers are unaffected. `'unclaimed-edit'` = a write-hook observation that
   * a path changed under no active claim; `'surprise'` = a contract-divergence
   * finding that passed textual merge. Both are always logged with
   * `status: 'released'` so they can never be picked up as an active claim —
   * pure event-log visibility, not a claim on anything.
   */
  kind?: 'claim' | 'unclaimed-edit' | 'surprise';
  /**
   * Present only when kind === 'surprise'. `agent_id` on the entry is the
   * affected agent (who this surprise is addressed to), matching
   * `unclaimed-edit`'s convention.
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

/**
 * A same-machine edit-lock overlap finding for `checkEditLock`/`extendClaim`.
 * `paths` is the CONFLICTING HOLDER's claimed scope (`claim.scope.paths`) —
 * NOT the proposing caller's own paths — so a fleet sees what the other
 * agent actually claims. `overlapping_paths` is the intersection.
 */
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
/**
 * Lockfile heartbeat/staleness (Coordination Engine wave 1, lockfile hardening).
 * While a lock is HELD, the holder touches (utimes) the lockfile every
 * LOCK_HEARTBEAT_MS; a waiter only reclaims a lock whose mtime is older than
 * LOCK_STALE_MS. The stale window is deliberately >> the heartbeat interval so
 * a long critical section (e.g. a compaction rewrite that takes >5s) can never
 * have its lock stolen mid-operation by a waiter — the pre-hardening failure
 * mode was two writers both inside the section assigning duplicate `seq`.
 * A crashed holder stops heartbeating, so reclaim still happens within
 * LOCK_STALE_MS — liveness is preserved, only theft-under-load is gone.
 */
const LOCK_HEARTBEAT_MS = 1000;
const LOCK_STALE_MS = 15_000; // must stay >> LOCK_HEARTBEAT_MS (see above).

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
  // Heartbeat the lockfile while held: a critical section longer than the old
  // fixed stale window (e.g. a large compaction) previously got its lock
  // reclaimed by a waiter mid-write → two concurrent writers → duplicate seq.
  // Touching mtime every LOCK_HEARTBEAT_MS keeps the lock visibly live for as
  // long as the holder is actually running; `unref()` so a held interval never
  // pins the process open.
  const heartbeat = setInterval(() => {
    const now = new Date();
    void fsp.utimes(lockPath, now, now).catch(() => {
      // lockfile vanished (crash-cleanup raced us) — nothing to keep alive;
      // the finally below tolerates the same condition.
    });
  }, LOCK_HEARTBEAT_MS);
  heartbeat.unref?.();
  try {
    return await fn();
  } finally {
    clearInterval(heartbeat);
    await fsp.rm(lockPath, { force: true });
  }
}

// ---------------------------------------------------------------------------
// Board meta (`board.json` beside `claims.jsonl`) — Coordination Engine wave 1.
// Carries the BOARD EPOCH (minted once, atomically under the workspace lock,
// at board creation: a client whose stored cursor belongs to a different epoch
// resets instead of silently missing everything after a board wipe/reset) and
// the COMPACTION RETENTION FLOOR (`min_retained_seq`: the smallest seq for
// which the log is still complete — a reader whose cursor is below it MISSED
// events and must be told so explicitly, never silence), plus a bounded set of
// evicted surprise ids so `persistSurprise`'s dedup stays consistent with the
// retention floor (eviction must not cause re-append loops).
// ---------------------------------------------------------------------------

export interface BoardMeta {
  /** Board identity, minted at creation. Changes only when the board is destroyed/recreated. */
  epoch: string;
  created_at: string;
  /**
   * Smallest seq S such that every entry with seq >= S is still present in the
   * log (nothing at or above it has been compacted away). 1 for a board that
   * has never evicted anything. Monotonically non-decreasing.
   */
  min_retained_seq: number;
  /**
   * claim_ids of `kind:'surprise'` entries that compaction evicted — kept
   * (bounded) so persistSurprise's dedup check still sees them after they
   * leave the log. Without this, eviction + re-plan = infinite re-append loop.
   */
  evicted_surprise_ids?: string[];
}

const EVICTED_SURPRISE_IDS_MAX = 500;

function getBoardMetaPath(workspaceId: string): string {
  return path.join(getStoreDir(workspaceId), 'board.json');
}

function mintEpoch(): string {
  return `epoch_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

async function readBoardMetaFile(workspaceId: string): Promise<BoardMeta | undefined> {
  try {
    const raw = await fsp.readFile(getBoardMetaPath(workspaceId), 'utf8');
    const parsed = JSON.parse(raw) as Partial<BoardMeta>;
    if (!parsed || typeof parsed.epoch !== 'string') return undefined;
    return {
      epoch: parsed.epoch,
      created_at: typeof parsed.created_at === 'string' ? parsed.created_at : new Date(0).toISOString(),
      min_retained_seq: typeof parsed.min_retained_seq === 'number' ? parsed.min_retained_seq : 1,
      evicted_surprise_ids: Array.isArray(parsed.evicted_surprise_ids) ? parsed.evicted_surprise_ids : undefined,
    };
  } catch {
    return undefined; // absent or unreadable — caller mints under the lock.
  }
}

/** Atomic (tmp+rename) meta write. Must be called while HOLDING the workspace lock. */
async function writeBoardMetaLocked(workspaceId: string, meta: BoardMeta): Promise<void> {
  const metaPath = getBoardMetaPath(workspaceId);
  const tmpPath = `${metaPath}.tmp-${process.pid}-${Date.now()}`;
  await fsp.writeFile(tmpPath, JSON.stringify(meta, null, 2) + '\n', 'utf8');
  await fsp.rename(tmpPath, metaPath);
}

/**
 * Read-or-mint the board meta while HOLDING the workspace lock. Minting under
 * the lock is what makes epoch creation atomic: two racing first-writers both
 * queue on the same lockfile, the first mints, the second re-reads and sees it.
 */
async function ensureBoardMetaLocked(workspaceId: string): Promise<BoardMeta> {
  const existing = await readBoardMetaFile(workspaceId);
  if (existing) return existing;
  const meta: BoardMeta = { epoch: mintEpoch(), created_at: new Date().toISOString(), min_retained_seq: 1 };
  await writeBoardMetaLocked(workspaceId, meta);
  return meta;
}

/**
 * Public read of the board identity + retention floor, minting the meta (under
 * the workspace lock) if this board has never had one — so every response
 * surface can carry `{epoch, seq}` unconditionally. Cheap: one small-file read
 * on the common path; the lock is taken only on first-ever access per board.
 */
export async function getBoardInfo(workspaceId: string): Promise<BoardMeta> {
  const existing = await readBoardMetaFile(workspaceId);
  if (existing) return existing;
  ensureDirSync(getStoreDir(workspaceId));
  return withLock(workspaceId, () => ensureBoardMetaLocked(workspaceId));
}

/**
 * Pure gap-notice helper (compaction delivery floor): a reader resuming from
 * `cursorSeq` against a board whose `min_retained_seq` is above it can no
 * longer be given a complete replay — entries in (cursorSeq, min_retained_seq)
 * may have been compacted away. Returns an explicit human-readable notice
 * (never silence), or undefined when the cursor is safe.
 */
export function describeCursorGap(cursorSeq: number, meta: Pick<BoardMeta, 'min_retained_seq'>): string | undefined {
  if (cursorSeq >= meta.min_retained_seq - 1) return undefined;
  return (
    `missed events since seq ${cursorSeq}: this board has compacted entries below seq ` +
    `${meta.min_retained_seq}, so events in (${cursorSeq}, ${meta.min_retained_seq}) can no longer be replayed. ` +
    `Re-read the full current state instead of resuming from this cursor.`
  );
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
  // WRITER-OWNED per-claim version (see types.ts `WorkClaim.version`): when the
  // caller supplies one (a replicated entry echoing its origin store's version)
  // it is preserved VERBATIM — a receiving store never re-assigns it. When
  // absent, this store IS the writer's store and mints the next monotonic
  // version for this claim_id. Cross-store LWW keys on this, never on seq.
  const nextVersion =
    claim.version ??
    existing.reduce((max, e) => (e.claim_id === claim.claim_id ? Math.max(max, e.version ?? 0) : max), 0) + 1;
  const entry: ClaimLogEntry = {
    ...claim,
    seq: claim.seq ?? nextSeq,
    version: nextVersion,
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
 * Rewrites claims.jsonl to a compacted form once it grows past
 * COMPACT_THRESHOLD_ENTRIES: keeps every currently-active entry (LWW-latest
 * per claim_id) plus COMPACT_KEEP_RELEASED most-recent non-active entries for
 * attribution history. Every kept entry's original seq/logged_at must be
 * preserved verbatim (seq stays monotonic, no renumbering). Must be called
 * only from within the lock-held critical section.
 */
async function compactIfNeeded(
  workspaceId: string,
  existing: ClaimLogEntry[]
): Promise<ClaimLogEntry[]> {
  // Ensure the board epoch exists on every locked write path — minting is
  // atomic here because compactIfNeeded is only ever called under the
  // workspace lock (two racing first-writers serialize on the lockfile).
  const meta = await ensureBoardMetaLocked(workspaceId);
  if (existing.length <= COMPACT_THRESHOLD_ENTRIES) return existing;

  const nowMs = Date.now();
  const activeClaims = deriveActiveClaims(existing, nowMs);
  const activeIds = new Set(activeClaims.map((c) => c.claim_id));
  // DELIVERY-FLOOR PROTECTION: entries ADDRESSED to agents that still hold an
  // active (unexpired) claim are undelivered-in-the-worst-case — the addressee
  // is demonstrably still working and may not have drained them yet. Evicting
  // them would silently destroy addressed events (surprises). Protection is
  // naturally bounded by claim TTL: once the addressee's claims expire or are
  // released, the entries become evictable again on a later compaction.
  const activeAgents = new Set(activeClaims.map((c) => c.agent_id));
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
  const inactive = [...latestById.values()]
    .filter((e) => !activeIds.has(e.claim_id))
    .sort((a, b) => b.seq - a.seq);
  const protectedAddressed = inactive.filter(
    (e) => (e.kind === 'surprise' || e.kind === 'unclaimed-edit') && activeAgents.has(e.agent_id)
  );
  const protectedIds = new Set(protectedAddressed.map((e) => e.claim_id));
  const inactiveEntries = inactive.filter((e) => !protectedIds.has(e.claim_id)).slice(0, COMPACT_KEEP_RELEASED);

  const compacted = [...activeEntries, ...protectedAddressed, ...inactiveEntries].sort((a, b) => a.seq - b.seq);
  if (compacted.length >= existing.length) return existing; // nothing to gain; skip the rewrite.

  // RETENTION FLOOR bookkeeping (must land with the rewrite, same critical
  // section): min_retained_seq = highest evicted seq + 1 — the smallest seq at
  // and above which the log is still complete. Readers below it get an
  // explicit gap notice (describeCursorGap), never silence. Evicted SURPRISE
  // ids are remembered (bounded) so persistSurprise's dedup survives eviction
  // and can't re-append the same finding in a loop.
  const keptSeqs = new Set(compacted.map((e) => e.seq));
  const evicted = existing.filter((e) => !keptSeqs.has(e.seq));
  const maxEvictedSeq = evicted.reduce((max, e) => Math.max(max, e.seq), 0);
  const evictedSurpriseIds = evicted.filter((e) => e.kind === 'surprise').map((e) => e.claim_id);
  const nextMeta: BoardMeta = {
    ...meta,
    min_retained_seq: Math.max(meta.min_retained_seq, maxEvictedSeq + 1),
    evicted_surprise_ids: [...new Set([...(meta.evicted_surprise_ids ?? []), ...evictedSurpriseIds])].slice(
      -EVICTED_SURPRISE_IDS_MAX
    ),
  };

  const logPath = getLogPath(workspaceId);
  const tmpPath = `${logPath}.compact-${process.pid}-${nowMs}`;
  const body = compacted.map((e) => JSON.stringify(e)).join('\n') + (compacted.length > 0 ? '\n' : '');
  await fsp.writeFile(tmpPath, body, 'utf8');
  await fsp.rename(tmpPath, logPath); // atomic on the same filesystem — no window where readers see a truncated file.
  await writeBoardMetaLocked(workspaceId, nextMeta);
  await primeCacheAfterWrite(logPath, compacted);
  return compacted;
}

/**
 * Public escape hatch for callers outside this module that need to compose a
 * read-decide-append(s) sequence as one atomic critical section against the
 * same per-workspace lockfile appendClaim/releaseAgent use — without this, a
 * concurrent requestGrant call could interleave its own read in the gap and
 * let two overlapping grants both see "no conflict" and both get appended.
 * Also runs opportunistic compaction before invoking `fn`.
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
    // THE released_count:0 DEFECT (fabric v3 spec §6.3): selecting via
    // deriveActiveClaims silently EXCLUDED claims whose TTL had lapsed —
    // status still 'active' on the log, merely heartbeat-expired. An agent
    // that worked past its TTL (remote advisory default is 30min; a long lane
    // easily exceeds it) then released got released_count: 0 "for a claim
    // that was definitely made". Release is the agent's authoritative "I am
    // done": it must close out EVERY latest-status-'active' claim the agent
    // holds, expired or not — releasing an expired claim is harmless (it was
    // already invisible to peers) and it makes the record truthful, which
    // outcome records (wave 3) build on. Repro: local-store.test.ts
    // "releaseAgent releases a TTL-expired claim (v3 §6.3 released_count:0)".
    const mine = reduceClaimLog(existing).filter(
      (c) => c.status === 'active' && c.workspace_id === workspaceId && c.agent_id === agentId
    );
    const now = new Date().toISOString();
    const released: ClaimLogEntry[] = [];
    for (const c of mine) {
      const { seq: _priorSeq, version: _priorVersion, ...rest } = c as ClaimLogEntry;
      released.push(
        await appendClaimLocked(workspaceId, { ...rest, status: 'released', heartbeat_at: now }, existing)
      );
    }
    return released;
  });
}

/**
 * Releases exactly one active claim by its exact claim_id, scoped to agentId
 * — never release a claim belonging to someone else just because the id
 * string matched. This is the shared lookup both the advisory claim log and
 * the enforced grant-manager markers live in; a caller passing back an
 * advisory claim's exact id has no matching lookup without this. Returns the
 * released entry, or undefined if no active claim with that exact id (and agent) exists.
 */
export async function releaseClaimById(
  workspaceId: string,
  agentId: string,
  claimId: string
): Promise<ClaimLogEntry | undefined> {
  return withWorkspaceLock(workspaceId, async ({ log, append }) => {
    const nowMs = Date.now();
    // Latest-status-'active' regardless of TTL expiry — same released_count:0
    // fix as releaseAgent (a TTL-expired claim is still the agent's to close).
    const active = reduceClaimLog(log).find(
      (c) => c.status === 'active' && c.workspace_id === workspaceId && c.agent_id === agentId && c.claim_id === claimId
    );
    if (!active) return undefined;
    const now = new Date(nowMs).toISOString();
    // Strip seq AND version so the release entry gets the next writer-owned
    // version (an echoed stale version would LWW-tie with the entry it closes).
    const { seq: _priorSeq, version: _priorVersion, ...rest } = active as ClaimLogEntry;
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
        paths: claim.scope.paths,
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
    // Dedup must be CONSISTENT WITH THE RETENTION FLOOR: the log alone is not
    // enough once compaction can evict delivered surprises — a re-plan after
    // eviction would re-append the same finding forever (append → evict →
    // re-append loop). The board meta's bounded evicted_surprise_ids set keeps
    // the dedup key visible after the entry itself has left the log.
    const meta = await ensureBoardMetaLocked(workspaceId);
    const alreadyLogged =
      existing.some((e) => e.kind === 'surprise' && e.claim_id === claimId) ||
      (meta.evicted_surprise_ids ?? []).includes(claimId);
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
 * Claim extension: appends an LWW-superseding entry under the same claim_id
 * (identity preserved, not replaced) whose scope is the union of the prior
 * scope and addPaths/addSymbols. Conflicts are returned inline, never denied —
 * the extension always succeeds; awareness is never gated. The whole
 * read-decide-append sequence must run under one withWorkspaceLock
 * acquisition so a concurrent extend/claim on the same claim_id cannot
 * interleave an unseen append.
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
          paths: claim.scope.paths,
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

// ---------------------------------------------------------------------------
// Ops guard — coord-dir durability (Coordination Engine wave 1, durable board).
// Root cause of the 2026-07-21 board wipe: the api container never set
// KLAURO_COORD_DIR, so the server's claim log lived at ~/.klauro/coordination
// on the container's EPHEMERAL overlay filesystem while the persistent /data
// volume sat unused — a restart erased the board and reset seq. The compose
// fix is one env var; THIS guard makes the misconfiguration loud instead of
// silent if it ever regresses.
// ---------------------------------------------------------------------------

export interface CoordDirDurabilityReport {
  coord_root: string;
  /** False when the heuristic says the coord dir will not survive a restart. */
  durable: boolean;
  warning?: string;
}

/**
 * Heuristic durability check for the coordination root:
 *  - When a persistent `dataRoot` is configured (the server's data dir, e.g.
 *    the container's mounted /data), the coord root is expected to live UNDER
 *    it — anywhere else (notably the overlay-FS home dir) is flagged.
 *  - Additionally, running inside a container (/.dockerenv) with no
 *    KLAURO_COORD_DIR set means the default home-dir path is overlay-backed —
 *    flagged even when no dataRoot was passed.
 * Pure report; use `warnIfEphemeralCoordDir` to also print loudly.
 */
export function checkCoordDirDurability(options: { dataRoot?: string; isContainer?: boolean } = {}): CoordDirDurabilityReport {
  const coordRoot = path.resolve(getCoordRoot());
  const inContainer = options.isContainer ?? fs.existsSync('/.dockerenv');
  if (options.dataRoot) {
    const dataRoot = path.resolve(options.dataRoot);
    const under = coordRoot === dataRoot || coordRoot.startsWith(dataRoot + path.sep);
    if (!under && inContainer) {
      return {
        coord_root: coordRoot,
        durable: false,
        warning:
          `coordination store at ${coordRoot} is OUTSIDE the configured data root ${dataRoot} and this process ` +
          `is running in a container — the board lives on the ephemeral overlay FS and WILL BE ERASED on ` +
          `restart (claims, seq, epoch). Set KLAURO_COORD_DIR to a path under the data root ` +
          `(e.g. ${path.join(dataRoot, 'coordination')}).`,
      };
    }
    // Outside a container, a coord root off the data root (typically the
    // default ~/.klauro/coordination) is host-durable — not a defect, so no
    // loud warning on every bare-host dev/test run.
    return { coord_root: coordRoot, durable: true };
  }
  if (inContainer && !process.env.KLAURO_COORD_DIR) {
    return {
      coord_root: coordRoot,
      durable: false,
      warning:
        `KLAURO_COORD_DIR is unset in a container: the coordination board defaults to ${coordRoot} on the ` +
        `ephemeral overlay FS and WILL BE ERASED on restart (claims, seq, epoch). Set KLAURO_COORD_DIR to a ` +
        `mounted volume path (e.g. /data/coordination).`,
    };
  }
  return { coord_root: coordRoot, durable: true };
}

/** Run `checkCoordDirDurability` and print any warning LOUDLY (stderr). Returns the report. */
export function warnIfEphemeralCoordDir(
  options: { dataRoot?: string; isContainer?: boolean; print?: (message: string) => void } = {}
): CoordDirDurabilityReport {
  const report = checkCoordDirDurability(options);
  if (!report.durable && report.warning) {
    const print = options.print ?? ((m: string) => console.error(m));
    print(`[coordination/local-store] DURABILITY WARNING: ${report.warning}`);
  }
  return report;
}

/**
 * Test-only: drop every in-memory cache so the next read comes entirely from
 * disk — simulates a fresh process ("server restart") over the same store for
 * boot-sweep regression tests. Never call from production code.
 */
export function __clearCachesForTests(): void {
  parsedLogCache.clear();
}
