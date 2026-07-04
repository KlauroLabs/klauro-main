/**
 * REAL OS-process worker for fabric-fleet-stress.ts (mission: prove the
 * coordination fabric is fleet-ready under REAL concurrent load, not a
 * single-process simulation).
 *
 * Spawned via `child_process.fork`/`spawn` (tsx CLI) by the driver — one
 * worker == one independent agent process. It talks ONLY to the real fabric
 * modules (`grant-manager.ts`, `local-store.ts`) exactly as a live MCP tool
 * call would, run against a shared `KLAURO_COORD_DIR` passed via env so every
 * worker process coordinates through the SAME on-disk claim log — this is
 * the actual multi-process contention path the fleet uses in production
 * (many agent processes/CLIs on one host), not an in-process simulation of
 * concurrency via Promise.all in one Node event loop.
 *
 * Protocol: driver passes a JSON job on argv[2]. Worker executes ONE agent
 * lifecycle:
 *   1. requestGrant() for its assigned scope (may return granted/queued).
 *   2. If queued, poll (bounded retries) via getGrants() until promoted or
 *      timeout — measuring real queue-wait, not assuming instant promotion.
 *   3. Once granted: append N real writes to a SHARED file (the "edit"),
 *      each write is a length-prefixed, checksummed record so the driver can
 *      later verify no lost/corrupted/interleaved writes.
 *   4. heartbeatGrant() once (mid-"edit", proving lease extension works
 *      under real process scheduling, not just unit-test timing).
 *   5. releaseGrant().
 * Every step's wall-clock timestamp and outcome is emitted as ONE JSON line
 * on stdout (`{"type": "result", ...}`) so the driver (which does NOT share
 * memory with this process) can parse structured results after the child
 * exits — this is a REAL IPC boundary, not shared-heap coordination.
 *
 * Run standalone for debugging:
 *   KLAURO_COORD_DIR=/tmp/fab npx tsx fabric-fleet-stress-worker.ts '{"...":"..."}'
 */

import * as fs from 'node:fs';

import { requestGrant, releaseGrant, heartbeatGrant, getGrants } from '../coordination/grant-manager';
import type { AgentKind } from '../coordination/types';

export interface WorkerJob {
  workspace_id: string;
  agent_id: string;
  agent_kind: AgentKind;
  /** Scope this worker requests a grant for. */
  scope: { repo: string; paths: string[]; symbols: string[]; capability?: string };
  intent: string;
  /** Absolute path to the ONE shared file all workers append "edits" to. */
  shared_file: string;
  /** How many length-prefixed records to append once granted. */
  writes_per_worker: number;
  /** Max ms to poll while queued before giving up (still counts as a data point, not a crash). */
  queue_poll_timeout_ms: number;
  queue_poll_interval_ms: number;
  /** If true, this worker deliberately submits the SAME conceptual work
   *  (capability name) as a companion worker, to measure dedup at scale. */
  dedup_group?: string;
  /**
   * Milliseconds to hold the grant open (sleep between grant and release)
   * before releasing, simulating a realistic "editing" duration. REQUIRED to
   * be non-trivial (tens of ms) for overlap scenarios: real per-agent fabric
   * work (grant + a handful of appendFileSync writes + release) completes in
   * low single-digit milliseconds, while `child_process.spawn` + Node/tsx
   * startup jitter across processes is commonly 10-50ms — without an
   * artificial hold, the "first" agent of a same-step/same-entity pair
   * routinely finishes and releases before the "second" agent's process even
   * starts, so the two requests never actually contend. This was measured
   * directly (see docs/FABRIC-FLEET-PROVEN.md's methodology note) before
   * adding this field — an honest harness bug, not a fabric weakness.
   */
  hold_ms?: number;
  /**
   * Absolute path to a barrier file. If set, the worker writes its pid to
   * `${barrier_file}.<agent_id>` immediately after spawning, then polls until
   * every expected agent's marker file exists (or `barrier_timeout_ms`
   * elapses), so all agents in a contending group begin `requestGrant` at
   * nearly the same wall-clock instant — a tight synchronized start,
   * independent of OS process-scheduling/spawn jitter.
   */
  barrier_file?: string;
  barrier_expected_agents?: string[];
  barrier_timeout_ms?: number;
}

export interface WorkerResult {
  type: 'result';
  agent_id: string;
  pid: number;
  scope: WorkerJob['scope'];
  intent: string;
  dedup_group?: string;
  t_request_start: number;
  t_request_end: number;
  request_verdict: 'granted' | 'queued' | 'denied';
  grant_id?: string;
  /** True only if verdict came back 'granted' on the FIRST requestGrant call (no queueing needed). */
  granted_immediately: boolean;
  t_promoted?: number; // when a queued request was observed granted (poll loop)
  queue_polls?: number;
  queue_wait_ms?: number;
  t_edit_start?: number;
  t_edit_end?: number;
  writes_ok?: number;
  t_heartbeat?: number;
  heartbeat_ok?: boolean;
  t_release?: number;
  error?: string;
}

/** Append one length-prefixed, checksummed record to the shared file. Uses
 *  the `a` (append) flag exactly like local-store.ts's own appendClaim —
 *  atomic for writes under the OS pipe-buffer size, which every record here
 *  is — so correctness of the merged file depends on the SAME primitive the
 *  fabric itself relies on, not a stronger one the test smuggles in. */
function appendEditRecord(filePath: string, agentId: string, seq: number): boolean {
  const payload = `${agentId}:${seq}:${'x'.repeat(40)}`;
  let checksum = 0;
  for (let i = 0; i < payload.length; i++) checksum = (checksum + payload.charCodeAt(i)) % 100000;
  const line = `${payload}:${checksum}\n`;
  try {
    fs.appendFileSync(filePath, line, 'utf8');
    return true;
  } catch {
    return false;
  }
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Write this agent's marker, then poll until every expected agent's marker
 *  exists (or the timeout elapses), so a whole contending group crosses the
 *  requestGrant starting line together — removing process-spawn/JIT jitter
 *  as a confound in whether two agents' requests actually overlap in time. */
async function waitAtBarrier(job: WorkerJob): Promise<void> {
  if (!job.barrier_file || !job.barrier_expected_agents?.length) return;
  fs.writeFileSync(`${job.barrier_file}.${job.agent_id}`, '1');
  const deadline = Date.now() + (job.barrier_timeout_ms ?? 3000);
  while (Date.now() < deadline) {
    const allPresent = job.barrier_expected_agents.every((a) => fs.existsSync(`${job.barrier_file}.${a}`));
    if (allPresent) return;
    await sleep(2);
  }
  // Timeout: proceed anyway (still measured/reported, not a hard crash) —
  // an agent process that failed to start would otherwise wedge the group.
}

async function runWorker(job: WorkerJob): Promise<WorkerResult> {
  const result: Partial<WorkerResult> = {
    type: 'result',
    agent_id: job.agent_id,
    pid: process.pid,
    scope: job.scope,
    intent: job.intent,
    dedup_group: job.dedup_group,
  };

  try {
    await waitAtBarrier(job);
    result.t_request_start = Date.now();
    const req = await requestGrant({
      workspace_id: job.workspace_id,
      agent_id: job.agent_id,
      agent_kind: job.agent_kind,
      scope: job.scope,
      intent: job.intent,
    });
    result.t_request_end = Date.now();
    result.request_verdict = req.verdict;
    result.granted_immediately = req.verdict === 'granted';

    let grantId: string | undefined = req.grant_id;

    if (req.verdict === 'queued') {
      // Real polling loop across REAL process scheduling — not a mocked clock.
      const deadline = Date.now() + job.queue_poll_timeout_ms;
      let polls = 0;
      while (Date.now() < deadline) {
        polls++;
        await sleep(job.queue_poll_interval_ms);
        const grants = await getGrants(job.workspace_id);
        const mine = grants.active.find(
          (g) =>
            g.agent_id === job.agent_id &&
            g.scope.repo === job.scope.repo &&
            sameSet(g.scope.paths, job.scope.paths) &&
            sameSet(g.scope.symbols, job.scope.symbols)
        );
        if (mine) {
          grantId = mine.grant_id;
          result.t_promoted = Date.now();
          result.queue_polls = polls;
          result.queue_wait_ms = result.t_promoted - result.t_request_end;
          break;
        }
      }
      if (!grantId) {
        result.error = 'queue_timeout: never promoted within queue_poll_timeout_ms';
        return result as WorkerResult;
      }
    } else if (req.verdict === 'denied') {
      result.error = 'denied';
      return result as WorkerResult;
    }

    // Granted (immediately or via promotion): do the "edit" + heartbeat + release.
    result.t_edit_start = Date.now();
    let writesOk = 0;
    const mid = Math.floor(job.writes_per_worker / 2);
    const holdMs = job.hold_ms ?? 0;
    const perWriteDelay = holdMs > 0 ? Math.max(1, Math.floor(holdMs / job.writes_per_worker)) : 0;
    for (let i = 0; i < job.writes_per_worker; i++) {
      if (appendEditRecord(job.shared_file, job.agent_id, i)) writesOk++;
      if (perWriteDelay > 0) await sleep(perWriteDelay);
      if (i === mid && grantId) {
        const hb = await heartbeatGrant(job.workspace_id, grantId);
        result.t_heartbeat = Date.now();
        result.heartbeat_ok = hb.ok;
      }
    }
    result.writes_ok = writesOk;
    result.t_edit_end = Date.now();

    if (grantId) {
      await releaseGrant(job.workspace_id, job.agent_id, grantId);
      result.t_release = Date.now();
    }

    return result as WorkerResult;
  } catch (err) {
    result.error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    return result as WorkerResult;
  }
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const s = new Set(b);
  return a.every((x) => s.has(x));
}

async function main(): Promise<void> {
  const jobJson = process.argv[2];
  if (!jobJson) {
    console.error('fabric-fleet-stress-worker: missing job JSON on argv[2]');
    process.exit(2);
  }
  const job = JSON.parse(jobJson) as WorkerJob;
  const result = await runWorker(job);
  // Single JSON line — the driver reads this from the child's stdout after exit.
  process.stdout.write(JSON.stringify(result) + '\n');
  process.exit(result.error ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(3);
});
