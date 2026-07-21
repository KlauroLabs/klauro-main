import type { WorkspaceAnalysisResponse } from '@/shared/api/index';

type WorkspaceGraph = NonNullable<WorkspaceAnalysisResponse['analysis']>;

export interface WorkspaceInputRef {
  project_id: string;
  codebase_id: string;
  cas_generated_at?: string;
  analysis_trust?: { status: string; freshness: 'fresh' | 'unknown' | 'stale'; confidence: number };
}

export interface WorkspaceContributor {
  name: string;
  projects: string[];
  commits_30d?: number;
  source: 'cas' | 'git' | 'unknown';
}

export interface WorkspaceGraphExtras {
  inputs: WorkspaceInputRef[];
  contributors: WorkspaceContributor[];
  workflowCount: number | undefined;
  runtimeLinkCount: number | undefined;
}

export function getGraphExtras(analysis: WorkspaceGraph | undefined): WorkspaceGraphExtras {
  const raw = analysis as unknown as {
    inputs?: WorkspaceInputRef[];
    activity?: { contributors?: WorkspaceContributor[] };
    summary?: { workflows?: number };
    runtime_links?: unknown[];
  } | undefined;
  return {
    inputs: raw?.inputs ?? [],
    contributors: raw?.activity?.contributors ?? [],
    workflowCount: raw?.summary?.workflows,
    runtimeLinkCount: raw?.runtime_links?.length,
  };
}

export function projectIdFromCodebasePath(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const match = /^account-project:(.+)$/.exec(path);
  return match ? match[1] : undefined;
}

export function inputForCodebase(inputs: WorkspaceInputRef[], codebaseId: string): WorkspaceInputRef | undefined {
  return inputs.find(input => input.codebase_id === codebaseId);
}

export function contributorsForProject(contributors: WorkspaceContributor[], projectId: string | undefined): WorkspaceContributor[] {
  if (!projectId) return [];
  return contributors.filter(contributor => contributor.projects.includes(projectId));
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
}

export function formatCount(value: number | undefined): string {
  return typeof value === 'number' ? String(value) : '—';
}
