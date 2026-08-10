import { apiRequest } from './client';
import type { Project } from './projects';

export interface Workspace {
  id: string;
  name: string;
  role: string;
  project_count: number;
  user_count: number;
}

export interface WorkspaceMember {
  id: string;
  email: string;
  name?: string;
  role: string;
}

export interface WorkspaceApplication {
  id: string;
  codebase_id: string;
  name: string;
  kind?: string;
  deployable?: boolean;
  ports?: string[];
  source_sub_cas_node_id?: string;
  merged_into?: string;
  also_declared_by?: string[];
  [key: string]: unknown;
}

export interface WorkspaceRuntimeComponent {
  id: string;
  codebase_id: string;
  application_id: string;
  name: string;
  kind?: string;
  [key: string]: unknown;
}

export interface WorkspaceRuntimeLink {
  id: string;
  codebase_id: string;
  source_component_id: string;
  target_component_id: string;
  kind?: string;
  evidence?: string[];
  [key: string]: unknown;
}

export interface WorkspaceEnrichment {
  status: 'pending' | 'ai' | 'degraded' | 'skipped' | 'error';
  reason?: string;
  error?: string;
  started_at?: string;
  completed_at?: string;
}

export interface WorkspaceLastAttempt {
  state: 'in-progress' | 'succeeded' | 'failed';
  trigger?: string;
  started_at?: string;
  finished_at?: string;
  duration_ms?: number;
  reason?: string;
}

export interface ComplexitySubscore {
  score: number;
  inputs: Record<string, number>;
}

export interface WorkspaceComplexity {
  composite: number;
  member_average_composite: number;
  subscores: {
    application_surface: ComplexitySubscore;
    runtime_link_density: ComplexitySubscore;
    das_verified_fraction: ComplexitySubscore;
  };
  members: Array<{ codebase_id: string; composite: number }>;
  computed_from: string[];
}

export interface WorkspaceAnalysisResponse {
  status: 'ready' | 'pending' | 'none';
  workspace_id: string;
  workspace_name?: string;
  generated_at?: string;
  member_project_ids?: string[];
  member_project_names?: string[];
  enrichment?: WorkspaceEnrichment;
  last_attempt?: WorkspaceLastAttempt;
  analysis?: {
    workspace_narrative?: {
      title?: string;
      description?: string;
      product_value_summary?: string;
      value_drivers?: string[];
      domains?: string[];
      key_capabilities?: string[];
      relationship_summary?: string[];
    };
    health?: {
      status?: 'healthy' | 'watch' | 'at-risk' | 'unknown';
      score?: number;
      summary?: string;
      risk_area_count?: number;
      critical_risk_count?: number;
      high_risk_count?: number;
    };
    codebases?: Array<{
      id: string;
      name?: string;

      path?: string;
      primary_domain?: string;
      system_type?: string;
      languages?: string[];
      frameworks?: string[];
    }>;

    workspace_complexity?: WorkspaceComplexity;
    applications?: WorkspaceApplication[];
    runtime_components?: WorkspaceRuntimeComponent[];
    runtime_links?: WorkspaceRuntimeLink[];
    application_links?: Array<{
      id: string;
      kind?: string;
      source_application_id?: string;
      target_application_id?: string;
      source_application_name?: string;
      target_application_name?: string;
      source_codebase_id: string;
      target_codebase_id: string;
      [key: string]: unknown;
    }>;
    summary?: {
      codebases?: number;
      applications?: number;
      distribution_units?: number;
      composition_kind?: string;
      capabilities?: number;
      domains?: number;
      entities?: number;
      risk_areas?: number;
    };
    [key: string]: unknown;
  };
}

export interface AttachProjectResult {
  attached: true;
  already_attached: boolean;
  project: Project;
  semantics: 'move';
  moved_from_workspace_id?: string;
  was_rebuild: 'scheduled' | 'unchanged';
}

export function createWorkspace(token: string, name: string): Promise<{ workspace: Workspace }> {
  return apiRequest('/api/workspaces', token, {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
}

export function addWorkspaceMember(token: string, workspaceId: string, input: { email: string; role: string }): Promise<{ membership: WorkspaceMember }> {
  return apiRequest(`/api/workspaces/${encodeURIComponent(workspaceId)}/users`, token, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function getWorkspaceAnalysis(token: string, workspaceId: string): Promise<WorkspaceAnalysisResponse> {
  return apiRequest(`/api/workspaces/${encodeURIComponent(workspaceId)}/analysis`, token);
}

export function attachProjectToWorkspace(token: string, workspaceId: string, projectId: string): Promise<AttachProjectResult> {
  return apiRequest(`/api/workspaces/${encodeURIComponent(workspaceId)}/projects`, token, {
    method: 'POST',
    body: JSON.stringify({ project_id: projectId }),
  });
}

export function reanalyzeWorkspace(token: string, workspaceId: string): Promise<{ status: 'accepted'; workspace_id: string }> {
  return apiRequest(`/api/workspaces/${encodeURIComponent(workspaceId)}/reanalyze`, token, {
    method: 'POST',
  });
}

export async function pollWorkspaceAnalysisUntilAdvanced(
  token: string,
  workspaceId: string,
  sinceGeneratedAt: string | undefined,
  options: { maxAttempts?: number; intervalMs?: number } = {},
): Promise<WorkspaceAnalysisResponse> {
  const maxAttempts = options.maxAttempts ?? 20;
  const intervalMs = options.intervalMs ?? 3000;
  let last = await getWorkspaceAnalysis(token, workspaceId);
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (last.status === 'ready' && last.generated_at && last.generated_at !== sinceGeneratedAt) return last;
    if (last.last_attempt?.state === 'failed') return last;
    await new Promise(resolve => setTimeout(resolve, intervalMs));
    last = await getWorkspaceAnalysis(token, workspaceId);
  }
  return last;
}
