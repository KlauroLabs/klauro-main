import { apiRequest } from './client';

export interface Project {
  id: string;
  workspace_id?: string;
  name: string;
  repo_url?: string;
  local_path?: string;
  analysis_id?: string;
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

export interface RepoFacts {
  contributor_count?: number;
  first_commit_at?: string;
  last_commit_at?: string;
}

export interface AnalysisSummary {
  name?: string;
  type?: string;
  repo_facts?: RepoFacts;
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

  ai_enrichment?: AiEnrichmentState;
  ai_enrichment_error?: string;
  error?: string;
}

export function createProject(token: string, workspaceId: string, input: { name: string; repo_url?: string; local_path?: string; analysis_id?: string }): Promise<{ project: Project }> {
  return apiRequest(`/api/workspaces/${encodeURIComponent(workspaceId)}/projects`, token, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function getProjectAnalysis(token: string, projectId: string): Promise<ProjectAnalysisResponse> {
  return apiRequest(`/api/projects/${encodeURIComponent(projectId)}/analysis`, token);
}

export interface AnalyzeProjectResult {
  analysis_id: string;
  analysis_revision: number;
  nodes: number;
  edges: number;
}

export function reanalyzeProject(token: string, project: Project): Promise<AnalyzeProjectResult> {
  return apiRequest(`/api/projects/${encodeURIComponent(project.id)}/reanalyze`, token, {
    method: 'POST',
  });
}
