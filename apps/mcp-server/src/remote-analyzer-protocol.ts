import type { CASOutput, ChangeReport } from '../../../packages/analyzer-core/src/types/cas.types';
import type { BranchDiffContext, RemoteFileChange, SourceManifest, SourceSnapshot, WorkingTreeChangeContext } from './remote-source';
import type { ProposedFileInput } from './proposal-preview';
import type { AnalysisFocus } from './analysis-focus';

export const REMOTE_ANALYSIS_PROTOCOL_VERSION = 2 as const;













export function clientUpgradeRequiredMessage(
  requiredVersion: number = REMOTE_ANALYSIS_PROTOCOL_VERSION,
  installOneLiner = 'curl -fsSL https://mcp.klauro.com/install.sh | sh',
): string {
  return `This Klauro server requires analysis protocol ${requiredVersion}. ` +
    `Run \`klauro update\` and restart the MCP client. ` +
    `If your klauro is too old to have an update command (before 1.0.128) or the update fails, reinstall: ${installOneLiner}`;
}

export interface RemoteAnalyzeRequest {
  protocol_version: typeof REMOTE_ANALYSIS_PROTOCOL_VERSION;
  project_id?: string;
  organization_id?: string;
  project_path?: string;
  snapshot: SourceSnapshot;
  analysis_focus?: AnalysisFocus;






  async?: boolean;











  force?: boolean;
}



export interface RemoteAnalyzeAcceptedResponse {
  status: 'accepted';
  protocol_version: typeof REMOTE_ANALYSIS_PROTOCOL_VERSION;
  analysis_id: string;
  analysis_revision?: number;
  base_commit?: string;
  manifest: SourceManifest;

  reused?: boolean;





  analysis_type?: 'unchanged' | 'analyzer_upgrade' | 'forced';






  reuse_decision?: {
    reused: boolean;
    reason: string;
    source: 'unchanged' | 'analyzer_upgrade' | 'source_changed' | 'forced';

    analyzer_identity_tier: 'parser' | 'derived' | 'build' | 'legacy-build' | 'match' | 'unknown' | 'in-flight';
    analyzer_build?: string;



    ai_cache_bypassed?: boolean;
  };
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
  analysis_focus?: AnalysisFocus;
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
  analysis_focus?: AnalysisFocus;
}

export interface RemoteProjectRevisionsResponse {
  status: 'success';
  analysis_id: string;
  revisions: RemoteProjectRevision[];
}









export interface AccountActivityEvent {
  type:
    | 'analysis_completed'
    | 'analysis_failed'
    | 'workspace_rebuilt'
    | 'workspace_enrichment_degraded'
    | 'workspace_rebuild_failed'
    | 'project_created'
    | 'project_moved';

  at: string;
  workspace_id?: string;
  project_id?: string;
  title: string;
  detail?: string;

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
