import { getActiveClaims, getBoardInfo, readClaimLog, watch } from './local-store';
import { readParticipantInFlightSnapshots } from './participant-in-flight-store';
import { remoteActive, type RemoteActiveResult, type RemoteFabConfig } from './remote-transport';

export type WorkspaceSubscriptionStatus = 'snapshot' | 'changed' | 'timeout' | 'gap';

export interface WorkspaceSubscriptionCursor {
  since_seq?: number;
  since_epoch?: string;
  since_revision?: string;
  wait_ms?: number;
}

export interface WorkspaceSubscriptionResult {
  status: WorkspaceSubscriptionStatus;
  workspace: string;
  tier: 'local' | 'remote';
  waited_ms: number;
  resume_seq: number;
  epoch?: string;
  revision: string;
  active: unknown[];
  in_flight: unknown[];
  gap_notice?: string;
}

const DEFAULT_WAIT_MS = 20_000;
const MAX_WAIT_MS = 30_000;
const REMOTE_POLL_MS = 200;

function boundedWaitMs(value?: number): number {
  if (value === undefined) return DEFAULT_WAIT_MS;
  return Math.max(0, Math.min(MAX_WAIT_MS, Math.floor(value)));
}

function revision(maxSeq: number, inFlight: Array<{ agent_id: string; updated_at: string }>): string {
  const participantRevision = [...inFlight]
    .sort((left, right) => left.agent_id.localeCompare(right.agent_id))
    .map((entry) => `${entry.agent_id}:${entry.updated_at}`)
    .join('|');
  return `${maxSeq}:${participantRevision}`;
}

function statusFor(
  cursor: WorkspaceSubscriptionCursor,
  state: { maxSeq: number; epoch?: string; revision: string },
): WorkspaceSubscriptionStatus | undefined {
  if (cursor.since_epoch && state.epoch && cursor.since_epoch !== state.epoch) return 'gap';
  if (cursor.since_seq === undefined && cursor.since_revision === undefined) return 'snapshot';
  if (cursor.since_seq !== undefined && state.maxSeq > cursor.since_seq) return 'changed';
  if (cursor.since_revision !== undefined && state.revision !== cursor.since_revision) return 'changed';
  return undefined;
}

async function localState(workspace: string) {
  const [log, board, active, inFlight] = await Promise.all([
    readClaimLog(workspace),
    getBoardInfo(workspace),
    getActiveClaims(workspace),
    readParticipantInFlightSnapshots(workspace),
  ]);
  const maxSeq = log.reduce((current, entry) => Math.max(current, entry.seq), 0);
  return { maxSeq, epoch: board.epoch, revision: revision(maxSeq, inFlight), active, inFlight };
}

function localResult(
  workspace: string,
  status: WorkspaceSubscriptionStatus,
  startedAt: number,
  state: Awaited<ReturnType<typeof localState>>,
  cursor: WorkspaceSubscriptionCursor,
): WorkspaceSubscriptionResult {
  return {
    status,
    workspace,
    tier: 'local',
    waited_ms: Date.now() - startedAt,
    resume_seq: state.maxSeq,
    epoch: state.epoch,
    revision: state.revision,
    active: state.active,
    in_flight: state.inFlight,
    ...(status === 'gap'
      ? { gap_notice: `Cursor epoch ${cursor.since_epoch} does not match workspace epoch ${state.epoch}; consume this snapshot and resume with the returned cursor.` }
      : {}),
  };
}

export async function waitForLocalWorkspaceChange(
  workspace: string,
  cursor: WorkspaceSubscriptionCursor = {},
): Promise<WorkspaceSubscriptionResult> {
  const startedAt = Date.now();
  const waitMs = boundedWaitMs(cursor.wait_ms);
  const initial = await localState(workspace);
  const initialStatus = statusFor(cursor, initial);
  if (initialStatus || waitMs === 0) {
    return localResult(workspace, initialStatus ?? 'timeout', startedAt, initial, cursor);
  }

  return new Promise<WorkspaceSubscriptionResult>((resolve, reject) => {
    let finished = false;
    let evaluating = false;
    const finish = (result: WorkspaceSubscriptionResult) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      unwatch();
      resolve(result);
    };
    const evaluate = async () => {
      if (finished || evaluating) return;
      evaluating = true;
      try {
        const state = await localState(workspace);
        const status = statusFor(cursor, state);
        if (status) finish(localResult(workspace, status, startedAt, state, cursor));
      } catch (error) {
        if (!finished) reject(error);
      } finally {
        evaluating = false;
      }
    };
    const unwatch = watch(workspace, () => void evaluate());
    const timer = setTimeout(async () => {
      try {
        finish(localResult(workspace, 'timeout', startedAt, await localState(workspace), cursor));
      } catch (error) {
        reject(error);
      }
    }, waitMs);
    void evaluate();
  });
}

function remoteState(state: RemoteActiveResult) {
  const maxSeq = state.max_seq;
  const inFlight = state.in_flight ?? [];
  return {
    maxSeq,
    epoch: state.epoch,
    revision: revision(maxSeq, inFlight),
    active: state.active,
    inFlight,
  };
}

export async function waitForRemoteWorkspaceChange(
  config: RemoteFabConfig,
  workspace: string,
  cursor: WorkspaceSubscriptionCursor = {},
): Promise<WorkspaceSubscriptionResult> {
  const startedAt = Date.now();
  const waitMs = boundedWaitMs(cursor.wait_ms);
  while (true) {
    const state = remoteState(await remoteActive(config, workspace));
    const stateStatus = statusFor(cursor, state);
    const elapsed = Date.now() - startedAt;
    const status = stateStatus ?? (elapsed >= waitMs ? 'timeout' : undefined);
    if (status) {
      return {
        status,
        workspace,
        tier: 'remote',
        waited_ms: elapsed,
        resume_seq: state.maxSeq,
        epoch: state.epoch,
        revision: state.revision,
        active: state.active,
        in_flight: state.inFlight,
        ...(status === 'gap'
          ? { gap_notice: `Cursor epoch ${cursor.since_epoch} does not match workspace epoch ${state.epoch}; consume this snapshot and resume with the returned cursor.` }
          : {}),
      };
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(REMOTE_POLL_MS, waitMs - elapsed)));
  }
}
