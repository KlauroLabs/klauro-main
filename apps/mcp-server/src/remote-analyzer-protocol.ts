import type { CASOutput, ChangeReport } from '../../../packages/analyzer-core/src/types/cas.types';
import type { RemoteFileChange, SourceManifest, SourceSnapshot, WorkingTreeChangeContext } from './remote-source';
import type { ProposedFileInput } from './proposal-preview';

export interface RemoteAnalyzeRequest {
  project_id?: string;
  organization_id?: string;
  project_path?: string;
  snapshot: SourceSnapshot;
}

export interface RemoteSyncRequest {
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
  nodes: number;
  edges: number;
}

export interface RemoteProjectRevisionsResponse {
  status: 'success';
  analysis_id: string;
  revisions: RemoteProjectRevision[];
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

export type RemoteAnalyzerResponse = RemoteAnalyzeResponse | RemoteProjectRevisionsResponse | RemoteErrorResponse;
