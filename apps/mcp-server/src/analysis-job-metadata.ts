import * as path from 'node:path';
import type { RemoteAnalyzeRequest } from './remote-analyzer-protocol';
import type { RepoFacts, SourceManifest } from './remote-source';

export interface AnalysisJobMetadata {
  displayName?: string;
  analysisFocus?: RemoteAnalyzeRequest['analysis_focus'];
  repoFacts?: RepoFacts;
  force: boolean;
  projectId?: string;
  organizationId?: string;
  gitRemote?: string;
  baseCommit?: string;
  manifest: SourceManifest;
}

export function analysisJobMetadata(request: RemoteAnalyzeRequest): AnalysisJobMetadata {
  return {
    displayName: resolveDisplayName(request.snapshot.project_name, request.project_path),
    analysisFocus: request.analysis_focus,
    repoFacts: request.snapshot.manifest.repo_facts,
    force: Boolean(request.force),
    projectId: request.project_id,
    organizationId: request.organization_id,
    gitRemote: request.snapshot.manifest.git_remote,
    baseCommit: request.snapshot.base_commit,
    manifest: request.snapshot.manifest,
  };
}

function resolveDisplayName(projectName?: string, projectPath?: string): string | undefined {
  const name = (projectName || '').trim();
  if (name) return name;
  const candidatePath = (projectPath || '').trim();
  return candidatePath ? path.basename(candidatePath.replace(/[/\\]+$/, '')) : undefined;
}
