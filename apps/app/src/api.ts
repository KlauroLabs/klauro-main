export interface SessionUser {
  id: string;
  email: string;
  name?: string;
}

export interface Session {
  token: string;
  user: SessionUser;
}

export interface Workspace {
  id: string;
  name: string;
  role: string;
  project_count: number;
  user_count: number;
}

export interface Project {
  id: string;
  workspace_id?: string;
  name: string;
  repo_url?: string;
  local_path?: string;
  analysis_id?: string;
}

export interface WorkspaceMember {
  id: string;
  email: string;
  name?: string;
  role: string;
}

export interface ProjectRevision {
  analysis_id: string;
  analysis_revision: number;
  branch?: string;
  commit?: string;
  source: string;
  generated_at: string;
  files: number;
  bytes: number;
  nodes: number;
  edges: number;
}

export interface AppStateData {
  user: SessionUser;
  workspaces: Workspace[];
  projectsByWorkspace: Record<string, Project[]>;
  membersByWorkspace: Record<string, WorkspaceMember[]>;
  revisionsByProject: Record<string, ProjectRevision[]>;
}

export interface ProductMapCapability {
  name: string;
  description: string;
  category: 'core' | 'supporting' | 'admin' | 'internal';
  criticality: 'critical' | 'high' | 'medium' | 'low';
  entities: string[];
  tests_present: boolean;
  risk_level: 'low' | 'medium' | 'high';
}

export interface ProductMap {
  identity: {
    name: string;
    domain: string;
    description: string;
    unanalyzed_languages: Array<{ name: string; files: number; share_of_source: number }>;
  };
  capabilities: ProductMapCapability[];
  data: {
    entities: number;
    sensitive: string[];
    exposure_highlights: Array<{ entity: string; sensitive_fields: string[]; unguarded_paths: number }>;
  };
  health: {
    status?: 'healthy' | 'watch' | 'at-risk' | 'critical';
    score?: number;
    tests: { total: number; passing: number; failing: number; coverage_percentage?: number };
    implementation: { complete: number; partial: number; stubs: number; not_implemented: number; deprecated: number; health_score?: number };
    top_risks: Array<{ name: string; level: 'low' | 'medium' | 'high'; type: string; recommendation: string }>;
  };
}

export interface LayerStatus {
  layer: string;
  name: string;
  status: 'pending' | 'ready' | 'error';
  fields: string[];
  completed_at?: string;
  duration_ms?: number;
  error?: string;
}

export interface LayersReady {
  complete: boolean;
  layers?: LayerStatus[];
  generated_at?: string;
  [key: string]: unknown;
}

export type AiEnrichmentState = 'pending' | 'ready' | 'disabled' | 'synchronous' | 'error';

export interface AnalysisSummary {
  name?: string;
  type?: string;
  languages?: string[];
  frameworks?: string[];
  primary_domain?: string | null;
  description?: string | null;
  nodes?: number;
  edges?: number;
  entry_points?: number;
  capabilities?: number;
  top_capabilities?: string[];
  layers_ready?: LayersReady;
  ai_enrichment?: AiEnrichmentState;
  ai_enrichment_error?: string;
  [key: string]: unknown;
}

export interface ProjectAnalysisResponse {
  status: 'ready' | 'populating' | 'no_analysis';
  project_id: string;
  analysis_id?: string;
  summary?: AnalysisSummary;
  product_map?: ProductMap;
  /** Present (as 'error') when the AI comprehension pass terminally failed. */
  ai_enrichment?: AiEnrichmentState;
  ai_enrichment_error?: string;
  error?: string;
}

export interface ILSOContract {
  input: string[];
  logic: string;
  side_effects: {
    state_changes: string[];
    external_integrations: string[];
  };
  output: string[];
  constraints: string[];
}

export interface FlowStep {
  step_id: string;
  order: number;
  name: string;
  description: string;
  contract: ILSOContract;
  functions: Array<{
    function_id: string;
    section?: { start_line: number; end_line: number; label?: string };
  }>;
}

export interface FlowConcept {
  flow_id: string;
  name: string;
  intent: string;
  entry_point: string;
  /** Evidence-gated: present only when a system_capabilities operation
   *  references this flow's entry point; omitted (never fabricated) otherwise. */
  capability_id?: string;
  /** Deterministic semantic role classification — always real API data. */
  role?: 'core' | 'supporting' | 'infrastructure';
  entities: string[];
  contract: ILSOContract;
  steps: FlowStep[];
  gaps?: string[];
}

export interface ConceptualCapability {
  id: string;
  name: string;
  category: string;
  criticality: string;
}

export interface ArchitecturalConflict {
  id: string;
  kind: 'pattern-conflict' | 'pattern-overlap';
  concern: string;
  competing: Array<{ label: string; files: string[]; share: number }>;
  severity: 'low' | 'medium' | 'high';
  evidence: string[];
  suggested_alignment: string;
  [key: string]: unknown;
}

export interface PrincipleViolation {
  id: string;
  principle: string;
  file: string;
  node_id: string;
  detail: string;
  severity: 'info' | 'warning' | 'error';
  [key: string]: unknown;
}

export interface Perspective {
  id: string;
  name: string;
  description: string;
  analyzer_id?: string;
  type?: string;
  [key: string]: unknown;
}

export interface ParadigmSummary {
  paradigm: string;
  description: string;
  adoption: unknown;
  deviation_count: number;
  deviations_by_severity: Record<string, number>;
  sample_deviations: unknown[];
}

export interface ConceptualResponse {
  status: 'ready' | 'no_analysis';
  project_id: string;
  analysis_id?: string;
  error?: string;
  capabilities?: ConceptualCapability[];
  flows?: {
    flows: FlowConcept[];
    total: number;
    gaps?: string[];
  };
  structural?: {
    architectural: {
      total_conflicts?: number;
      total_principle_violations?: number;
      principle_violations_by_severity?: Record<string, number>;
      principle_violations_by_principle?: Record<string, number>;
      conflicts?: ArchitecturalConflict[];
      principle_violations?: PrincipleViolation[];
      is_cohesive?: boolean;
      analysis_version_notice?: string;
      [key: string]: unknown;
    };
    paradigms: {
      total: number;
      total_deviations: number;
      paradigms: ParadigmSummary[];
      analysis_version_notice?: string;
    };
    perspectives: Perspective[];
  };
}

export interface WorkspaceAnalysisResponse {
  status: 'ready' | 'pending' | 'none';
  workspace_id: string;
  workspace_name?: string;
  generated_at?: string;
  member_project_ids?: string[];
  member_project_names?: string[];
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
      /** `account-project:<projectId>` for account-workspace analyses. */
      path?: string;
      primary_domain?: string;
      system_type?: string;
      languages?: string[];
      frameworks?: string[];
    }>;
    applications?: Array<{ id: string; name?: string; kind?: string; codebase_id?: string }>;
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

const configuredBase = import.meta.env.VITE_KLAURO_API_URL as string | undefined;
// app.klauro.com is a static host with no /api/* routes of its own — the API
// lives on mcp.klauro.com. If a build ever ships without VITE_KLAURO_API_URL
// baked in (the original cause of the alpha login failure), fall back to the
// known-good API host for that specific hostname instead of same-origin,
// which would 405 on every auth call. Local dev (any other hostname) keeps
// the same-origin fallback so a dev-run API on the current host still works.
const knownProductionApiHosts: Record<string, string> = {
  'app.klauro.com': 'https://mcp.klauro.com',
};
const fallbackBase = knownProductionApiHosts[window.location.hostname] || window.location.origin;
export const apiBaseUrl = (configuredBase || fallbackBase).replace(/\/$/, '');

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export async function apiRequest<T>(path: string, token: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json');
  if (token) headers.set('authorization', `Bearer ${token}`);
  const response = await fetch(`${apiBaseUrl}${path}`, { ...init, headers });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new ApiError(typeof body.error === 'string' ? body.error : 'Request failed', response.status);
  }
  return body as T;
}

export function signIn(email: string, password: string): Promise<Session> {
  return apiRequest<Session>('/api/auth/login', '', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
}

export function registerAccount(input: { email: string; name?: string; password: string; workspace_name?: string }): Promise<Session> {
  return apiRequest<Session>('/api/auth/register', '', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function loadAppData(token: string): Promise<AppStateData> {
  const me = await apiRequest<{ user: SessionUser }>('/api/me', token);
  const workspaceResult = await apiRequest<{ workspaces: Workspace[] }>('/api/workspaces', token);
  const projectsByWorkspace: Record<string, Project[]> = {};
  const membersByWorkspace: Record<string, WorkspaceMember[]> = {};
  const revisionsByProject: Record<string, ProjectRevision[]> = {};

  await Promise.all(workspaceResult.workspaces.map(async workspace => {
    const [projects, members] = await Promise.all([
      apiRequest<{ projects: Project[] }>(`/api/workspaces/${encodeURIComponent(workspace.id)}/projects`, token),
      apiRequest<{ users: WorkspaceMember[] }>(`/api/workspaces/${encodeURIComponent(workspace.id)}/users`, token),
    ]);
    projectsByWorkspace[workspace.id] = projects.projects.map(project => ({ ...project, workspace_id: workspace.id }));
    membersByWorkspace[workspace.id] = members.users;
    await Promise.all(projectsByWorkspace[workspace.id].map(async project => {
      const analysisId = project.analysis_id || project.id;
      try {
        const revisions = await apiRequest<{ revisions: ProjectRevision[] }>(`/v1/projects/${encodeURIComponent(analysisId)}/revisions`, token);
        revisionsByProject[project.id] = revisions.revisions;
      } catch {
        revisionsByProject[project.id] = [];
      }
    }));
  }));

  return {
    user: me.user,
    workspaces: workspaceResult.workspaces,
    projectsByWorkspace,
    membersByWorkspace,
    revisionsByProject,
  };
}

export function createWorkspace(token: string, name: string): Promise<{ workspace: Workspace }> {
  return apiRequest('/api/workspaces', token, {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
}

export function createProject(token: string, workspaceId: string, input: { name: string; repo_url?: string; local_path?: string; analysis_id?: string }): Promise<{ project: Project }> {
  return apiRequest(`/api/workspaces/${encodeURIComponent(workspaceId)}/projects`, token, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function addWorkspaceMember(token: string, workspaceId: string, input: { email: string; role: string }): Promise<{ membership: WorkspaceMember }> {
  return apiRequest(`/api/workspaces/${encodeURIComponent(workspaceId)}/users`, token, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function getProjectAnalysis(token: string, projectId: string): Promise<ProjectAnalysisResponse> {
  return apiRequest(`/api/projects/${encodeURIComponent(projectId)}/analysis`, token);
}

export function getWorkspaceAnalysis(token: string, workspaceId: string): Promise<WorkspaceAnalysisResponse> {
  return apiRequest(`/api/workspaces/${encodeURIComponent(workspaceId)}/analysis`, token);
}

export function getProjectConceptual(token: string, projectId: string, target?: string): Promise<ConceptualResponse> {
  const query = target ? `?target=${encodeURIComponent(target)}` : '';
  return apiRequest(`/api/projects/${encodeURIComponent(projectId)}/conceptual${query}`, token);
}

export interface AnalyzeProjectResult {
  analysis_id: string;
  analysis_revision: number;
  nodes: number;
  edges: number;
}

/**
 * Re-Analyze action: the browser has no filesystem access, so it cannot build
 * a source snapshot itself (the CLI normally does that). Instead this calls
 * the account-authed server-side endpoint, which reads the project's
 * `local_path` directly on the API host, builds the snapshot there, and runs
 * analysis — reusing the existing project's analysis_id so revisions and the
 * analysis stay attached to the same project.
 */
export function reanalyzeProject(token: string, project: Project): Promise<AnalyzeProjectResult> {
  return apiRequest(`/api/projects/${encodeURIComponent(project.id)}/reanalyze`, token, {
    method: 'POST',
  });
}
