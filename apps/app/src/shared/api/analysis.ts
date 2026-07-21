import { apiRequest } from './client';

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

export interface CapabilityFlowRelationship {
  capability_id: string;
  role: 'primary' | 'supporting' | 'prerequisite' | 'operational' | 'recovery' | 'observability';
  rationale: string;
}

export interface FlowConcept {
  flow_id: string;
  name: string;
  intent: string;
  entry_point: string;

  capability_id?: string;

  capability_relationships?: CapabilityFlowRelationship[];

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

  related_flows?: Array<{ flow_id: string; role: string; rationale: string }>;
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

export function getProjectConceptual(token: string, projectId: string, target?: string): Promise<ConceptualResponse> {
  const query = target ? `?target=${encodeURIComponent(target)}` : '';
  return apiRequest(`/api/projects/${encodeURIComponent(projectId)}/conceptual${query}`, token);
}
