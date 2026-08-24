























import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import type { DeclaredContractDriftFinding } from './collision';
import { contractIdentity, MAX_CONSUMES_PER_CLAIM, mergeContracts } from './contract-intent';
import { deriveActiveClaims, derivePresence, reduceClaimLog } from './presence';
import type { AgentPresence, ConceptualCoordinate, DeclaredContract, WorkClaim, WorkClaimStatus } from './types';


export interface ClaimLogEntry extends WorkClaim {

  logged_at: string;









  kind?: 'claim' | 'unclaimed-edit' | 'ambiguous-edit' | 'surprise';
  candidate_agent_ids?: string[];





  surprise?: SurpriseDetail;
}










export interface SurpriseDetail {
  symbol: string;
  changer: string;
  affected: string;
  explanation: string;






  contract?: string;








  reason?: 'declared_contract_drift' | 'declared_contract_missing';

  confidence?: 'path_qualified' | 'name_only';
}







export interface EditLockConflict {
  agent_id: string;
  claim_id: string;
  paths: string[];
  overlapping_paths: string[];
}


export interface ChangeAttribution {
  path: string;
  attributions: Array<{
    agent_id: string;
    claim_id: string;
    intent: string;
    status: WorkClaimStatus;
  }>;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000;











const LOCK_HEARTBEAT_MS = 1000;
const LOCK_STALE_MS = 15_000;


const COMPACT_THRESHOLD_ENTRIES = Number(process.env.KLAURO_COORD_COMPACT_THRESHOLD || 500);

const COMPACT_KEEP_RELEASED = Number(process.env.KLAURO_COORD_COMPACT_KEEP_RELEASED || 50);


export function getStoreDir(workspaceId: string): string {
  const base = process.env.KLAURO_COORD_DIR || path.join(os.homedir(), '.klauro', 'coordination');
  return path.join(base, workspaceId);
}

function getLogPath(workspaceId: string): string {
  return path.join(getStoreDir(workspaceId), 'claims.jsonl');
}


function getCoordRoot(): string {
  return process.env.KLAURO_COORD_DIR || path.join(os.homedir(), '.klauro', 'coordination');
}









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

      try {
        const stat = await fsp.stat(lockPath);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          await fsp.rm(lockPath, { force: true });
          continue;
        }
      } catch {

      }
      if (Date.now() > deadline) {
        throw new Error(`local-store: timed out acquiring lock at ${lockPath}`);
      }









      await new Promise((r) => setTimeout(r, 5 + Math.random() * 15));
    }
  }






  const heartbeat = setInterval(() => {
    const now = new Date();
    void fsp.utimes(lockPath, now, now).catch(() => {


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













export interface BoardMeta {

  epoch: string;
  created_at: string;





  min_retained_seq: number;





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
    return undefined;
  }
}


async function writeBoardMetaLocked(workspaceId: string, meta: BoardMeta): Promise<void> {
  const metaPath = getBoardMetaPath(workspaceId);
  const tmpPath = `${metaPath}.tmp-${process.pid}-${Date.now()}`;
  await fsp.writeFile(tmpPath, JSON.stringify(meta, null, 2) + '\n', 'utf8');
  await fsp.rename(tmpPath, metaPath);
}






async function ensureBoardMetaLocked(workspaceId: string): Promise<BoardMeta> {
  const existing = await readBoardMetaFile(workspaceId);
  if (existing) return existing;
  const meta: BoardMeta = { epoch: mintEpoch(), created_at: new Date().toISOString(), min_retained_seq: 1 };
  await writeBoardMetaLocked(workspaceId, meta);
  return meta;
}







export async function getBoardInfo(workspaceId: string): Promise<BoardMeta> {
  const existing = await readBoardMetaFile(workspaceId);
  if (existing) return existing;
  ensureDirSync(getStoreDir(workspaceId));
  return withLock(workspaceId, () => ensureBoardMetaLocked(workspaceId));
}








export function describeCursorGap(cursorSeq: number, meta: Pick<BoardMeta, 'min_retained_seq'>): string | undefined {
  if (cursorSeq >= meta.min_retained_seq - 1) return undefined;
  return (
    `missed events since seq ${cursorSeq}: this board has compacted entries below seq ` +
    `${meta.min_retained_seq}, so events in (${cursorSeq}, ${meta.min_retained_seq}) can no longer be replayed. ` +
    `Re-read the full current state instead of resuming from this cursor.`
  );
}






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


    }
  }
  return entries;
}


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




  parsedLogCache.set(logPath, { size: stat.size, mtimeMs: stat.mtimeMs, entries });
  return entries.slice();
}








async function primeCacheAfterWrite(logPath: string, entries: ClaimLogEntry[]): Promise<void> {
  try {
    const stat = await fsp.stat(logPath);
    parsedLogCache.set(logPath, { size: stat.size, mtimeMs: stat.mtimeMs, entries: entries.slice() });
  } catch {

  }
}



async function appendClaimLocked(
  workspaceId: string,
  claim: Omit<WorkClaim, 'seq'> & { seq?: number; kind?: ClaimLogEntry['kind']; surprise?: ClaimLogEntry['surprise']; candidate_agent_ids?: string[] },
  existing: ClaimLogEntry[]
): Promise<ClaimLogEntry> {
  if (claim.operation_id) {
    const replay = existing.find((entry) => entry.operation_id === claim.operation_id);
    if (replay) return replay;
  }
  const nextSeq = existing.reduce((max, e) => Math.max(max, e.seq), 0) + 1;





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










  let prefix = '';
  try {
    const fd = await fsp.open(logPath, 'r');
    try {
      const { size } = await fd.stat();
      if (size > 0) {
        const buf = Buffer.alloc(1);
        await fd.read(buf, 0, 1, size - 1);
        if (buf[0] !== 0x0a  ) prefix = '\n';
      }
    } finally {
      await fd.close();
    }
  } catch (err: any) {
    if (err?.code !== 'ENOENT') throw err;

  }
  await fsp.appendFile(logPath, prefix + JSON.stringify(entry) + '\n', 'utf8');
  existing.push(entry);
  await primeCacheAfterWrite(logPath, existing);
  return entry;
}









async function compactIfNeeded(
  workspaceId: string,
  existing: ClaimLogEntry[]
): Promise<ClaimLogEntry[]> {



  const meta = await ensureBoardMetaLocked(workspaceId);
  if (existing.length <= COMPACT_THRESHOLD_ENTRIES) return existing;

  const nowMs = Date.now();
  const activeClaims = deriveActiveClaims(existing, nowMs);
  const activeIds = new Set(activeClaims.map((c) => c.claim_id));






  const activeAgents = new Set(activeClaims.map((c) => c.agent_id));




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
  if (compacted.length >= existing.length) return existing;







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
  await fsp.rename(tmpPath, logPath);
  await writeBoardMetaLocked(workspaceId, nextMeta);
  await primeCacheAfterWrite(logPath, compacted);
  return compacted;
}









export async function withWorkspaceLock<T>(
  workspaceId: string,
  fn: (ctx: { log: ClaimLogEntry[]; append: (claim: Omit<WorkClaim, 'seq'> & { seq?: number; kind?: ClaimLogEntry['kind']; surprise?: ClaimLogEntry['surprise']; candidate_agent_ids?: string[] }) => Promise<ClaimLogEntry> }) => Promise<T>
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






export async function appendClaim(
  workspaceId: string,
  claim: Omit<WorkClaim, 'seq'> & { seq?: number; kind?: ClaimLogEntry['kind']; surprise?: ClaimLogEntry['surprise']; candidate_agent_ids?: string[] }
): Promise<ClaimLogEntry> {
  const dir = getStoreDir(workspaceId);
  ensureDirSync(dir);
  return withLock(workspaceId, async () => {
    let existing = await readClaimLog(workspaceId);
    existing = await compactIfNeeded(workspaceId, existing);
    return appendClaimLocked(workspaceId, claim, existing);
  });
}


export async function getActiveClaims(workspaceId: string, nowMs?: number): Promise<WorkClaim[]> {
  const log = await readClaimLog(workspaceId);
  return deriveActiveClaims(log, nowMs ?? Date.now()).filter(
    (c) => c.workspace_id === workspaceId
  );
}


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


function editLockClaimId(workspaceId: string, agentId: string): string {
  return `edit-lock:${workspaceId}:${agentId}`;
}







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











export async function releaseAgent(workspaceId: string, agentId: string): Promise<ClaimLogEntry[]> {
  const dir = getStoreDir(workspaceId);
  ensureDirSync(dir);










  return withLock(workspaceId, async () => {
    let existing = await readClaimLog(workspaceId);
    existing = await compactIfNeeded(workspaceId, existing);











    const mine = reduceClaimLog(existing).filter(
      (c) => c.status === 'active' && c.workspace_id === workspaceId && c.agent_id === agentId
    );
    const now = new Date().toISOString();
    const released: ClaimLogEntry[] = [];
    for (const c of mine) {
      const { seq: _priorSeq, version: _priorVersion, operation_id: _operationId, ...rest } = c as ClaimLogEntry;
      released.push(
        await appendClaimLocked(workspaceId, { ...rest, status: 'released', heartbeat_at: now }, existing)
      );
    }
    return released;
  });
}









export async function releaseClaimById(
  workspaceId: string,
  agentId: string,
  claimId: string
): Promise<ClaimLogEntry | undefined> {
  return withWorkspaceLock(workspaceId, async ({ log, append }) => {
    const nowMs = Date.now();


    const active = reduceClaimLog(log).find(
      (c) => c.status === 'active' && c.workspace_id === workspaceId && c.agent_id === agentId && c.claim_id === claimId
    );
    if (!active) return undefined;
    const now = new Date(nowMs).toISOString();


    const { seq: _priorSeq, version: _priorVersion, operation_id: _operationId, ...rest } = active as ClaimLogEntry;
    return append({ ...rest, status: 'released', heartbeat_at: now });
  });
}






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

export async function recordAmbiguousEdit(
  workspaceId: string,
  changedPath: string,
  candidateAgentIds: string[]
): Promise<ClaimLogEntry> {
  const now = new Date().toISOString();
  return appendClaim(workspaceId, {
    claim_id: `ambiguous-edit:${workspaceId}:${changedPath}:${now}:${Math.random().toString(36).slice(2, 8)}`,
    workspace_id: workspaceId,
    agent_id: 'unknown',
    agent_kind: 'other',
    scope: { repo: workspaceId, paths: [changedPath], symbols: [] },
    intent: 'ambiguous-edit',
    status: 'released',
    created_at: now,
    ttl_ms: 0,
    heartbeat_at: now,
    kind: 'ambiguous-edit',
    candidate_agent_ids: [...new Set(candidateAgentIds)].sort(),
  });
}






function surpriseClaimId(
  workspaceId: string,
  detail: Pick<SurpriseDetail, 'symbol' | 'changer' | 'affected' | 'reason'>
): string {
  const base = `surprise:${workspaceId}:${detail.symbol}:${detail.changer}:${detail.affected}`;




  return detail.reason ? `${base}:${detail.reason}` : base;
}











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









export async function persistContractDriftSurprises(
  workspaceId: string,
  findings: DeclaredContractDriftFinding[]
): Promise<ClaimLogEntry[]> {
  const persisted: ClaimLogEntry[] = [];
  for (const f of findings) {
    const entry = await persistSurprise(workspaceId, {
      symbol: f.contract,
      changer: f.producer_agent_id,
      affected: f.consumer_agent_id,
      explanation: f.explanation,
      contract: f.contract,
      reason: f.reason,
      confidence: f.confidence,
    });
    if (entry) persisted.push(entry);
  }
  return persisted;
}








export async function readSurprisesFor(workspaceId: string, agentId: string): Promise<SurpriseDetail[]> {
  const log = await readClaimLog(workspaceId);
  return log
    .filter((e): e is ClaimLogEntry & { surprise: SurpriseDetail } => e.kind === 'surprise' && e.agent_id === agentId && !!e.surprise)
    .map((e) => e.surprise);
}



export interface ReleaseOutcome {
  released: ClaimLogEntry[];














  reason?: string;
}










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














export interface ScopedGitOpPlan {

  paths: string[];

  peers: WorkClaim[];
}

export async function planScopedGitOp(workspaceId: string, agentId: string): Promise<ScopedGitOpPlan> {
  const active = await getActiveClaims(workspaceId);
  const paths = [...new Set(active.filter((c) => c.agent_id === agentId).flatMap((c) => c.scope.paths))];
  const peers = active.filter((c) => c.agent_id !== agentId);
  return { paths, peers };
}














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










export async function extendClaim(
  workspaceId: string,
  claimId: string,
  addPaths: string[],
  addSymbols: string[] = [],
  addContracts: { produces?: DeclaredContract[]; consumes?: string[]; concept?: ConceptualCoordinate; operationId?: string } = {}
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
      scope: { ...prior.scope, paths: mergedPaths, symbols: mergedSymbols, concept: addContracts.concept ?? prior.scope.concept },
      intent: prior.intent,
      status: 'active',
      created_at: prior.created_at,
      ttl_ms: prior.ttl_ms,
      heartbeat_at: now,
      base_commit: prior.base_commit,
      branch: prior.branch,
      org_id: prior.org_id,
      operation_id: addContracts.operationId,
      ...mergedContractFields(prior, addContracts),
    });
    return { claim: entry, conflicts };
  });
}







function mergedContractFields(
  prior: Pick<WorkClaim, 'produces' | 'consumes'>,
  add: { produces?: DeclaredContract[]; consumes?: string[] }
): Partial<Pick<WorkClaim, 'produces' | 'consumes'>> {
  const declaredIn = [...(prior.produces ?? []), ...(add.produces ?? [])].filter(
    (c) => (c.status ?? 'declared') === 'declared'
  );
  const observedIn = [...(prior.produces ?? []), ...(add.produces ?? [])].filter((c) => c.status === 'observed');
  const produces = mergeContracts(declaredIn, observedIn);
  const consumes = [...new Set([...(prior.consumes ?? []), ...(add.consumes ?? [])])].slice(
    0,
    MAX_CONSUMES_PER_CLAIM
  );
  return {
    ...(produces.length ? { produces } : {}),
    ...(consumes.length ? { consumes } : {}),
  };
}















export async function recordDerivedContracts(
  workspaceId: string,
  agentId: string,
  derived: { produces?: DeclaredContract[]; consumes?: string[] }
): Promise<ClaimLogEntry | null> {
  const hasInput = (derived.produces?.length ?? 0) > 0 || (derived.consumes?.length ?? 0) > 0;
  if (!hasInput) return null;
  return withWorkspaceLock(workspaceId, async ({ log, append }) => {
    const nowMs = Date.now();
    const prior = deriveActiveClaims(log, nowMs).find(
      (c) => c.workspace_id === workspaceId && c.agent_id === agentId
    );
    if (!prior) return null;

    const merged = mergedContractFields(prior, derived);
    const priorIds = new Set((prior.produces ?? []).map((c) => contractIdentity(c)));
    const nextIds = new Set((merged.produces ?? []).map((c) => contractIdentity(c)));
    const priorConsumes = new Set(prior.consumes ?? []);
    const grewProduces = [...nextIds].some((id) => !priorIds.has(id));
    const grewConsumes = (merged.consumes ?? []).some((n) => !priorConsumes.has(n));
    if (!grewProduces && !grewConsumes) return null;

    const now = new Date().toISOString();
    return append({
      claim_id: prior.claim_id,
      workspace_id: workspaceId,
      agent_id: prior.agent_id,
      agent_kind: prior.agent_kind,
      scope: prior.scope,
      intent: prior.intent,
      status: 'active',
      created_at: prior.created_at,
      ttl_ms: prior.ttl_ms,
      heartbeat_at: now,
      base_commit: prior.base_commit,
      branch: prior.branch,
      org_id: prior.org_id,
      ...merged,
    });
  });
}






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





export function watch(workspaceId: string, cb: () => void): () => void {
  const dir = getStoreDir(workspaceId);
  ensureDirSync(dir);
  const stateFiles = new Set(['claims.jsonl', 'in-flight.jsonl', 'board.json']);
  const dirWatcher = fs.watch(dir, (_event, filename) => {
    if (filename && stateFiles.has(filename.toString())) cb();
  });
  return () => dirWatcher.close();
}











export interface CoordDirDurabilityReport {
  coord_root: string;

  durable: boolean;
  warning?: string;
}











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






export function __clearCachesForTests(): void {
  parsedLogCache.clear();
}
