import type { AnalysisAttemptRecord } from './analysis-attempt-record';
import {
  analysisLandedAfterAttempt,
  unavailableFailedAttemptWithStaleAnalysis,
  unavailableLatestAnalyzeAttempt,
} from './analysis-response-readiness';

function analysisAttemptIdentity(attempt: AnalysisAttemptRecord | null | undefined): string {
  if (!attempt) return '';
  return [
    attempt.state,
    attempt.analysis_revision ?? '',
    attempt.started_at ?? '',
    attempt.queued_at ?? '',
    attempt.finished_at ?? '',
  ].join(':');
}

export function analysisAttemptFenceResponse(
  before: AnalysisAttemptRecord | null | undefined,
  after: AnalysisAttemptRecord | null | undefined,
  entry: { analyzed_at?: string; layers_ready?: { layers?: Array<{ layer: string; status: string }> } } | null,
  responseAnalysisTimestamp: string | undefined,
  identity: { project_id: string; analysis_id: string; tool?: string },
): Record<string, unknown> | undefined {
  if (analysisAttemptIdentity(after) === analysisAttemptIdentity(before)) return undefined;
  if (after?.state === 'failed') {
    const failed = unavailableFailedAttemptWithStaleAnalysis(entry, after, identity);
    if (failed) return { ...failed };
    if (analysisLandedAfterAttempt(entry, after) && responseAnalysisTimestamp === entry?.analyzed_at) return undefined;
    const unavailable = unavailableLatestAnalyzeAttempt(after, identity);
    return unavailable ? { ...unavailable } : undefined;
  }
  if (after?.state === 'succeeded'
    && analysisLandedAfterAttempt(entry, after)
    && responseAnalysisTimestamp === entry?.analyzed_at) {
    return undefined;
  }
  return {
    status: 'populating',
    ...identity,
    ...(after ? { last_attempt: after } : {}),
  };
}
