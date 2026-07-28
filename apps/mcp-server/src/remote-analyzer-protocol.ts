import type { CASOutput, ChangeReport } from '../../../packages/analyzer-core/src/types/cas.types';
import type { BranchDiffContext, RemoteFileChange, SourceManifest, SourceSnapshot, WorkingTreeChangeContext } from './remote-source';
import type { ProposedFileInput } from './proposal-preview';

export const REMOTE_ANALYSIS_PROTOCOL_VERSION = 2 as const;

export interface RemoteAnalyzeRequest {
  protocol_version: typeof REMOTE_ANALYSIS_PROTOCOL_VERSION;
  project_id?: string;
  organization_id?: string;
  project_path?: string;
  snapshot: SourceSnapshot;
  /** Progressive-disclosure mode (the default client behavior): the server
   *  accepts the snapshot and responds in seconds with `status:'accepted'`;
   *  the analysis runs entirely server-side in the background, attaching to
   *  the account project and refreshing the workspace analysis as it lands.
   *  Completion is observed through the status and explicit export endpoints;
   *  uploads never hold the request open for a full CAS response. */
  async?: boolean;
}

/** Immediate response to an `async: true` analyze push — the snapshot was
 *  accepted and the analysis is running server-side. */
export interface RemoteAnalyzeAcceptedResponse {
  status: 'accepted';
  protocol_version: typeof REMOTE_ANALYSIS_PROTOCOL_VERSION;
  analysis_id: string;
  base_commit?: string;
  manifest: SourceManifest;
  /** The exact committed snapshot is already analyzed or currently in flight. */
  reused?: boolean;
  analysis_type?: 'unchanged';
}

export interface RemoteSyncRequest {
  protocol_version: typeof REMOTE_ANALYSIS_PROTOCOL_VERSION;
  analysis_id: string;
  project_id?: string;
  organization_id?: string;
  project_path?: string;
  changes: WorkingTreeChangeContext | {
    project_name: string;
    base_commit?: string;
    git_diff?: string;
    changed_files: RemoteFileChange[];
    manifest?: SourceManifest;
  };
  /** Customer clients submit changes and return after durable acceptance. */
  async?: boolean;
}

export interface RemoteAnalyzeDiffRequest {
  project_id?: string;
  organization_id?: string;
  project_path?: string;
  diff_context: BranchDiffContext;
}

export interface RemoteAnalyzeResponse {
  status: 'success';
  analysis_id: string;
  analysis_revision: number;
  analysis_type: 'full' | 'incremental';
  base_commit?: string;
  manifest: SourceManifest;
  cas: CASOutput;
  change_report?: ChangeReport;
}

export interface RemoteProjectRevision {
  analysis_id: string;
  analysis_revision: number;
  branch?: string;
  commit?: string;
  source: 'local_commit_submission' | 'git_provider' | 'manual';
  generated_at: string;
  files: number;
  bytes: number;
  snapshot_digest?: string;
  nodes: number;
  edges: number;
}

export interface RemoteProjectRevisionsResponse {
  status: 'success';
  analysis_id: string;
  revisions: RemoteProjectRevision[];
}

/**
 * A single reverse-chronological entry in GET /api/account/activity and
 * GET /api/workspaces/{id}/activity ("Change Activity" panel in the Home +
 * Workspace Figma frames). Every event is derived from data ALREADY
 * persisted for other reasons (project revisions, reanalyze attempt
 * sidecars, the server-side WAS record) — there is no separate activity-log
 * writer, so this type is deliberately a thin projection, not a new store.
 */
export interface AccountActivityEvent {
  type:
    | 'analysis_completed'
    | 'analysis_failed'
    | 'workspace_rebuilt'
    | 'workspace_enrichment_degraded'
    | 'workspace_rebuild_failed'
    | 'project_created'
    | 'project_moved';
  /** ISO timestamp this event happened at — the sort key for the feed. */
  at: string;
  workspace_id?: string;
  project_id?: string;
  title: string;
  detail?: string;
  /** Node/edge count change vs. the previous stored revision, when one exists to diff against. */
  deltas?: { nodes: number; edges: number };
  duration_ms?: number;
}

export interface AccountActivityResponse {
  events: AccountActivityEvent[];
  next_cursor: null;
}

export interface RemoteProposalPreviewRequest {
  project_id?: string;
  organization_id?: string;
  codebase_id?: string;
  project_path?: string;
  title?: string;
  plan_text: string;
  diff_text?: string;
  proposed_files?: ProposedFileInput[];
  preview_base_url?: string;
  snapshot?: SourceSnapshot;
}

export interface RemoteGreenfieldPreviewRequest {
  project_id?: string;
  organization_id?: string;
  title?: string;
  plan_text: string;
  proposed_files: ProposedFileInput[];
  preview_base_url?: string;
}

export interface RemoteErrorResponse {
  status: 'error';
  error: string;
}

export type RemoteAnalyzerResponse = RemoteAnalyzeResponse | RemoteAnalyzeAcceptedResponse | RemoteProjectRevisionsResponse | RemoteErrorResponse;
