import * as path from 'path';
import * as fs from 'fs';
import { CAS_VERSION, type CapabilityFlowRole, type CASDataEntity, type CASEdge, type CASEntryPoint, type CASExitPoint, type CASNode, type CASOutput, type CASProgressiveLevels, type CASSystem, type CASTemporalStability, type CASTerminality, type FlowConcept, type FlowStep, type SystemCapability } from '../../../packages/analyzer-core/src/types/cas.types';
import { composeCas, type CASCompositionContext, type CASComprehension } from '../../../packages/analyzer-core/src/analyzer/core/cas-composition';
import { buildCasTerminality } from '../../../packages/analyzer-core/src/analyzer/core/terminality';
import { projectEntryPointFlowsFromCas } from '../../../packages/analyzer-core/src/analyzer/core/entry-point-flow-projection';
import { partitionAnalysisDiagnostics } from '../../../packages/analyzer-core/src/analyzer/core/analysis-diagnostics';
import type {
  CommunicationSeam,
  CommunicationSeamsResult,
  SeamModality,
} from '../../../packages/analyzer-core/src/analyzer/core/communication-seams';
import { buildSeamInventory } from '../../../packages/analyzer-core/src/analyzer/core/communication-seams';
import { aiService, isProviderUnavailableFailure } from '../../../packages/analyzer-core/src/ai/ai-service';
import { recordSemanticDecision } from '../../../packages/analyzer-core/src/ai/semantic-dataset';
import { ungroundedMarketingMatches } from '../../../packages/analyzer-core/src/ai/element-description-validator';
import { describeConfiguredAIProvider } from '../../../packages/analyzer-core/src/config/ai.config';
import { getCachedDeployableAnalyses } from './deployable-analysis';
import { estimatedJsonTokens } from './json-size';
import { isRuntimeEndpointSemanticName } from './semantic-roles';
import { buildPassiveDataLinks, passiveDataLifecycleRole, passiveDataOperationRole } from './workspace-passive-data';
import { buildWorkspaceCapabilityProvenance, buildWorkspaceCompositionTerminality, mergeWorkspaceCapabilityProvenance, terminalWorkspaceSystemCapabilities, type WorkspaceCapabilityProvenance } from './workspace-composition-terminality';
export type { WorkspaceCapabilityProvenance } from './workspace-composition-terminality';
export { estimatedJsonTokens } from './json-size';

export type SystemInterfaceKind =
  | 'http-api'
  | 'sdk'
  | 'message'
  | 'stream'
  | 'passive-data';

export type SystemInterfaceRole =
  | 'provider'
  | 'consumer'
  | 'publisher'
  | 'listener'
  | 'shared';

export type SystemInterfaceMode = 'sync' | 'async' | 'passive' | 'stream';
export type WorkspaceLinkEvidenceQuality =
  | 'source-backed'
  | 'package-declared'
  | 'topology-backed'
  | 'route-shape-inferred'
  | 'name-inferred';
export type WorkspaceRuntimeBehavior = 'yes' | 'no' | 'unknown';
export type WorkspaceSemanticRole = 'core' | 'supporting' | 'infrastructure';

export interface CrossCodebaseInput {
  path: string;
  name?: string;
  cas: CASOutput;
}

export interface CrossCodebaseBuildDiagnostics {
  lookup_index_builds: number;
  lookup_nodes_indexed: number;
  node_lookups: number;
  entry_lookups: number;
  exit_lookups: number;
}

interface CrossCodebaseLookupIndex {
  nodes_by_id: Map<string, CASNode>;
  entry_points_by_id: Map<string, CASEntryPoint>;
  exit_points_by_id: Map<string, CASExitPoint>;
  provider_sdk_refs: CrossCodebaseRef[];
  diagnostics?: CrossCodebaseBuildDiagnostics;
}
export interface DeployableEvidence {
  root_path: string;
  name: string;
  tier: 1 | 2 | 3;
  kind: 'container' | 'compose-service' | 'k8s' | 'serverless' | 'installer' | 'ci-deploy' | 'bin' | 'server-entry' | 'package' | 'build-image';
  evidence: string[];
  entry_files?: string[];
  ships_paths?: string[];
  ports?: number[];
  entrypoint_member?: string;
  bundled_into?: string;
}
export type WorkspaceAnalysisInput = CrossCodebaseInput;
export interface CrossCodebaseRef {
  id: string;
  name?: string;
  type?: string;
  file?: string;
  line?: number;
}

export interface SystemCodebase {
  id: string;
  name: string;
  path: string;
  project_role: 'production' | 'prototype' | 'demo' | 'infrastructure' | 'library' | 'tooling' | 'unknown';
  system_type: string;

  primary_domain?: string;

  description?: string;
  languages: string[];
  frameworks: string[];
  packages: string[];
  sdk_package_names: string[];
  graph: {
    nodes: number;
    edges: number;
    entry_points: number;
    exit_points: number;
  };
}

export type WorkspaceProject = SystemCodebase;

export interface SystemApplication {
  id: string;
  codebase_id: string;
  codebase_path: string;
  name: string;
  kind: 'app' | 'service' | 'worker' | 'package' | 'runtime-service' | 'cli' | 'tool' | 'codebase';
  deployable: boolean;
  description?: string;
  path_hint?: string;
  service_aliases: string[];
  ports: string[];
  interface_ids: string[];
  runtime_component_ids: string[];
  evidence?: string[];
  trust_guidance?: string;

  bundled_into?: string;

  boundary_evidence?: string[];

  source_sub_cas_node_id?: string;

  merged_into?: string;

  also_declared_by?: string[];
}

export type WorkspaceDeployable = SystemApplication;

export interface WorkspaceDistributionUnit {
  id: string;
  project_id: string;
  project: string;
  name: string;
  kind: string;
  platforms: string[];
  component_names: string[];
  component_deployable_ids: string[];
  artifact_paths: string[];
  confidence: number;
  evidence: Array<{ source: string; file?: string; line?: number; claim: string; confidence: number }>;
  agent_guidance?: string;
}

export interface SystemInterface {
  id: string;
  codebase_id: string;
  application_id: string;
  codebase_path: string;
  kind: SystemInterfaceKind;
  role: SystemInterfaceRole;
  mode: SystemInterfaceMode;
  name: string;
  key: string;
  protocol?: string;
  method?: string;
  endpoint?: string;
  package_name?: string;
  topic?: string;
  resource?: string;
  service_aliases?: string[];
  topology_surface?: string;
  schema?: string;
  refs: CrossCodebaseRef[];
  evidence: Array<{
    kind: 'entry_point' | 'exit_point' | 'external_service' | 'dependency' | 'configuration' | 'node' | 'schema';
    id: string;
    confidence: number;
  }>;
}

export interface SystemLink {
  id: string;
  kind: 'http-call' | 'sdk-install' | 'message-flow' | 'stream-flow' | 'shared-data';
  mode: SystemInterfaceMode;
  source_interface_id: string;
  target_interface_id: string;
  source_codebase_id: string;
  target_codebase_id: string;
  source_application_id: string;
  target_application_id: string;
  confidence: number;
  evidence_quality: WorkspaceLinkEvidenceQuality;
  evidence: string[];
}

export type WorkspaceInterfaceLink = SystemLink;

export interface SystemRuntimeComponent {
  id: string;
  codebase_id: string;
  application_id: string;
  codebase_path: string;
  name: string;
  kind: string;
  topology_surface: string;
  environment?: string;
  service_aliases: string[];
  ports: string[];
  refs: CrossCodebaseRef[];
}

export interface SystemRuntimeLink {
  id: string;
  codebase_id: string;
  source_component_id: string;
  target_component_id: string;
  kind: SystemLink['kind'];
  mode: SystemInterfaceMode;
  confidence: number;
  evidence: string[];
}

export interface SystemApplicationLink {
  id: string;
  kind: SystemLink['kind'];
  mode: SystemInterfaceMode;
  source_application_id: string;
  target_application_id: string;
  source_application_name?: string;
  target_application_name?: string;
  source_codebase_id: string;
  target_codebase_id: string;
  source_interface_id?: string;
  target_interface_id?: string;
  source_runtime_component_id?: string;
  target_runtime_component_id?: string;
  confidence: number;
  evidence_quality: WorkspaceLinkEvidenceQuality;
  evidence: string[];
  trust_guidance?: string;
}

export type WorkspaceDeployableLink = SystemApplicationLink;

export interface WorkspaceNarrative {

  source: 'ai' | 'ai-required-degraded';
  generated_at: string;
  confidence: number;
  title: string;
  description: string;
  product_value_summary: string;
  value_drivers: string[];
  domains: string[];
  key_capabilities: string[];
  relationship_summary: string[];
  evidence: string[];
  ai_required: true;
  generation_pass: 'default-summary' | 'lazy-detail';
  ai_provider?: string;
  ai_model?: string;
  ai_structured_model?: string;
  degraded_reason?: string;
}

export interface WorkspaceAiProviderMetadata {
  provider: string;
  model?: string;
  structured_model?: string;
  base_url?: string;
  hosted: boolean;
  expected_provider?: string;
  verified: boolean;
}

export type WorkspaceDescriptionSource = 'cas' | 'ai' | 'ai-required-degraded';

export interface WorkspaceDomain {
  name: string;
  description: string;
  project_ids: string[];
  evidence: string[];
  confidence: number;
  semantic_role?: WorkspaceSemanticRole;
  terminal_score?: number;
  terminal_evidence?: string[];
  description_source: WorkspaceDescriptionSource;
  ai_required: true;
  generation_pass: 'default-summary' | 'lazy-detail';
  degraded_reason?: string;
}

export interface WorkspaceAnalysisInputRef {
  project_id: string;
  codebase_id: string;
  repo_path: string;
  cas_analysis_id?: string;
  cas_version?: string;
  cas_generated_at?: string;
  repository?: {
    url?: string;
    branch?: string;
    commit?: string;
    dirty_state?: 'clean' | 'dirty' | 'unknown';
  };
  analysis_trust: WorkspaceAnalysisTrust;
}

export interface WorkspaceAnalysisTrust {
  status: 'ready' | 'warn' | 'stale' | 'missing-required-facts';
  freshness: 'fresh' | 'unknown' | 'stale';
  confidence: number;
  reasons: string[];
}

export interface WorkspaceRuntimeTopology {
  components: SystemRuntimeComponent[];
  links: SystemRuntimeLink[];
}

export type WorkspaceCompositionKind =
  | 'interconnected-system'
  | 'composed-application-architecture'
  | 'hybrid-system-and-architecture'
  | 'library-collection'
  | 'disconnected-collection';

export interface WorkspaceCompositionProfile {
  kind: WorkspaceCompositionKind;
  recommended_primary_view: 'system-map' | 'architecture-map' | 'both' | 'inventory';
  confidence: number;
  evidence_quality?: 'high' | 'medium' | 'low' | 'unknown';
  stale_input_count?: number;
  runtime_link_count: number;
  package_link_count: number;
  isolated_deployable_count: number;
  app_deployable_count: number;
  package_deployable_count: number;
  reasons: string[];
}

export interface WorkspaceOwnership {
  owner_source: 'codeowners' | 'package-metadata' | 'repository-metadata' | 'unknown';
  team?: string;
  owners: string[];
  product_area?: string;
  lifecycle?: 'production' | 'staging' | 'development' | 'archived' | 'unknown';
  tier?: 'critical' | 'important' | 'supporting' | 'experimental' | 'unknown';
}

export interface WorkspaceActivitySummary {
  status: 'active' | 'quiet' | 'unknown';
  change_rate: 'high' | 'medium' | 'low' | 'unknown';
  commits_30d: number;
  commits_90d: number;
  unique_authors_30d: number;
  lines_changed_30d: number;
  hotspots: Array<{
    project_id: string;
    deployable_id?: string;
    node_id?: string;
    label: string;
    reason: string;
    score: number;
  }>;
  contributors: Array<{
    name: string;
    projects: string[];
    commits_30d?: number;
    source: 'cas' | 'git' | 'unknown';
  }>;
}

export interface WorkspaceTelemetrySummary {
  status: 'observed' | 'instrumentable' | 'not-instrumented' | 'not-configured';
  observed_links: number;
  instrumentable_links: number;
  not_instrumented_links: number;
  stored_observations?: number;
  simulated_observations?: number;
  hot_signals: Array<{
    project_id: string;
    deployable_id?: string;
    static_id?: string;
    signal: string;
    event_count?: number;
    errors?: number;
    slow_events?: number;
    source: 'cas-runtime-link' | 'ingested' | 'simulated';
  }>;
  guidance: string[];
}

export interface WorkspaceRiskArea {
  id: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  title: string;
  reason: string;
  project_ids: string[];
  deployable_ids: string[];
  interface_ids: string[];
  confidence: number;
  evidence: string[];
  next_mcp_calls: Array<{ tool: string; args: Record<string, unknown> }>;
}


export interface WorkspaceCapability {
  id: string;
  name: string;
  description: string;
  description_source: WorkspaceDescriptionSource;
  ai_required: true;
  generation_pass: 'default-summary' | 'lazy-detail';
  degraded_reason?: string;
  semantic_role?: WorkspaceSemanticRole;
  terminal_score?: number;
  terminal_evidence?: string[];
  project_ids: string[];
  deployable_ids: string[];
  criticality: 'critical' | 'high' | 'medium' | 'low';
  evidence: string[];
  source_capability_ids?: string[];
  composition_provenance?: WorkspaceCapabilityProvenance[];
}

export interface WorkspaceWorkflow {
  id: string;
  name: string;
  description: string;
  project_ids: string[];
  deployable_ids: string[];
  interface_ids: string[];
  mode: SystemInterfaceMode | 'mixed';
  criticality: 'critical' | 'high' | 'medium' | 'low';
  semantic_role?: WorkspaceSemanticRole;
  terminal_score?: number;
  terminal_evidence?: string[];
  confidence: number;
  evidence_quality: WorkspaceLinkEvidenceQuality;
  evidence: string[];
}

export interface WorkspaceEntity {
  id: string;
  name: string;
  project_ids: string[];
  entity_refs: Array<{
    project_id: string;
    entity_id: string;
    entity_name: string;
  }>;
  related_capability_ids: string[];
  related_workflow_ids: string[];
  related_data_flow_path_ids: string[];
  sensitive_fields: string[];
  lifecycle: {
    created_by: number;
    read_by: number;
    updated_by: number;
    deleted_by: number;
    external_recipients: number;
    boundaries_crossed: number;
  };
  description?: string;
  description_source?: WorkspaceDescriptionSource;
  evidence: string[];
  confidence: number;
  semantic_role?: WorkspaceSemanticRole;
  terminal_score?: number;
  terminal_evidence?: string[];
  path_count?: number;
  path_types?: WorkspaceEntityPath['path_type'][];
  next_mcp_calls?: Array<{ tool: string; args: Record<string, unknown> }>;
}

export interface WorkspaceEntityPath {
  id: string;
  entity_name: string;
  name: string;
  description: string;
  project_ids: string[];
  path_type: 'lineage' | 'workflow' | 'capability' | 'cross-repo-flow';
  source: WorkspaceEntityPathEndpoint;
  target: WorkspaceEntityPathEndpoint;
  steps: WorkspaceEntityPathStep[];
  step_count: number;
  confidence: number;
  evidence_quality: WorkspaceLinkEvidenceQuality;
  via: Array<{
    project_id: string;
    deployable_id?: string;
    role: 'writer' | 'reader' | 'external-recipient' | 'boundary' | 'workflow' | 'capability' | 'interface-flow';
    node_id?: string;
    file?: string;
    label: string;
  }>;
  external_services: string[];
  boundaries: Array<{ boundary: string; guarded: boolean }>;
  sensitive: boolean;
  evidence: string[];
  next_mcp_calls: Array<{ tool: string; args: Record<string, unknown> }>;
}

export interface WorkspaceEntityPathEndpoint {
  project_id: string;
  deployable_id?: string;
  role: WorkspaceEntityPath['via'][number]['role'];
  label: string;
  file?: string;
  node_id?: string;
}

export interface WorkspaceEntityPathStep extends WorkspaceEntityPathEndpoint {
  sequence: number;
  edge_type: WorkspaceEntityPath['path_type'];
  evidence_quality: WorkspaceLinkEvidenceQuality;
}

export interface WorkspaceEnvironment {
  name: string;
  component_ids: string[];
  deployable_ids: string[];
  runtime_surfaces: string[];
  infrastructure_kinds: string[];
  provider?: string;
  type?: 'local' | 'cloud' | 'configuration' | 'unknown';
  resolution_status?: 'runtime-mapped' | 'infra-only' | 'configuration-only' | 'unknown';
  resolution_note?: string;
}

export interface WorkspaceInfrastructureOverlay {
  status: 'mapped' | 'partial' | 'inventory-only' | 'not-available';
  summary: string;
  environments: Array<{
    name: string;
    deployable_ids: string[];
    resource_count: number;
    resource_kinds: string[];
    key_resources: string[];
  }>;
  app_mappings: Array<{
    deployable_id: string;
    deployable_name: string;
    environment?: string;
    resource_ids: string[];
    resource_names: string[];
    evidence: string[];
  }>;
  shared_resources: Array<{
    name: string;
    kind: string;
    usage: 'source-backed' | 'topology-only' | 'declared';
    environment?: string;
    connected_deployable_ids: string[];
    evidence: string[];
  }>;
  gaps: string[];
}

export interface WorkspaceHealth {
  status: 'healthy' | 'watch' | 'at-risk' | 'unknown';
  score: number;
  summary: string;
  risk_area_count: number;
  critical_risk_count: number;
  high_risk_count: number;
  telemetry_status: WorkspaceTelemetrySummary['status'];
  analysis_trust: {
    ready_inputs: number;
    warning_inputs: number;
    stale_inputs: number;
    missing_required_fact_inputs: number;
  };
}

export interface WorkspaceValidation {
  conforms_to_was: boolean;
  missing_required_sections: string[];
  source_code_read_required: false;
  cas_inputs_validated: Array<{
    project_id: string;
    codebase_id: string;
    cas_analysis_id?: string;
    status: 'valid' | 'stale' | 'missing-required-facts';
    missing_facts: string[];
    has_nodes: boolean;
    has_edges: boolean;
    has_entry_points: boolean;
    has_exit_points: boolean;
  }>;
  relationship_coverage: {
    deployable_count: number;
    deployables_with_interfaces: number;
    deployables_with_links: number;
    integration_link_count: number;
    application_link_count: number;
    unmatched_interface_count: number;
    linked_modes: Partial<Record<SystemInterfaceMode, number>>;
  };
  known_unknowns: string[];
}

export interface WorkspaceQualityFlag {
  severity: 'info' | 'warn' | 'fail';
  code: string;
  message: string;
  evidence: string[];
}

export type WorkspaceDetailLevel = 'overview' | 'connections' | 'evidence' | 'full';

export interface WorkspaceLevelOneOverview {
  level: 'overview';
  composition: WorkspaceCompositionProfile;
  description: string;
  quality_flags?: WorkspaceQualityFlag[];
  projects: Array<{ id: string; name: string; path: string; system_type: string; project_role: SystemCodebase['project_role'] }>;
  health: WorkspaceHealth;
  activity: WorkspaceActivitySummary;
  telemetry: WorkspaceTelemetrySummary;
  risk_areas: WorkspaceRiskArea[];
  capabilities: WorkspaceCapability[];
  workflows: WorkspaceWorkflow[];
  entities: WorkspaceEntity[];
  environments: WorkspaceEnvironment[];
  infrastructure_overlay: WorkspaceInfrastructureOverlay;
  deployables: Array<{ id: string; name: string; project: string; project_id: string; project_path: string; project_role: SystemCodebase['project_role']; kind: string; surface_kind: string; deployable: boolean; ports: string[]; isolated: boolean; confidence: number; ownership: WorkspaceOwnership; description?: string; evidence?: string[]; trust_guidance?: string }>;
  distribution_units: WorkspaceDistributionUnit[];
  connections: Array<{ source: string; source_id: string; source_project_id: string; target: string; target_id: string; target_project_id: string; kind: string; mode: SystemInterfaceMode; runtime_behavior: WorkspaceRuntimeBehavior; connection_nature: string; inferred_reason?: string; confidence: number; evidence_quality: WorkspaceLinkEvidenceQuality; trust_guidance?: string; link_id: string; source_interface_id?: string; target_interface_id?: string }>;
  trusted_connections: WorkspaceLevelOneOverview['connections'];
  source_backed_connections: WorkspaceLevelOneOverview['connections'];
  candidate_connections: WorkspaceLevelOneOverview['connections'];
  external_dependencies: Array<{ name: string; kind: string; project: string; ports: string[]; used: boolean; usage: 'source-backed' | 'topology-only' | 'declared' }>;
  isolated_deployables: Array<{ id: string; name: string; project: string; project_id: string; reason: string; reason_category: 'validated-standalone' | 'weak-cas-signal' | 'unresolved-candidate' | 'no-evidence' }>;
}

export interface WorkspaceDetailViews {
  overview: WorkspaceLevelOneOverview;
  connections: {
    level: 'connections';
    overview: WorkspaceLevelOneOverview;
    integration_links: WorkspaceDeployableLink[];
    runtime_links: SystemRuntimeLink[];
    inferred_insights: SystemInsight[];
    unmatched_interfaces: UnmatchedSystemInterface[];
  };
  evidence: {
    level: 'evidence';
    overview: WorkspaceLevelOneOverview;
    interfaces: SystemInterface[];
    integration_links: WorkspaceDeployableLink[];
    runtime_topology: WorkspaceRuntimeTopology;
    distribution_units: WorkspaceDistributionUnit[];
    data_flow_paths: SystemDataFlowPath[];
    workspace_entities: WorkspaceEntity[];
    workspace_entity_paths: WorkspaceEntityPath[];
    inferred_insights: SystemInsight[];
    unmatched_interfaces: UnmatchedSystemInterface[];
    validation: WorkspaceValidation;
    shared_code_rollup: WorkspaceSharedCodeRollup[];
  };
}

export interface WorkspaceAgentContextOptions {
  task_type?: 'orient' | 'modify' | 'debug' | 'review' | 'trace' | 'cross-repo' | 'runtime';
  target?: string;
  instructions?: string;
  max_apps?: number;
  max_connections?: number;
  max_external_dependencies?: number;
}

function compactWorkspaceContextSurface(
  app: SystemApplication,
  project: SystemCodebase | undefined,
  graph: WorkspaceAnalysisGraph,
  reasons: string[],
): {
  id: string;
  name: string;
  project: string;
  project_id: string;
  project_path: string;
  project_role: SystemCodebase['project_role'] | 'unknown';
  kind: string;
  surface_kind: string;
  deployable: boolean;
  ports: string[];
  ownership?: Record<string, unknown>;
  why_selected: string[];
  trust_guidance?: string;
} {
  const projectRole = project?.project_role || 'unknown';
  const trustGuidance =
    projectRole === 'prototype' || projectRole === 'demo'
      ? 'Prototype/demo evidence; corroborate with production repo, deploy config, or source-backed links before treating as production architecture.'
      : !app.deployable
        ? 'Supporting package/library surface; use it to understand selected links, but do not treat it as a standalone deployable.'
        : undefined;
  return {
    id: app.id,
    name: app.name,
    project: project?.name || app.codebase_id,
    project_id: app.codebase_id,
    project_path: app.codebase_path,
    project_role: projectRole,
    kind: app.kind,
    surface_kind: app.kind,
    deployable: app.deployable,
    ports: app.ports,
    ownership: compactWorkspaceOwnership(graph.ownership?.[app.id] || unknownOwnership()),
    why_selected: reasons.slice(0, 1).map(reason => truncateText(reason, 72) || reason),
    trust_guidance: trustGuidance,
  };
}

export interface WorkspaceAgentContext {
  product: 'workspace_agent_context';
  analysis_id: string;
  workspace: {
    name: string;
    cas_version: string;
    generated_at: string;
    project_count: number;
    deployable_count: number;
    composition_kind?: WorkspaceCompositionKind;
    recommended_primary_view?: WorkspaceCompositionProfile['recommended_primary_view'];
  };
  task: Required<Pick<WorkspaceAgentContextOptions, 'task_type'>> & Omit<WorkspaceAgentContextOptions, 'task_type'>;
  context_budget: {
    estimated_full_was_tokens: number;
    estimated_context_tokens: number;
    estimated_token_reduction_percentage: number;
    signal_quality: 'high' | 'medium' | 'low';
    signal_reasons: string[];
  };
  system_summary: {
    product_value_summary: string;
    description: string;
    domains: string[];
    key_capabilities: string[];
    relationship_summary: string[];
    composition_reasons: string[];
  };
  selected_surfaces: Array<{
    id: string;
    name: string;
    project: string;
    project_id: string;
    kind: string;
    surface_kind: string;
    deployable: boolean;
    project_role?: SystemCodebase['project_role'];
    ports: string[];
    ownership?: Record<string, unknown>;
    why_selected: string[];
    trust_guidance?: string;
  }>;
  linked_supporting_surfaces?: Array<{
    id: string;
    name: string;
    project: string;
    project_id: string;
    kind: string;
    surface_kind: string;
    deployable: boolean;
    project_role?: SystemCodebase['project_role'];
    ports: string[];
    ownership?: Record<string, unknown>;
    why_selected: string[];
    trust_guidance?: string;
  }>;
  source_backed_connections: Array<{
    source: string;
    source_id: string;
    source_project_id: string;
    target: string;
    target_id: string;
    target_project_id: string;
    kind: string;
    mode: SystemInterfaceMode;
    runtime_behavior: WorkspaceRuntimeBehavior;
    connection_nature: string;
    inferred_reason?: string;
    confidence: number;
    evidence_quality: WorkspaceLinkEvidenceQuality;
    trust_guidance?: string;
    link_id: string;
    source_interface_id?: string;
    target_interface_id?: string;
    evidence?: string[];
  }>;
  candidate_connections: Array<{
    source: string;
    source_id: string;
    source_project_id: string;
    target: string;
    target_id: string;
    target_project_id: string;
    kind: string;
    mode: SystemInterfaceMode;
    runtime_behavior: WorkspaceRuntimeBehavior;
    connection_nature: string;
    inferred_reason?: string;
    confidence: number;
    evidence_quality: WorkspaceLinkEvidenceQuality;
    trust_guidance?: string;
    link_id: string;
    source_interface_id?: string;
    target_interface_id?: string;
    evidence?: string[];
  }>;
  selected_distribution_units: Array<Record<string, unknown>>;
  external_dependencies: Array<Record<string, unknown>>;
  isolated_deployables: Array<Record<string, unknown>>;
  risk_areas: Array<Record<string, unknown>>;
  capabilities: Array<Record<string, unknown>>;
  workflows: Array<Record<string, unknown>>;
  entities: Array<Record<string, unknown>>;
  entity_paths: Array<Record<string, unknown>>;
  health: WorkspaceHealth;
  activity: Record<string, unknown>;
  telemetry: Record<string, unknown>;
  agent_guidance: {
    read_order: string[];
    agent_should_read_next: Array<{ target: string; why: string; tool?: string; args?: Record<string, unknown> }>;
    validation: string[];
    warnings: string[];
    next_mcp_calls: Array<{ tool: string; when: string; args: Record<string, unknown> }>;
  };
}

export interface SystemInsight {
  id: string;
  type:
    | 'frontend-provider-link'
    | 'bidirectional-message-surface'
    | 'intermediary-topology'
    | 'declared-unused-infrastructure'
    | 'provider-api-without-source-consumers'
    | 'unclaimed-runtime-surface'
    | 'entity-read-without-writer';
  title: string;
  description: string;
  application_ids: string[];
  codebase_ids: string[];
  confidence: number;
  evidence: string[];
}

export interface SystemDataFlowPath {
  id: string;
  name: string;
  mode: SystemInterfaceMode;
  source_codebase_id: string;
  target_codebase_id: string;
  source_application_id: string;
  target_application_id: string;
  source_interface_id: string;
  target_interface_id: string;
  via: string[];
  description: string;
  confidence: number;
  evidence: string[];
}

export interface UnmatchedSystemInterface {
  interface_id: string;
  codebase_id: string;
  kind: SystemInterfaceKind;
  role: SystemInterfaceRole;
  mode: SystemInterfaceMode;
  name: string;
  key: string;
  reason: string;
}

export interface CrossCodebaseSystemGraph {
  parent_id: null;
  label: string;
  composition_mode: 'composed';
  children: CASOutput[];
  cas_version: string;
  analysis_id: string;
  analysis_timestamp: string;
  system: CASSystem;
  nodes: CASNode[];
  edges: CASEdge[];
  analyzer_contributions: CASOutput['analyzer_contributions'];
  progressive_levels: CASProgressiveLevels;
  capabilities: SystemCapability[];
  flows: FlowConcept[];
  steps: FlowStep[];
  entities: CASDataEntity[];
  terminality: CASTerminality;
  id: string;
  name: string;
  generated_at: string;
  inputs: WorkspaceAnalysisInputRef[];
  codebase_count: number;
  codebases: SystemCodebase[];
  projects: WorkspaceProject[];
  applications: SystemApplication[];
  deployables: WorkspaceDeployable[];
  distribution_units: WorkspaceDistributionUnit[];
  interfaces: SystemInterface[];
  runtime_components: SystemRuntimeComponent[];
  runtime_links: SystemRuntimeLink[];
  runtime_topology: WorkspaceRuntimeTopology;
  composition: WorkspaceCompositionProfile;
  ownership: Record<string, WorkspaceOwnership>;
  activity: WorkspaceActivitySummary;
  telemetry: WorkspaceTelemetrySummary;
  health: WorkspaceHealth;
  risk_areas: WorkspaceRiskArea[];
  priority_work_items: WorkspaceRiskArea[];
  workspace_capabilities: WorkspaceCapability[];
  workspace_workflows: WorkspaceWorkflow[];
  workspace_domains: WorkspaceDomain[];
  workspace_entities: WorkspaceEntity[];
  workspace_entity_paths: WorkspaceEntityPath[];
  environments: WorkspaceEnvironment[];
  infrastructure_overlay: WorkspaceInfrastructureOverlay;
  application_links: SystemApplicationLink[];
  integration_links: WorkspaceDeployableLink[];
  shared_code_rollup: WorkspaceSharedCodeRollup[];
  system_insights: SystemInsight[];
  inferred_insights: SystemInsight[];
  links: SystemLink[];
  data_flow_paths: SystemDataFlowPath[];
  unmatched_interfaces: UnmatchedSystemInterface[];
  workspace_narrative: WorkspaceNarrative;
  interpreted_by: WorkspaceAiProviderMetadata;
  detail_views: WorkspaceDetailViews;
  validation: WorkspaceValidation;
  quality_flags: WorkspaceQualityFlag[];

  workspace_complexity?: WorkspaceComplexity;

  communication_seams?: CommunicationSeamsResult;
  summary: {
    codebases: number;

    applications: number;

    application_surfaces: number;
    distribution_units: number;
    composition_kind: WorkspaceCompositionKind;
    interfaces: Record<SystemInterfaceKind, number>;
    modes: Record<SystemInterfaceMode, number>;
    links: Record<SystemLink['kind'], number>;
    runtime_components: number;
    runtime_links: number;
    application_links: number;
    system_insights: number;
    unmatched: number;
    risk_areas: number;
    capabilities: number;
    workflows: number;

    workflows_total: number;

    workflows_truncated: boolean;
    domains: number;
    entities: number;
    entity_paths: number;
  };
}

export type WorkspaceAnalysisGraph = CrossCodebaseSystemGraph;

export interface ComplexitySubscore {
  score: number;

  inputs: Record<string, number>;
}

export interface CodebaseComplexitySubscores {

  size: ComplexitySubscore;

  coupling: ComplexitySubscore;

  surface: ComplexitySubscore;

  topology: ComplexitySubscore;
}

export interface CodebaseComplexity {
  codebase_id: string;

  composite: number;
  subscores: CodebaseComplexitySubscores;

  computed_from: string[];
}

export interface WorkspaceComplexitySubscores {

  application_surface: ComplexitySubscore;

  runtime_link_density: ComplexitySubscore;

  das_verified_fraction: ComplexitySubscore;
}

export interface WorkspaceComplexity {

  composite: number;
  member_average_composite: number;
  subscores: WorkspaceComplexitySubscores;
  members: Array<{ codebase_id: string; composite: number; subscores: CodebaseComplexitySubscores }>;
  computed_from: string[];
}

function logScaleScore(value: number, saturation: number): number {
  const v = Math.max(0, value);
  const denom = Math.log1p(Math.max(1, saturation));
  const score = (Math.log1p(v) / denom) * 100;
  return Math.min(100, Math.max(0, score));
}

function linearScaleScore(value: number, ceiling: number): number {
  if (ceiling <= 0) return 0;
  const v = Math.max(0, value);
  return Math.min(100, Math.max(0, (v / ceiling) * 100));
}

function averageSubscore(scores: number[]): number {
  if (scores.length === 0) return 0;
  return scores.reduce((sum, s) => sum + s, 0) / scores.length;
}

export function computeCodebaseComplexity(codebase: SystemCodebase, repository: CrossCodebaseInput): CodebaseComplexity {
  const cas = repository.cas;
  const computedFrom: string[] = [];

  const nodeCount = codebase.graph.nodes;
  const edgeCount = codebase.graph.edges;
  computedFrom.push('graph.nodes', 'graph.edges');
  const size: ComplexitySubscore = {
    score: Math.round(averageSubscore([
      logScaleScore(nodeCount, 5000),
      logScaleScore(edgeCount, 20000),
    ])),
    inputs: { node_count: nodeCount, edge_count: edgeCount },
  };

  const directDependencyCount = (cas.dependencies?.packages || []).filter(pkg => pkg.direct).length;
  const edgeDensity = nodeCount > 0 ? edgeCount / nodeCount : 0;
  const couplingInputs: Record<string, number> = { edge_density: Number(edgeDensity.toFixed(3)) };
  const couplingScores = [linearScaleScore(edgeDensity, 10)];
  if (cas.dependencies) {
    computedFrom.push('dependencies.packages[direct]');
    couplingInputs.direct_dependency_count = directDependencyCount;
    couplingScores.push(logScaleScore(directDependencyCount, 150));
  }
  computedFrom.push('graph.edges/graph.nodes');
  const coupling: ComplexitySubscore = { score: Math.round(averageSubscore(couplingScores)), inputs: couplingInputs };

  const entryPoints = codebase.graph.entry_points;
  const exitPoints = codebase.graph.exit_points;
  computedFrom.push('graph.entry_points', 'graph.exit_points');
  const surfaceInputs: Record<string, number> = { entry_point_count: entryPoints, exit_point_count: exitPoints };
  const surfaceScores = [logScaleScore(entryPoints + exitPoints, 500)];
  const seamCounts = cas.communication_seams?.inventory?.counts;
  if (seamCounts) {
    computedFrom.push('communication_seams.inventory.counts.sync', 'communication_seams.inventory.counts.async');
    const activeSeams = seamCounts.sync + seamCounts.async;
    surfaceInputs.seam_sync_count = seamCounts.sync;
    surfaceInputs.seam_async_count = seamCounts.async;
    surfaceScores.push(logScaleScore(activeSeams, 300));
  }
  const surface: ComplexitySubscore = { score: Math.round(averageSubscore(surfaceScores)), inputs: surfaceInputs };

  const topologyInputs: Record<string, number> = {};
  const topologyScores: number[] = [];
  if (cas.deployable_evidence) {
    computedFrom.push('deployable_evidence.length');
    topologyInputs.deployable_count = cas.deployable_evidence.length;
    topologyScores.push(logScaleScore(cas.deployable_evidence.length, 10));
  }
  if (cas.entities) {
    computedFrom.push('entities.length');
    topologyInputs.entity_count = cas.entities.length;
    topologyScores.push(logScaleScore(cas.entities.length, 60));
  }
  if (cas.capabilities) {
    computedFrom.push('capabilities.length');
    topologyInputs.capability_count = cas.capabilities.length;
    topologyScores.push(logScaleScore(cas.capabilities.length, 40));
  }
  const topology: ComplexitySubscore = { score: Math.round(averageSubscore(topologyScores)), inputs: topologyInputs };

  const composite = Math.round(averageSubscore([size.score, coupling.score, surface.score, topology.score]));

  return {
    codebase_id: codebase.id,
    composite,
    subscores: { size, coupling, surface, topology },
    computed_from: Array.from(new Set(computedFrom)),
  };
}

export function computeWorkspaceComplexity(
  codebases: SystemCodebase[],
  repositories: CrossCodebaseInput[],
  applications: SystemApplication[],
  runtimeLinks: SystemRuntimeLink[],
): WorkspaceComplexity | undefined {
  if (codebases.length === 0) return undefined;

  const repositoryById = new Map(repositories.map(repository => [codebaseId(repository.path), repository]));
  const memberComplexities = codebases
    .map(codebase => {
      const repository = repositoryById.get(codebase.id);
      return repository ? computeCodebaseComplexity(codebase, repository) : undefined;
    })
    .filter((complexity): complexity is CodebaseComplexity => complexity !== undefined);
  if (memberComplexities.length === 0) return undefined;
  const members = memberComplexities.map(complexity => ({
    codebase_id: complexity.codebase_id,
    composite: complexity.composite,
    subscores: complexity.subscores,
  }));

  const memberAverageComposite = Math.round(averageSubscore(members.map(member => member.composite)));

  const applicationSurface: ComplexitySubscore = {
    score: Math.round(logScaleScore(applications.length, 40)),
    inputs: { application_count: applications.length },
  };
  const runtimeLinkDensity: ComplexitySubscore = {
    score: Math.round(logScaleScore(runtimeLinks.length, 100)),
    inputs: { runtime_link_count: runtimeLinks.length },
  };
  const dasPromotedCount = applications.filter(app => app.source_sub_cas_node_id).length;
  const dasVerifiedFraction = applications.length > 0 ? (dasPromotedCount / applications.length) * 100 : 0;
  const dasVerified: ComplexitySubscore = {
    score: Math.round(linearScaleScore(dasVerifiedFraction, 100)),
    inputs: { das_promoted_count: dasPromotedCount, application_count: applications.length },
  };

  const crossRepoScore = averageSubscore([applicationSurface.score, runtimeLinkDensity.score, dasVerified.score]);
  const composite = Math.round(memberAverageComposite * 0.6 + crossRepoScore * 0.4);

  return {
    composite,
    member_average_composite: memberAverageComposite,
    subscores: { application_surface: applicationSurface, runtime_link_density: runtimeLinkDensity, das_verified_fraction: dasVerified },
    members,
    computed_from: [
      'codebases[].graph',
      'applications.length',
      'runtime_links.length',
      'applications[].source_sub_cas_node_id',
      ...Array.from(new Set(memberComplexities.flatMap(complexity => complexity.computed_from))),
    ],
  };
}

export function crossCodebaseSystemGraphId(name: string): string {
  return slugify(name || 'system-analysis') || 'system-analysis';
}

function buildCrossCodebaseLookupIndexes(
  repositories: CrossCodebaseInput[],
  diagnostics?: CrossCodebaseBuildDiagnostics,
): Map<CASOutput, CrossCodebaseLookupIndex> {
  const indexes = new Map<CASOutput, CrossCodebaseLookupIndex>();
  for (const repository of repositories) {
    if (indexes.has(repository.cas)) continue;
    const nodesById = new Map<string, CASNode>();
    const providerSdkRefs: CrossCodebaseRef[] = [];
    for (const node of repository.cas.nodes || []) {
      nodesById.set(node.id, node);
      if (providerSdkRefs.length < 10 && ['module', 'package', 'library', 'class', 'interface', 'function'].includes(node.type)) {
        providerSdkRefs.push(nodeRef(node));
      }
    }
    if (diagnostics) {
      diagnostics.lookup_index_builds += 1;
      diagnostics.lookup_nodes_indexed += repository.cas.nodes?.length || 0;
    }
    indexes.set(repository.cas, {
      nodes_by_id: nodesById,
      entry_points_by_id: new Map((repository.cas.entry_points || []).map(entryPoint => [entryPoint.id, entryPoint])),
      exit_points_by_id: new Map((repository.cas.exit_points || []).map(exitPoint => [exitPoint.id, exitPoint])),
      provider_sdk_refs: providerSdkRefs,
      diagnostics,
    });
  }
  return indexes;
}

export function buildWorkspaceCommunicationSeams(
  codebases: SystemCodebase[],
  applicationLinks: SystemApplicationLink[],
  repositories: CrossCodebaseInput[],
): CommunicationSeamsResult | undefined {
  if (codebases.length < 2) return undefined;

  const nameByCodebaseId = new Map(codebases.map(codebase => [codebase.id, codebase.name]));
  const seams: CommunicationSeam[] = [];
  let seamSeq = 0;
  const nextSeamId = (prefix: string) => `wseam_${prefix}_${(seamSeq += 1)}`;

  for (const link of applicationLinks) {

    if (link.source_codebase_id === link.target_codebase_id) continue;
    const source = nameByCodebaseId.get(link.source_codebase_id);
    const target = nameByCodebaseId.get(link.target_codebase_id);
    if (!source || !target) continue;

    const kind = mapApplicationLinkKindToSeamKind(link.kind);
    if (!kind) continue;
    const modality: SeamModality = link.mode === 'stream' ? 'async' : link.mode;

    seams.push({
      id: nextSeamId(link.kind),
      modality,
      confidence: link.confidence,
      kind,
      source,
      target,
      evidence: link.evidence.length > 0 ? link.evidence.join('; ') : link.id,
      summary: `${source} --${modality}--> ${target} (${link.kind})`,
      ...(modality === 'passive' ? { shared_resource: link.source_application_name || link.target_application_name } : {}),
      metadata: {
        application_link_id: link.id,
        evidence_quality: link.evidence_quality,
        original_kind: link.kind,
        original_mode: link.mode,
      },
    });
  }

  seams.push(...buildSharedDependencySeams(codebases, repositories, nextSeamId));

  const workspaceInventory = buildSeamInventory(seams, 'workspace');
  return {
    seams,
    inventory: workspaceInventory,
    workspace_inventory: workspaceInventory,
  };
}

function mapApplicationLinkKindToSeamKind(kind: SystemApplicationLink['kind']): CommunicationSeam['kind'] | undefined {
  switch (kind) {
    case 'http-call':
    case 'message-flow':
    case 'stream-flow':

      return 'cross_repo_contract';
    case 'sdk-install':

      return 'exit_point';
    case 'shared-data':
      return 'passive_state';
    default:
      return undefined;
  }
}

function buildSharedDependencySeams(
  codebases: SystemCodebase[],
  repositories: CrossCodebaseInput[],
  nextSeamId: (prefix: string) => string,
): CommunicationSeam[] {
  const seams: CommunicationSeam[] = [];
  const repoByCodebaseId = new Map(repositories.map(repository => [codebaseId(repository.path), repository]));
  const nameByCodebaseId = new Map(codebases.map(codebase => [codebase.id, codebase.name]));

  const declaredBy = new Map<string, Array<{ codebaseId: string; manifests: string[] }>>();
  for (const codebase of codebases) {
    const repository = repoByCodebaseId.get(codebase.id);
    const dependencies = repository?.cas.dependency_manifest?.dependencies || [];
    for (const dependency of dependencies) {
      if (!dependency.scopes.includes('runtime')) continue;
      const key = `${dependency.ecosystem}:${dependency.name}`;
      const list = declaredBy.get(key) || [];
      list.push({ codebaseId: codebase.id, manifests: dependency.declared_in });
      declaredBy.set(key, list);
    }
  }

  const seen = new Set<string>();
  for (const [key, declarations] of declaredBy) {
    if (declarations.length < 2) continue;
    const [ecosystem, depName] = key.split(/:(.+)/);
    for (let i = 0; i < declarations.length; i++) {
      for (let j = i + 1; j < declarations.length; j++) {
        const left = declarations[i];
        const right = declarations[j];
        if (left.codebaseId === right.codebaseId) continue;
        const [a, b] = left.codebaseId < right.codebaseId ? [left, right] : [right, left];
        const pairKey = `${key}|${a.codebaseId}|${b.codebaseId}`;
        if (seen.has(pairKey)) continue;
        seen.add(pairKey);
        const sourceName = nameByCodebaseId.get(a.codebaseId);
        const targetName = nameByCodebaseId.get(b.codebaseId);
        if (!sourceName || !targetName) continue;
        seams.push({
          id: nextSeamId('dep'),
          modality: 'passive',

          confidence: 0.55,
          kind: 'shared_dependency',
          source: sourceName,
          target: targetName,
          evidence: `dependency:${depName}@${ecosystem} in ${a.manifests.join(',') || 'unknown'} & ${b.manifests.join(',') || 'unknown'}`,
          summary: `${sourceName} --passive(${depName})--> ${targetName} (shared dependency)`,
          shared_resource: depName,
          metadata: { ecosystem, dependency: depName },
        });
      }
    }
  }
  return seams;
}

export function buildCrossCodebaseSystemGraph(
  name: string,
  repositoryInputs: CrossCodebaseInput[],
  options: { id?: string; generatedAt?: string; diagnostics?: CrossCodebaseBuildDiagnostics } = {}
): CrossCodebaseSystemGraph {
  const generatedAt = options.generatedAt || new Date().toISOString();
  const repositories = repositoryInputs;
  const lookupIndexes = buildCrossCodebaseLookupIndexes(repositories, options.diagnostics);
  const codebases = repositories.map(toSystemCodebase);
  const interfaces = repositories.flatMap(repository => extractInterfaces(repository, codebaseId(repository.path), lookupIndexes.get(repository.cas)!));
  const runtimeComponents = repositories.flatMap(repository => extractRuntimeComponents(repository, codebaseId(repository.path)));
  const applications = buildApplications(codebases, interfaces, runtimeComponents, repositories);
  resolveDeployables(applications, repositories);
  linkSubCasNodes(applications, repositories);
  mergeDuplicateSubCasNodeApplications(applications);
  mergeCrossMemberSubdirApplications(applications, codebases, repositories);
  const distributionUnits = buildWorkspaceDistributionUnits(repositories, applications, codebases);
  const appByIdForLinks = new Map(applications.map(app => [app.id, app]));
  const allLinks = buildLinks(interfaces, appByIdForLinks);
  const { links, childrenByCodebase, relations, childTerminalityByCodebase } =
    buildWorkspaceCompositionTerminality(repositories, codebases, allLinks);
  const runtimeLinks = buildRuntimeLinks(runtimeComponents, interfaces, allLinks, repositories);
  const applicationLinks = buildApplicationLinks(allLinks, runtimeLinks, interfaces, runtimeComponents, applications, codebases, repositories);
  const sharedCodeRollup = buildSharedCodeRollup(repositories, applications, applicationLinks);
  let systemInsights = inferSystemInsights(codebases, applications, interfaces, applicationLinks, runtimeComponents, runtimeLinks, distributionUnits);
  const codebaseByIdForRanking = new Map(codebases.map(codebase => [codebase.id, codebase]));
  const preliminaryConnectedApps = new Set(applicationLinks.flatMap(link => [link.source_application_id, link.target_application_id]));
  const deployables = applications
    .filter(app => shouldExposeInWorkspaceOverview(app, applications))
    .sort((left, right) =>
      workspaceOverviewApplicationRank(right, codebaseByIdForRanking.get(right.codebase_id), preliminaryConnectedApps) -
        workspaceOverviewApplicationRank(left, codebaseByIdForRanking.get(left.codebase_id), preliminaryConnectedApps) ||
      left.name.localeCompare(right.name)
    );
  const inputs = buildWorkspaceInputs(repositories);
  const composition = classifyWorkspaceComposition(deployables, applicationLinks, systemInsights, inputs);
  const ownership = buildWorkspaceOwnership(applications, codebases, repositories);
  const activity = buildWorkspaceActivity(repositories, applications);
  const telemetry = buildWorkspaceTelemetry(repositories, applications);
  const capabilities = buildWorkspaceCapabilities(repositories, applications, lookupIndexes, childTerminalityByCodebase, childrenByCodebase);

  const workflowsAll = buildWorkspaceWorkflows(repositories, applications, interfaces, applicationLinks, lookupIndexes);
  const workflows = workflowsAll.slice(0, WORKSPACE_WORKFLOWS_MAX);
  const domains = buildWorkspaceDomains(repositories, codebases, name);
  const environments = buildWorkspaceEnvironments(runtimeComponents, applications, repositories);
  const infrastructureOverlay = buildWorkspaceInfrastructureOverlay(runtimeComponents, runtimeLinks, applications);
  const dataFlowPaths = links.map(link => toDataFlowPath(link, interfaces, applications));
  const entityMap = buildWorkspaceEntities(repositories, applications, capabilities, workflows, dataFlowPaths);
  systemInsights = dedupeInsights([...systemInsights, ...inferEntityGapInsights(entityMap.entities)]);
  const unmatchedInterfaces = findUnmatchedInterfaces(interfaces, allLinks);
  const riskAreas = buildWorkspaceRiskAreas(repositories, applications, interfaces, applicationLinks, systemInsights, unmatchedInterfaces, activity, telemetry, ownership, lookupIndexes);
  const health = buildWorkspaceHealth(repositories, riskAreas, telemetry);
  const workspaceNarrative = buildWorkspaceNarrative(name, generatedAt, codebases, applications, applicationLinks, systemInsights, runtimeComponents, composition, capabilities, domains);
  const validation = buildWorkspaceValidation(codebases, applications, interfaces, applicationLinks, unmatchedInterfaces, inputs, health);
  const qualityFlags = buildWorkspaceQualityFlags(workspaceNarrative, capabilities, domains, entityMap.entities, codebases, interfaces, applicationLinks, unmatchedInterfaces);
  const detailViews = buildWorkspaceDetailViews(codebases, applications, distributionUnits, interfaces, runtimeComponents, runtimeLinks, applicationLinks, systemInsights, dataFlowPaths, entityMap.entities, entityMap.paths, unmatchedInterfaces, validation, workspaceNarrative, composition, ownership, activity, telemetry, health, riskAreas, capabilities, workflows, environments, infrastructureOverlay, sharedCodeRollup);
  const workspaceComplexity = computeWorkspaceComplexity(codebases, repositories, applications, runtimeLinks);
  const communicationSeams = buildWorkspaceCommunicationSeams(codebases, applicationLinks, repositories);
  const graphId = options.id || crossCodebaseSystemGraphId(name);
  const composedCas = composeCas({
    id: graphId,
    label: name,
    cas_version: CAS_VERSION,
    analysis_id: `analysis:${graphId}:${generatedAt}`,
    analysis_timestamp: generatedAt,
    system: { id: `system:${graphId}`, name, type: 'monorepo', root_path: '.' },
    children: [...childrenByCodebase.values()],
    relations,
    derive_comprehension: context => deriveWorkspaceComprehension(workflows, entityMap.entities, capabilities, context),
  });

  const graph: CrossCodebaseSystemGraph = {
    parent_id: null,
    label: composedCas.label!,
    composition_mode: 'composed',
    children: composedCas.children!,
    cas_version: composedCas.cas_version,
    analysis_id: composedCas.analysis_id,
    analysis_timestamp: composedCas.analysis_timestamp,
    system: composedCas.system,
    nodes: composedCas.nodes,
    edges: composedCas.edges,
    analyzer_contributions: composedCas.analyzer_contributions,
    progressive_levels: composedCas.progressive_levels,
    capabilities: composedCas.capabilities || [],
    flows: composedCas.flows || [],
    steps: composedCas.steps || [],
    entities: composedCas.entities || [],
    terminality: composedCas.terminality!,
    id: graphId,
    name,
    generated_at: generatedAt,
    inputs,
    codebase_count: codebases.length,
    codebases,
    projects: codebases,
    applications,
    deployables,
    distribution_units: distributionUnits,
    interfaces,
    runtime_components: runtimeComponents,
    runtime_links: runtimeLinks,
    runtime_topology: {
      components: runtimeComponents,
      links: runtimeLinks,
    },
    composition,
    ownership,
    activity,
    telemetry,
    health,
    risk_areas: riskAreas,
    priority_work_items: riskAreas.slice(0, 10),
    workspace_capabilities: capabilities,
    workspace_workflows: workflows,
    workspace_domains: domains,
    workspace_entities: entityMap.entities,
    workspace_entity_paths: entityMap.paths,
    environments,
    infrastructure_overlay: infrastructureOverlay,
    application_links: applicationLinks,
    integration_links: applicationLinks,
    shared_code_rollup: sharedCodeRollup,
    system_insights: systemInsights,
    inferred_insights: systemInsights,
    links,
    data_flow_paths: dataFlowPaths,
    unmatched_interfaces: unmatchedInterfaces,
    workspace_narrative: workspaceNarrative,
    interpreted_by: workspaceAiProviderMetadata(),
    detail_views: detailViews,
    validation,
    quality_flags: qualityFlags,
    ...(workspaceComplexity ? { workspace_complexity: workspaceComplexity } : {}),
    ...(communicationSeams ? { communication_seams: communicationSeams } : {}),
    summary: summarize(codebases, applications, deployables, distributionUnits, interfaces, runtimeComponents, runtimeLinks, applicationLinks, systemInsights, links, unmatchedInterfaces, composition, riskAreas, capabilities, workflows, domains, entityMap.entities, entityMap.paths, workflowsAll.length),
  };
  normalizeWorkspaceNextMcpCalls(graph);
  return graph;
}

export const buildWorkspaceAnalysis = buildCrossCodebaseSystemGraph;

function deriveWorkspaceComprehension(
  workflows: WorkspaceWorkflow[],
  workspaceEntities: WorkspaceEntity[],
  workspaceCapabilities: WorkspaceCapability[],
  context: CASCompositionContext,
): CASComprehension {
  const entities: CASDataEntity[] = workspaceEntities.map(entity => {
    const referencedIds = entity.entity_refs.map(ref => `${ref.project_id}:${ref.entity_id}`);
    const lifecycleIds = (count: number) => referencedIds.slice(0, Math.min(count, referencedIds.length));
    return {
      id: entity.id,
      name: entity.name,
      description: entity.description,
      description_source: entity.description_source === 'ai' ? 'ai' : undefined,
      kind: 'domain-shape',
      kind_source: 'shape-inference',
      lifecycle: {
        created_by: lifecycleIds(entity.lifecycle.created_by),
        read_by: lifecycleIds(entity.lifecycle.read_by),
        updated_by: lifecycleIds(entity.lifecycle.updated_by),
        deleted_by: lifecycleIds(entity.lifecycle.deleted_by),
      },
      relations: [],
    };
  });
  const entityIdsByWorkflow = new Map<string, string[]>();
  for (const entity of workspaceEntities) {
    for (const workflowId of entity.related_workflow_ids) {
      entityIdsByWorkflow.set(workflowId, [...(entityIdsByWorkflow.get(workflowId) || []), entity.id]);
    }
  }
  const flows: FlowConcept[] = workflows
    .filter(workflow => workflow.project_ids.length > 1)
    .map(workflow => deriveWorkspaceFlow(workflow, entityIdsByWorkflow.get(workflow.id) || []));
  const capabilities = terminalWorkspaceSystemCapabilities(workspaceCapabilities, context.child_terminality);
  return {
    capabilities,
    flows,
    steps: flows.flatMap(flow => flow.steps),
    entities,
  };
}

function deriveWorkspaceFlow(workflow: WorkspaceWorkflow, entities: string[]): FlowConcept {
  const participants = workflow.deployable_ids.length > 0 ? workflow.deployable_ids : workflow.project_ids;
  const source = participants[0];
  const target = participants[participants.length - 1];
  const evidence = workflow.evidence[0] || `workflow:${workflow.id}`;
  const sourceStep: FlowStep = {
    step_id: `${workflow.id}:source`,
    order: 1,
    name: `Send from ${source}`,
    description: `Initiates ${workflow.name} from ${source}.`,
    description_source: 'deterministic-label',
    contract: {
      input: workflow.interface_ids.slice(0, 1),
      logic: workflow.description,
      side_effects: { state_changes: [], external_integrations: [target] },
      output: workflow.interface_ids.slice(-1),
      constraints: [],
      facet_provenance: [{ facet: 'external_integration', value: target, source: 'deterministic', evidence }],
    },
    functions: [],
    entities,
  };
  const targetStep: FlowStep = {
    step_id: `${workflow.id}:target`,
    order: 2,
    name: `Receive in ${target}`,
    description: `Completes ${workflow.name} in ${target}.`,
    description_source: 'deterministic-label',
    contract: {
      input: workflow.interface_ids.slice(-1),
      logic: workflow.description,
      side_effects: { state_changes: [], external_integrations: [] },
      output: [target],
      constraints: [],
      facet_provenance: [{ facet: 'output', value: target, source: 'deterministic', evidence }],
    },
    functions: [],
    entities,
  };
  return {
    flow_id: workflow.id,
    name: workflow.name,
    intent: workflow.description,
    entry_point: workflow.interface_ids[0] || source,
    entities,
    contract: {
      input: workflow.interface_ids.slice(0, 1),
      logic: workflow.description,
      side_effects: { state_changes: [], external_integrations: participants.slice(1) },
      output: workflow.interface_ids.slice(-1).length > 0 ? workflow.interface_ids.slice(-1) : [target],
      constraints: [],
      facet_provenance: [
        { facet: 'external_integration', value: participants.join(' -> '), source: 'deterministic', evidence },
      ],
    },
    steps: [sourceStep, targetStep],
    step_graph: { edges: [{ from_step_id: sourceStep.step_id, to_step_id: targetStep.step_id, kind: 'sequence', evidence }] },
    criticality: workflow.criticality,
  };
}

function synchronizeCanonicalWorkspaceComprehension(graph: WorkspaceAnalysisGraph): void {
  const flowsById = new Map(graph.flows.map(flow => [flow.flow_id, flow]));
  const workflowsById = new Map(graph.workspace_workflows.map(workflow => [workflow.id, workflow]));
  const candidateFlowIdsByCapability = new Map<string, Set<string>>();

  for (const capability of graph.workspace_capabilities) {
    const sourceIds = new Set(capability.source_capability_ids || [capability.id]);
    const flowIds = new Set<string>();
    for (const entity of graph.workspace_entities) {
      if (!entity.related_capability_ids.some(id => sourceIds.has(id))) continue;
      for (const workflowId of entity.related_workflow_ids) {
        if (flowsById.has(workflowId)) flowIds.add(workflowId);
      }
    }
    candidateFlowIdsByCapability.set(capability.id, flowIds);
  }

  const capabilityRank = (capability: WorkspaceCapability): number =>
    (capability.terminal_score || 0) * 100 +
    (capability.semantic_role === 'core' ? 20 : capability.semantic_role === 'supporting' ? 10 : 0) +
    criticalityRank(capability.criticality);
  const published = graph.workspace_capabilities.filter(capability =>
    capability.composition_provenance?.some(item => item.disposition === 'promoted') &&
    capability.description_source === 'ai' && capability.name.trim().length > 0 && capability.description.trim().length > 0
  );
  const primaryByFlowId = new Map<string, string>();
  for (const flow of graph.flows) {
    const candidates = published
      .filter(capability => candidateFlowIdsByCapability.get(capability.id)?.has(flow.flow_id))
      .sort((left, right) => capabilityRank(right) - capabilityRank(left) || left.id.localeCompare(right.id));
    if (candidates[0]) primaryByFlowId.set(flow.flow_id, candidates[0].id);
  }

  const canonicalCapabilities: SystemCapability[] = published.map(capability => {
    const flowIds = [...(candidateFlowIdsByCapability.get(capability.id) || [])].filter(id => flowsById.has(id));
    const relatedEntities = graph.workspace_entities
      .filter(entity => entity.related_capability_ids.some(id => (capability.source_capability_ids || [capability.id]).includes(id)))
      .map(entity => entity.id);
    const relatedFlows = flowIds.map(flowId => {
      const role: CapabilityFlowRole = primaryByFlowId.get(flowId) === capability.id
        ? 'primary'
        : capability.semantic_role === 'infrastructure'
          ? 'operational'
          : 'supporting';
      return {
        flow_id: flowId,
        role,
        rationale: `Workspace flow ${flowId} touches an entity grounded in capability ${capability.id}.`,
      };
    });
    const operations = flowIds.flatMap(flowId => {
      const flow = flowsById.get(flowId);
      if (!flow) return [];
      return [{
        entry_point_id: flow.entry_point,
        entry_point_type: 'workspace-interface',
        action: flow.name,
        path_or_command: workflowsById.get(flowId)?.interface_ids[0],
      }];
    });
    return {
      id: capability.id,
      name: capability.name,
      name_source: 'ai',
      structural_label: capability.name,
      description: capability.description,
      description_source: 'ai',
      category: capability.semantic_role === 'core'
        ? 'core'
        : capability.semantic_role === 'infrastructure'
          ? 'internal'
          : 'supporting',
      operations,
      related_entities: relatedEntities,
      related_domains: graph.workspace_domains
        .filter(domain => domain.project_ids.some(projectId => capability.project_ids.includes(projectId)))
        .map(domain => domain.name),
      criticality: capability.criticality,
      criticality_factors: capability.terminal_evidence || [],
      composition_provenance: capability.composition_provenance,
      ...(relatedFlows.length > 0 ? { related_flows: relatedFlows } : {}),
    };
  });

  const canonicalById = new Map(canonicalCapabilities.map(capability => [capability.id, capability]));
  for (const flow of graph.flows) {
    const relationships = canonicalCapabilities.flatMap(capability => {
      const relation = capability.related_flows?.find(item => item.flow_id === flow.flow_id);
      if (!relation) return [];
      return [{
        capability_id: capability.id,
        role: relation.role as 'primary' | 'supporting' | 'operational',
        rationale: relation.rationale,
        evidence: 'entity-overlap' as const,
      }];
    });
    flow.capability_relationships = relationships.length > 0 ? relationships : undefined;
    flow.capability_id = primaryByFlowId.get(flow.flow_id);
  }

  const dependencies = new Map<string, Map<string, number>>();
  for (const flow of graph.flows) {
    const primary = flow.capability_id;
    if (!primary) continue;
    for (const relationship of flow.capability_relationships || []) {
      if (relationship.capability_id === primary || relationship.role === 'primary') continue;
      const targets = dependencies.get(primary) || new Map<string, number>();
      targets.set(relationship.capability_id, (targets.get(relationship.capability_id) || 0) + 1);
      dependencies.set(primary, targets);
    }
  }
  for (const [sourceId, targets] of dependencies) {
    const source = canonicalById.get(sourceId);
    if (!source) continue;
    source.depends_on = [...targets].map(([targetId, callCount]) => ({
      from_capability: sourceId,
      to_capability: targetId,
      dependency_type: 'uses',
      strength: 'common',
      evidence: { shared_services: [], shared_nodes: [], call_count: callCount },
      description: `${source.name} uses ${canonicalById.get(targetId)?.name || targetId} across ${callCount} workspace flow${callCount === 1 ? '' : 's'}.`,
    }));
    for (const targetId of targets.keys()) {
      const target = canonicalById.get(targetId);
      if (target) target.depended_by = mergeStrings(target.depended_by || [], [sourceId]);
    }
  }

  graph.capabilities = canonicalCapabilities;
  graph.steps = graph.flows.flatMap(flow => flow.steps);
  graph.terminality = { ...buildCasTerminality(graph as unknown as CASOutput), nodes: graph.terminality.nodes };
  graph.summary.capabilities = canonicalCapabilities.length;
}

function workspaceAiProviderMetadata(): WorkspaceAiProviderMetadata {
  const provider = describeConfiguredAIProvider();
  const expectedProvider = process.env.KLAURO_EXPECT_AI_PROVIDER || process.env.KLAURO_WORKSPACE_EXPECT_AI_PROVIDER;
  return {
    provider: provider.provider,
    model: provider.model,
    structured_model: provider.structuredModel || process.env.DEEPINFRA_STRUCTURED_MODEL || process.env.OPENAI_STRUCTURED_MODEL,
    base_url: provider.baseURL,
    hosted: provider.hosted,
    expected_provider: expectedProvider,
    verified: expectedProvider ? provider.provider === expectedProvider : provider.provider !== 'fallback',
  };
}

function applyWorkspaceAiProviderMetadata(graph: WorkspaceAnalysisGraph): void {
  const metadata = workspaceAiProviderMetadata();
  graph.interpreted_by = metadata;
  graph.workspace_narrative = {
    ...graph.workspace_narrative,
    ai_provider: metadata.provider,
    ai_model: metadata.model,
    ai_structured_model: metadata.structured_model,
  };
}

function normalizeWorkspaceNextMcpCalls(graph: CrossCodebaseSystemGraph): void {
  const rewriteCalls = (calls: Array<{ tool: string; args: Record<string, unknown> }> | undefined) => {
    if (!Array.isArray(calls)) return;
    for (const call of calls) {
      if (call?.args?.analysis_id_or_name === '<workspace>') call.args.analysis_id_or_name = graph.id;
      if (call?.args?.workspace_analysis_id === '<workspace>') call.args.workspace_analysis_id = graph.id;
    }
  };
  for (const pathItem of graph.workspace_entity_paths || []) rewriteCalls(pathItem.next_mcp_calls);
  for (const entity of graph.workspace_entities || []) rewriteCalls(entity.next_mcp_calls);
  for (const risk of graph.risk_areas || []) rewriteCalls(risk.next_mcp_calls);
  for (const workItem of graph.priority_work_items || []) rewriteCalls(workItem.next_mcp_calls);
  for (const view of Object.values(graph.detail_views || {}) as any[]) {
    for (const risk of view?.risk_areas || []) rewriteCalls(risk.next_mcp_calls);
  }
}

export async function interpretWorkspaceNarrative(graph: WorkspaceAnalysisGraph): Promise<WorkspaceAnalysisGraph> {

  if (!workspaceInterpretationEnabled()) {
    throw new Error('Klauro workspace comprehension requires interpretation, but it is disabled by environment. Workspace narrative/domains/capabilities are AI-only; there is no deterministic fallback (see docs/cas/DETERMINISM-BOUNDARY.md).');
  }

  try {
    await configureWorkspaceAiProviderDefaults();
    applyWorkspaceAiProviderMetadata(graph);
    const expectedProvider = graph.interpreted_by.expected_provider;
    if (expectedProvider && graph.interpreted_by.provider !== expectedProvider) {
      throw new Error(`Expected workspace AI provider "${expectedProvider}" but configured provider is "${graph.interpreted_by.provider}"`);
    }

    graph.workspace_capabilities = await aiMergeWorkspaceCapabilities(graph);

    const mergedCoreNames = graph.workspace_capabilities.filter(capability => capability.semantic_role === 'core').map(capability => capability.name);
    if (mergedCoreNames.length > 0) {
      const sentence = ` Its core capabilities are ${joinHumanReadableList(mergedCoreNames.slice(0, 5))}.`;
      const realign = (narrative: WorkspaceNarrative | undefined) => {
        if (!narrative) return;
        narrative.key_capabilities = mergedCoreNames.slice(0, 12);
        if (typeof narrative.description === 'string' && / Its core capabilities are [^.]*\./.test(narrative.description)) {
          narrative.description = narrative.description.replace(/ Its core capabilities are [^.]*\./, sentence);
        }
      };
      realign(graph.workspace_narrative);
    }
    if (useSmallWorkspaceAiDefaultPasses()) {
      return await interpretWorkspaceNarrativeWithSmallPasses(graph);
    }
    const raw = await withWorkspaceAiTimeout(generateWorkspaceAiText(workspaceNarrativePromptContext(graph)));
    assertRealWorkspaceAiAttempt(raw);
    writeWorkspaceAiDebug(raw);
    const parsed = parseWorkspaceNarrativeJson(raw);
    const now = new Date().toISOString();
    const narrativeDescription = humanizeWorkspaceNarrativeIdentifiers(String(parsed.description || '').trim());

    let acceptedProductValueSummary: string | undefined = usefulAiProductValueSummary(parsed.product_value_summary, graph.workspace_narrative.product_value_summary, graph)
      || safeAiProductValueSummary(parsed.product_value_summary, graph.workspace_narrative.product_value_summary, graph)
      || String(graph.workspace_narrative.product_value_summary || '').trim();
    const baseNarrativeGate = evaluateWorkspaceNarrativeGate(graph, narrativeDescription, parsed.product_value_summary, graph.workspace_narrative.product_value_summary);
    if (baseNarrativeGate.accepted && !acceptedProductValueSummary) {
      acceptedProductValueSummary = await generateMissingWorkspaceProductValueSummary(
        graph,
        narrativeDescription,
        'workspace-primary-missing-product-value-summary-v1',
      );
    }
    const narrativeGate = baseNarrativeGate.accepted && !acceptedProductValueSummary
      ? { accepted: false, reason: 'missing product_value_summary: the response omitted a usable product_value_summary field — return JSON that explicitly includes a non-empty product_value_summary (one concrete, evidence-backed sentence)' }
      : baseNarrativeGate;
    graph.workspace_narrative = narrativeGate.accepted
      ? {
          ...graph.workspace_narrative,
          ai_provider: graph.interpreted_by.provider,
          ai_model: graph.interpreted_by.model,
          ai_structured_model: graph.interpreted_by.structured_model,
          source: 'ai',
          generated_at: now,
          confidence: Math.max(graph.workspace_narrative.confidence, 0.76),

          description: stripUngroundedWorkspaceMarketingLanguage(graph, narrativeDescription),
          product_value_summary: stripUngroundedWorkspaceMarketingLanguage(graph, acceptedProductValueSummary!),
          domains: parsed.domains?.length ? parsed.domains.slice(0, 12) : graph.workspace_narrative.domains,
          key_capabilities: parsed.key_capabilities?.length ? parsed.key_capabilities.slice(0, 12) : graph.workspace_narrative.key_capabilities,
          value_drivers: cleanWorkspaceValueDrivers(graph, parsed.value_drivers, graph.workspace_narrative.value_drivers),

          relationship_summary: graph.workspace_narrative.relationship_summary,
          degraded_reason: undefined,
        }
      : {
          ...graph.workspace_narrative,
          ai_provider: graph.interpreted_by.provider,
          ai_model: graph.interpreted_by.model,
          ai_structured_model: graph.interpreted_by.structured_model,
          source: 'ai-required-degraded',
          generated_at: now,
          degraded_reason: `Workspace interpretation was rejected by the workspace narrative quality gate: ${narrativeGate.reason}`,
        };

    recordSemanticDecision({
      ts: Date.now(),
      decision_type: 'workspace_narrative',
      prompt_version: 'workspace_narrative.v1',
      provider: graph.interpreted_by.provider,
      model: graph.interpreted_by.model,
      input_evidence_digest: {
        codebases: graph.codebases.length,
        workspace_capabilities: graph.workspace_capabilities.length,
        workspace_domains: graph.workspace_domains.length,
        merged_core_capabilities: mergedCoreNames.length,
      },
      raw_output_excerpt: narrativeDescription,
      parse_ok: true,
      gate_verdict: narrativeGate.accepted ? 'accepted' : 'degraded',
      gate_reason: narrativeGate.accepted ? undefined : narrativeGate.reason,
      confidence: graph.workspace_narrative.confidence,
      final_outcome: narrativeGate.accepted ? 'ai' : 'degraded',
    });
    graph.workspace_domains = invalidateDuplicateWorkspaceDomainDescriptions(applyAiDomainDescriptions(graph.workspace_domains, parsed.domain_items || [], now));
    graph.workspace_capabilities = applyAiCapabilityDescriptions(graph.workspace_capabilities, parsed.capability_items || [], now);
    graph.workspace_capabilities = invalidateDuplicateWorkspaceCapabilityDescriptions(graph.workspace_capabilities);
    graph.workspace_workflows = applyAiWorkflowDescriptions(graph.workspace_workflows, parsed.workflow_items || [], now);
    graph.workspace_entities = applyAiEntityDescriptions(graph.workspace_entities, parsed.entity_items || [], now);

    stripWorkspaceItemDescriptionArtifacts(graph);
    if (graph.workspace_narrative.source !== 'ai') {

      for (let attempt = 0; attempt < 3 && graph.workspace_narrative.source !== 'ai'; attempt += 1) {
        graph.workspace_narrative = await repairRejectedWorkspaceNarrative(graph, now, graph.workspace_narrative.degraded_reason, attempt);
      }
    }
    const defaultDescriptionRepairAttempts = Math.max(0, Number(process.env.KLAURO_WORKSPACE_AI_REPAIR_ATTEMPTS || '2'));
    for (let repairAttempt = 0; repairAttempt < defaultDescriptionRepairAttempts; repairAttempt += 1) {
      const repair = await repairMissingDefaultWorkspaceDescriptions(graph);
      graph.workspace_domains = invalidateDuplicateWorkspaceDomainDescriptions(repair.domains);
      graph.workspace_capabilities = invalidateDuplicateWorkspaceCapabilityDescriptions(repair.capabilities);
      const synced = syncMatchingWorkspaceDomainCapabilityDescriptions(graph.workspace_domains, graph.workspace_capabilities, now);
      graph.workspace_domains = invalidateDuplicateWorkspaceDomainDescriptions(synced.domains);
      graph.workspace_capabilities = invalidateDuplicateWorkspaceCapabilityDescriptions(synced.capabilities);
      const stillMissingDefaultDescriptions =
        graph.workspace_domains.slice(0, 6).some(item => !isDefaultWorkspaceDescriptionReady(item.name, item.description, item.description_source, 'domain')) ||
        graph.workspace_capabilities.slice(0, 8).some(item => !isDefaultWorkspaceDescriptionReady(item.name, item.description, item.description_source, 'capability'));
      if (!stillMissingDefaultDescriptions) break;
    }
    finalizeRequiredWorkspaceAiSemantics(graph, now);
    graph.workspace_narrative.domains = primaryWorkspaceDomains(graph).map(item => item.name);
    graph.workspace_narrative.key_capabilities = primaryWorkspaceCapabilities(graph).map(item => item.name);

    {
      const aiCount = (items: Array<{ description_source?: string }>) => items.filter(item => item.description_source === 'ai').length;
      const domainsAi = aiCount(graph.workspace_domains);
      const capsAi = aiCount(graph.workspace_capabilities);
      const totalItems = graph.workspace_domains.length + graph.workspace_capabilities.length;
      const totalAi = domainsAi + capsAi;
      recordSemanticDecision({
        ts: Date.now(),
        decision_type: 'workspace_item_descriptions',
        prompt_version: 'workspace_item_descriptions.v1',
        provider: graph.interpreted_by.provider,
        model: graph.interpreted_by.model,
        input_evidence_digest: {
          domains: graph.workspace_domains.length,
          capabilities: graph.workspace_capabilities.length,
          domains_ai: domainsAi,
          capabilities_ai: capsAi,
        },
        parse_ok: true,
        gate_verdict: totalItems > 0 && totalAi === totalItems ? 'accepted' : totalAi > 0 ? 'degraded' : 'rejected',
        gate_reason: totalAi < totalItems ? `${totalItems - totalAi}-items-not-ai-sourced` : undefined,
        final_outcome: totalAi > 0 ? 'ai' : 'degraded',
      });
    }
    await enforceWorkspaceNarrativeProductValueSummary(graph);

    stripWorkspaceItemDescriptionArtifacts(graph);
    synchronizeCanonicalWorkspaceComprehension(graph);
    graph.detail_views.overview.capabilities = graph.workspace_capabilities.slice(0, 12);
    graph.detail_views.overview.workflows = graph.workspace_workflows.slice(0, 12);
    graph.detail_views.overview.entities = graph.workspace_entities.slice(0, 12);
    graph.detail_views.overview.description = graph.workspace_narrative.description;
    graph.quality_flags = buildWorkspaceQualityFlags(graph.workspace_narrative, graph.workspace_capabilities, graph.workspace_domains, graph.workspace_entities, graph.codebases, graph.interfaces, graph.application_links, graph.unmatched_interfaces);
    graph.detail_views.overview.quality_flags = graph.quality_flags;
    return graph;
  } catch (error) {
    if (/no real attempt/i.test(error instanceof Error ? error.message : String(error))) {
      throw error;
    }
    if (isProviderUnavailableFailure(error)) {
      throw error;
    }

    const fallback = await interpretWorkspaceNarrativeWithSmallPasses(graph, error);
    if (fallback.workspace_narrative.source === 'ai' || !fallback.quality_flags?.some(flag => flag.code === 'capability-descriptions-degraded' || flag.code === 'domain-descriptions-degraded')) {
      return fallback;
    }
    throw new Error(`Klauro workspace comprehension failed (AI): ${error instanceof Error ? error.message : String(error)}. Workspace narrative/domains/capabilities are AI-only; there is no deterministic fallback.`);
  }
}

async function interpretWorkspaceNarrativeWithSmallPasses(
  graph: WorkspaceAnalysisGraph,
  initialError?: unknown,
): Promise<WorkspaceAnalysisGraph> {
  const generatedAt = new Date().toISOString();
  if (initialError && graph.workspace_narrative.source !== 'ai') {
    graph.workspace_narrative = {
      ...graph.workspace_narrative,
      source: 'ai-required-degraded',
      generated_at: generatedAt,
      degraded_reason: `Workspace AI primary pass failed; running smaller enrichment passes: ${initialError instanceof Error ? initialError.message : String(initialError)}`,
    };
  }

  for (let attempt = 0; attempt < 3 && graph.workspace_narrative.source !== 'ai'; attempt += 1) {
    graph.workspace_narrative = await repairRejectedWorkspaceNarrative(graph, generatedAt, graph.workspace_narrative.degraded_reason, attempt);
  }

  const defaultDescriptionRepairAttempts = Math.max(1, Number(process.env.KLAURO_WORKSPACE_AI_REPAIR_ATTEMPTS || '2'));
  for (let repairAttempt = 0; repairAttempt < defaultDescriptionRepairAttempts; repairAttempt += 1) {
    const repair = await repairMissingDefaultWorkspaceDescriptions(graph);
    graph.workspace_domains = invalidateDuplicateWorkspaceDomainDescriptions(repair.domains);
    graph.workspace_capabilities = invalidateDuplicateWorkspaceCapabilityDescriptions(repair.capabilities);
    const synced = syncMatchingWorkspaceDomainCapabilityDescriptions(graph.workspace_domains, graph.workspace_capabilities, generatedAt);
    graph.workspace_domains = invalidateDuplicateWorkspaceDomainDescriptions(synced.domains);
    graph.workspace_capabilities = invalidateDuplicateWorkspaceCapabilityDescriptions(synced.capabilities);
    const stillMissingDefaultDescriptions =
      graph.workspace_domains.slice(0, 6).some(item => !isDefaultWorkspaceDescriptionReady(item.name, item.description, item.description_source, 'domain')) ||
      graph.workspace_capabilities.slice(0, 8).some(item => !isDefaultWorkspaceDescriptionReady(item.name, item.description, item.description_source, 'capability'));
    if (!stillMissingDefaultDescriptions) break;
  }
  finalizeRequiredWorkspaceAiSemantics(graph, generatedAt);
  graph.workspace_narrative.domains = primaryWorkspaceDomains(graph).map(item => item.name);
  graph.workspace_narrative.key_capabilities = primaryWorkspaceCapabilities(graph).map(item => item.name);
  await enforceWorkspaceNarrativeProductValueSummary(graph);
  applyWorkspaceAiProviderMetadata(graph);

  stripWorkspaceItemDescriptionArtifacts(graph);
  synchronizeCanonicalWorkspaceComprehension(graph);

  graph.detail_views.overview.capabilities = graph.workspace_capabilities.slice(0, 12);
  graph.detail_views.overview.workflows = graph.workspace_workflows.slice(0, 12);
  graph.detail_views.overview.entities = graph.workspace_entities.slice(0, 12);
  graph.detail_views.overview.description = graph.workspace_narrative.description;
  graph.quality_flags = buildWorkspaceQualityFlags(graph.workspace_narrative, graph.workspace_capabilities, graph.workspace_domains, graph.workspace_entities, graph.codebases, graph.interfaces, graph.application_links, graph.unmatched_interfaces);
  graph.detail_views.overview.quality_flags = graph.quality_flags;
  return graph;
}

function useSmallWorkspaceAiDefaultPasses(): boolean {
  if (process.env.KLAURO_WORKSPACE_AI_STRATEGY === 'single') return false;
  if (process.env.KLAURO_WORKSPACE_AI_STRATEGY === 'split') return true;
  return false;
}

export function assertRealWorkspaceAiAttempt(raw: string): void {
  const text = String(raw || '').trim();
  if (!text) {
    throw new Error('Workspace interpretation returned an empty response — no usable AI attempt was made (provider misconfigured, out of budget, or empty completion). This is an enrichment error, not a quality-gate rejection.');
  }
  if (/^AI description generation is disabled\b/i.test(text)) {
    throw new Error('Workspace interpretation made no real attempt: the AI service reports description generation is disabled (features.naturalLanguageDescriptions=false). Enable an AI provider and retry; this is an enrichment error, not a quality-gate rejection.');
  }
}

async function generateWorkspaceAiText(additionalContext: Record<string, unknown>): Promise<string> {
  if (useDirectOllamaWorkspaceAi()) {
    return await generateWorkspaceOllamaJson(additionalContext);
  }

  const model = (additionalContext.model as string) || process.env.DEEPINFRA_STRUCTURED_MODEL || process.env.OPENAI_STRUCTURED_MODEL || undefined;
  return await aiService.generateComponentDescription({ additionalContext: { ...additionalContext, model } });
}

async function aiMergeWorkspaceCapabilities(graph: WorkspaceAnalysisGraph): Promise<WorkspaceCapability[]> {
  const sourceCapabilities = graph.workspace_capabilities || [];
  const capabilities = sourceCapabilities.filter(capability => capability.composition_provenance?.some(item => item.disposition === 'promoted'));
  const absorbedCapabilities = sourceCapabilities.filter(capability => !capabilities.includes(capability));
  if (capabilities.length < 4) return sourceCapabilities;
  const codebaseNameById = new Map((graph.codebases || []).map(codebase => [codebase.id, codebase.name]));
  const entitiesOf = (capability: WorkspaceCapability) => mergeStrings([], [
    ...capability.evidence.filter(item => item.startsWith('entity:')).map(item => item.replace(/^entity:/, '')),
    ...(capability.terminal_evidence || []).filter(item => item.startsWith('entity:')).map(item => item.replace(/^entity:/, '')),
  ]).slice(0, 6);
  const bundle = capabilities.map(capability => ({
    name: capability.name,
    description: capability.description,
    role: capability.semantic_role || 'supporting',
    codebases: capability.project_ids.map(id => codebaseNameById.get(id) || id),
    entities: entitiesOf(capability),
  }));

  let raw: string;
  try {
    raw = await withWorkspaceAiTimeout(generateWorkspaceAiText({
      task: 'Compose the supplied member-codebase capabilities into one workspace capability catalog. Merge only capabilities whose supplied meanings and evidence overlap. Preserve distinct responsibilities and preserve read, write, mutation, and access semantics exactly. A concern may be core when terminality and member comprehension show that the software exists to provide it; never demote or discard it merely because other systems often treat it as infrastructure. Every output item must cite one or more exact input names in source_names. Do not invent an item, split one source into unsupported variants, infer from project names, or use a fixed catalog size. Return only valid JSON: {"capabilities":[{"title":"...","description":"...","category":"core|supporting|infrastructure","source_names":["..."]}]}.',
      style: 'Write titles and descriptions in concise product-manager language grounded only in the supplied member comprehension. Use no markdown, implementation inventory, generic filler, or predetermined domain vocabulary.',
      capabilities: bundle,
      product_name: graph.name,
      product_domain: (graph.workspace_narrative?.product_value_summary || '').slice(0, 200),
    }));
  } catch {
    return capabilities;
  }

  let parsed: Array<Record<string, unknown>>;
  try {
    let text = String(raw || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) text = text.slice(start, end + 1);
    const obj = JSON.parse(text);

    parsed = Array.isArray(obj?.capabilities) ? obj.capabilities
      : Array.isArray(obj?.key_capabilities) ? obj.key_capabilities
      : Array.isArray(obj) ? obj
      : [];
  } catch {
    return capabilities;
  }
  if (parsed.length < 3) return capabilities;

  const byName = new Map(capabilities.map(capability => [capability.name.toLowerCase(), capability]));
  const merged: WorkspaceCapability[] = [];
  const seen = new Set<string>();
  const seenDescriptions = new Set<string>();
  for (const item of parsed) {
    const title = String(item.title || '').replace(/\s+/g, ' ').trim();
    let description = String(item.description || '');

    if (description.includes('{') || /"description"\s*:|key_capabilities/i.test(description) || isWorkspaceAiParseArtifactText(description)) description = '';
    description = description

      .replace(/\s+(?:through|using|via)\s+(?:the\s+)?[^.]*?\b(?:api|apis|routes?|endpoints?|operations?|deployables?|controllers?)\b[^.]*/gi, '')
      .replace(/\s+(?:and|with)\s+related\s+entit[^.]*/gi, '')
      .replace(/\b[a-z]+:\/[^\s.]*/gi, '')
      .replace(/^owns\s+/i, 'manages ')
      .replace(/\s+/g, ' ').trim();
    if (!title || description.length < 20) continue;
    const key = title.toLowerCase();
    if (seen.has(key)) continue;

    const descKey = normalizeAiItemName(description).slice(0, 60);
    if (seenDescriptions.has(descKey)) continue;
    seen.add(key);
    seenDescriptions.add(descKey);
    const sources = (Array.isArray(item.source_names) ? item.source_names : [])
      .map((value: unknown) => byName.get(String(value || '').toLowerCase()))
      .filter((value: WorkspaceCapability | undefined): value is WorkspaceCapability => Boolean(value));
    if (sources.length === 0) continue;
    const role: WorkspaceSemanticRole = item.category === 'core'
      ? 'core'
      : item.category === 'infrastructure'
        ? 'infrastructure'
        : 'supporting';
    merged.push({
      id: `workspace-capability:${slugify(title)}`,
      name: title,
      description,
      description_source: 'ai',
      ai_required: true,
      generation_pass: 'default-summary',
      semantic_role: role,
      terminal_score: sources.length ? Math.max(...sources.map(source => source.terminal_score || 0)) : undefined,
      terminal_evidence: mergeStrings([], sources.flatMap(source => source.terminal_evidence || [])).slice(0, 8),

      project_ids: mergeStrings([], sources.flatMap(source => source.project_ids)),
      deployable_ids: mergeStrings([], sources.flatMap(source => source.deployable_ids)),
      criticality: role === 'core' ? 'high' : 'medium',
      evidence: mergeStrings([], sources.flatMap(source => source.evidence)).slice(0, 12),
      source_capability_ids: mergeStrings([], sources.flatMap(source => source.source_capability_ids || [source.id])),
      composition_provenance: sources.flatMap(source => source.composition_provenance || []),
    });
  }
  if (merged.length < 3) return capabilities;
  return [...merged.slice(0, 24), ...absorbedCapabilities];
}

function useDirectOllamaWorkspaceAi(): boolean {
  return false;
}

async function generateWorkspaceOllamaJson(additionalContext: Record<string, unknown>): Promise<string> {
  const baseURL = (process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');
  const model = process.env.OLLAMA_MODEL || process.env.KLAURO_WORKSPACE_OLLAMA_MODEL || 'mistral:latest';
  const maxTokens = Math.max(80, Number((additionalContext as any).maxTokens || (additionalContext as any).max_tokens || 320));
  const timeoutMs = Math.max(1, Number(process.env.KLAURO_OLLAMA_TIMEOUT_MS || process.env.KLAURO_WORKSPACE_AI_TIMEOUT_MS || 15_000));
  const promptPayload = workspaceDirectPromptPayload(additionalContext);
  const prompt = [
    'You are Klauro workspace analysis AI.',
    'Return one valid JSON object only. Do not add markdown, comments, explanations, or copied prompt keys.',
    'Use only the supplied deterministic workspace-level CAS facts. Do not invent links, deployables, dependencies, business claims, customers, or runtime behavior.',
    'Every description must be concrete, evidence-backed, and useful to a senior engineer or AI coding agent.',
    `TASK: ${String((additionalContext as any).task || 'Generate the requested workspace JSON.')}`,
    `OUTPUT SHAPE: ${JSON.stringify((additionalContext as any).output_schema || workspaceDirectOutputShape(additionalContext))}`,
    `RULES: ${JSON.stringify(workspaceDirectRules(additionalContext))}`,
    `FACTS: ${JSON.stringify(promptPayload)}`,
  ].join('\n');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref?.();
  try {
    const response = await fetch(`${baseURL}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        stream: false,
        think: false,
        format: 'json',
        options: {
          temperature: Number(process.env.KLAURO_WORKSPACE_AI_TEMPERATURE || '0'),
          seed: Number(process.env.KLAURO_WORKSPACE_AI_SEED || '7'),
          num_predict: maxTokens,
        },
      }),
    });
    const body = await response.json().catch(() => ({})) as Record<string, any>;
    if (!response.ok) {
      throw new Error(`Ollama returned ${response.status}: ${JSON.stringify(body).slice(0, 500)}`);
    }
    return typeof body.message?.content === 'string' ? body.message.content : JSON.stringify(body);
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'name' in error && (error as any).name === 'AbortError') {
      throw new Error(`Ollama workspace AI request timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function workspaceDirectPromptPayload(additionalContext: Record<string, unknown>): Record<string, unknown> {
  const {
    responseFormat: _responseFormat,
    response_format: _response_format,
    compactPrompt: _compactPrompt,
    compact_prompt: _compact_prompt,
    maxTokens: _maxTokens,
    max_tokens: _max_tokens,
    prompt_version: _promptVersion,
    task: _task,
    output_schema: _outputSchema,
    rules: _rules,
    required_output_rules: _requiredOutputRules,
    quality_gate: _qualityGate,
    style: _style,
    contract: _contract,
    ...facts
  } = additionalContext as any;
  return facts;
}

function workspaceDirectRules(additionalContext: Record<string, unknown>): string[] {
  return [
    ...(((additionalContext as any).required_output_rules || []) as string[]),
    ...(((additionalContext as any).rules || []) as string[]),
    String((additionalContext as any).quality_gate || '').trim(),
    String((additionalContext as any).contract || '').trim(),
  ].filter(Boolean).slice(0, 18);
}

function workspaceDirectOutputShape(additionalContext: Record<string, unknown>): Record<string, unknown> {
  if (Array.isArray((additionalContext as any).target_domains) || Array.isArray((additionalContext as any).target_capabilities)) {
    return {
      domain_items: [{ name: 'exact target domain name', description: 'specific evidence-backed sentence using one grounding term' }],
      capability_items: [{ name: 'exact target capability name', description: 'specific evidence-backed sentence using one grounding term' }],
    };
  }
  return {
    description: 'one concrete paragraph',
    product_value_summary: 'one concrete sentence',
    domain_items: [{ name: 'exact required domain name', description: 'specific evidence-backed sentence' }],
    capability_items: [{ name: 'exact required capability name', description: 'specific evidence-backed sentence' }],
    value_drivers: ['short evidence-backed value driver'],
    relationship_summary: ['source -> target relationship from facts'],
  };
}

async function repairRejectedWorkspaceNarrative(
  graph: WorkspaceAnalysisGraph,
  generatedAt: string,
  rejectionReason?: string,
  attempt?: number,
): Promise<WorkspaceNarrative> {
  try {
    const raw = await withWorkspaceAiTimeout(generateWorkspaceAiText(workspaceNarrativeRepairPromptContext(graph, rejectionReason, attempt)));
    assertRealWorkspaceAiAttempt(raw);
    writeWorkspaceAiRepairDebug({ stage: 'narrative-repair-raw', attempt: attempt ?? 0, rejection_reason: truncateText(rejectionReason, 400), raw: truncateText(raw, 1800) });
    const parsed = parseWorkspaceNarrativeJson(raw);
    const description = humanizeWorkspaceNarrativeIdentifiers(
      String(parsed.description || cleanNarrativeString(raw) || '').trim()
    );

    let repairedProductValueSummary: string | undefined = usefulAiProductValueSummary(parsed.product_value_summary, graph.workspace_narrative.product_value_summary, graph)
      || safeAiProductValueSummary(parsed.product_value_summary, graph.workspace_narrative.product_value_summary, graph)
      || String(graph.workspace_narrative.product_value_summary || '').trim();
    const baseGate = evaluateWorkspaceNarrativeGate(graph, description, parsed.product_value_summary, graph.workspace_narrative.product_value_summary);
    if (baseGate.accepted && !repairedProductValueSummary) {
      repairedProductValueSummary = await generateMissingWorkspaceProductValueSummary(
        graph,
        description,
        `workspace-repair-missing-product-value-summary-v1-${attempt ?? 0}`,
      );
    }
    const gate = baseGate.accepted && !repairedProductValueSummary
      ? { accepted: false, reason: 'missing product_value_summary: the response omitted a usable product_value_summary field — return JSON that explicitly includes a non-empty product_value_summary (one concrete, evidence-backed sentence)' }
      : baseGate;
    if (!gate.accepted) {
      return {
        ...graph.workspace_narrative,
        degraded_reason: `Workspace interpretation was rejected by the workspace narrative quality gate: ${gate.reason}`,
      };
    }
    const metadata = workspaceAiProviderMetadata();
    return {
      ...graph.workspace_narrative,
      source: 'ai',
      generated_at: generatedAt,
      confidence: Math.max(graph.workspace_narrative.confidence, 0.74),
      description: stripUngroundedWorkspaceMarketingLanguage(graph, description),
      product_value_summary: stripUngroundedWorkspaceMarketingLanguage(graph, repairedProductValueSummary!),
      ai_provider: metadata.provider,
      ai_model: metadata.model,
      ai_structured_model: metadata.structured_model,
      degraded_reason: undefined,
    };
  } catch {
    return graph.workspace_narrative;
  }
}

export async function enforceWorkspaceNarrativeProductValueSummary(graph: WorkspaceAnalysisGraph): Promise<void> {
  const narrative = graph.workspace_narrative;
  if (!narrative || narrative.source !== 'ai') return;
  if (String(narrative.product_value_summary || '').trim()) return;
  try {
    const raw = await withWorkspaceAiTimeout(generateWorkspaceAiText({
      responseFormat: 'json',
      maxTokens: Number(process.env.KLAURO_WORKSPACE_AI_REPAIR_MAX_TOKENS || '240'),
      prompt_version: 'workspace-missing-product-value-summary-v1',
      task: 'The accepted workspace narrative is missing its REQUIRED product_value_summary field. Return only valid JSON shaped {"product_value_summary":"..."} — one concrete, evidence-backed sentence explaining the product/business job this workspace serves.',
      rejection_feedback: 'missing product_value_summary: the previous response omitted or emptied the product_value_summary field. You must return the product_value_summary field explicitly and non-empty.',
      rules: [
        'Return the product_value_summary field explicitly; never omit or empty it.',
        'One sentence, plain product language, grounded in the supplied description and capabilities only.',
        'No raw internal identifiers, hashes, route paths, or marketing language.',
      ],
      workspace_description: narrative.description,
      key_capabilities: (narrative.key_capabilities || []).slice(0, 8),
      domains: (narrative.domains || []).slice(0, 8),
    }));
    assertRealWorkspaceAiAttempt(raw);
    const parsed = parseWorkspaceNarrativeJson(raw);
    const summary = usefulAiProductValueSummary(parsed.product_value_summary, narrative.product_value_summary, graph)
      || safeAiProductValueSummary(parsed.product_value_summary, narrative.product_value_summary, graph);
    if (summary && !workspaceNarrativeHardRejectReason(narrative.description, summary)) {
      graph.workspace_narrative = { ...narrative, product_value_summary: summary };
      return;
    }
  } catch {

  }
  graph.workspace_narrative = {
    ...narrative,
    source: 'ai-required-degraded',
    degraded_reason: 'missing product_value_summary: the AI narrative was accepted without a product_value_summary and one field-naming re-prompt did not supply a usable one',
  };
}

async function generateMissingWorkspaceProductValueSummary(
  graph: WorkspaceAnalysisGraph,
  description: string,
  promptVersion: string,
): Promise<string | undefined> {
  try {
    const raw = await withWorkspaceAiTimeout(generateWorkspaceAiText({
      responseFormat: 'json',
      maxTokens: Number(process.env.KLAURO_WORKSPACE_AI_REPAIR_MAX_TOKENS || '240'),
      prompt_version: promptVersion,
      task: 'The workspace narrative passed its quality gate but omitted the REQUIRED product_value_summary. Return only valid JSON shaped {"product_value_summary":"..."}.',
      rejection_feedback: 'missing product_value_summary: return that exact field explicitly and non-empty.',
      rules: [
        'Write one concrete sentence explaining the product or operational job evidenced by the member analyses.',
        'Preserve observed read-only versus mutating behavior exactly.',
        'Do not claim that independent projects interact.',
        'No raw identifiers, implementation-stack framing, source mechanics, or marketing language.',
      ],
      workspace_description: description,
      member_analyses: graph.codebases.slice(0, 12).map(codebase => ({
        name: codebase.name,
        description: codebase.description,
        capabilities: graph.workspace_capabilities
          .filter(capability => capability.project_ids.includes(codebase.id))
          .slice(0, 8)
          .map(capability => ({
          name: capability.name,
          description: capability.description,
          })),
      })),
      workspace_capabilities: primaryWorkspaceCapabilities(graph).slice(0, 10).map(capability => ({
        name: capability.name,
        description: capability.description,
      })),
    }));
    assertRealWorkspaceAiAttempt(raw);
    const parsed = parseWorkspaceNarrativeJson(raw);
    const candidate = parsed.product_value_summary || (
      /^\s*(?!\{)[^\n{}]{20,400}\s*$/.test(raw)
        ? cleanNarrativeSummaryString(raw)
        : undefined
    );
    const summary = usefulAiProductValueSummary(candidate, graph.workspace_narrative.product_value_summary, graph)
      || safeAiProductValueSummary(candidate, graph.workspace_narrative.product_value_summary, graph);
    if (!summary || workspaceNarrativeHardRejectReason(description, summary)) return undefined;
    return stripUngroundedWorkspaceMarketingLanguage(graph, summary);
  } catch {
    return undefined;
  }
}

async function configureWorkspaceAiProviderDefaults(): Promise<void> {
  if (process.env.KLAURO_WORKSPACE_AI_AUTO_CONFIG === 'false') return;
  return;
}

export function selectPreferredWorkspaceOllamaModel(models: string[]): string | undefined {
  const available = models.map(model => String(model || '').trim()).filter(Boolean);
  const explicit = process.env.KLAURO_WORKSPACE_OLLAMA_MODEL;
  if (explicit && available.some(model => model === explicit)) return explicit;
  const preferred = [
    /^mistral\b/i,
    /^qwen3:8b$/i,
    /^qwen3-coder\b/i,
    /^qwen3\b/i,
    /^qwen2\.5\b/i,
    /^llama3(?:\.1|\.2|\.3)?\b/i,
    /^llama\b/i,
  ];
  for (const pattern of preferred) {
    const match = available.find(model => pattern.test(model));
    if (match) return match;
  }
  return available[0];
}

async function repairMissingDefaultWorkspaceDescriptions(graph: WorkspaceAnalysisGraph): Promise<{ domains: WorkspaceDomain[]; capabilities: WorkspaceCapability[] }> {
  const missingDomains = graph.workspace_domains.slice(0, 6).filter(item => !isDefaultWorkspaceDescriptionReady(item.name, item.description, item.description_source, 'domain'));
  const missingCapabilities = graph.workspace_capabilities.slice(0, 8).filter(item => !isDefaultWorkspaceDescriptionReady(item.name, item.description, item.description_source, 'capability'));
  if (missingDomains.length + missingCapabilities.length === 0) {
    return { domains: graph.workspace_domains, capabilities: graph.workspace_capabilities };
  }
  let domains = graph.workspace_domains;
  let capabilities = graph.workspace_capabilities;
  try {
    const generatedAt = new Date().toISOString();
    if (useDirectOllamaWorkspaceAi()) {
      if (missingDomains.length > 0) {
        const domainRaw = await withWorkspaceAiTimeout(generateWorkspaceAiText(workspaceDescriptionRepairPromptContext(graph, missingDomains, [])));
        writeWorkspaceAiRepairDebug({ stage: 'domain-description-repair-raw', raw: truncateText(domainRaw, 2400) });
        const domainParsed = parseWorkspaceNarrativeJson(domainRaw);
        domains = applyAiDomainDescriptions(domains, workspaceDescriptionRepairItems(domainParsed, 'domain'), generatedAt);
      }
      if (missingCapabilities.length > 0) {
        const capabilityRaw = await withWorkspaceAiTimeout(generateWorkspaceAiText(workspaceDescriptionRepairPromptContext(graph, [], missingCapabilities)));
        writeWorkspaceAiRepairDebug({ stage: 'capability-description-repair-raw', raw: truncateText(capabilityRaw, 2600) });
        const capabilityParsed = parseWorkspaceNarrativeJson(capabilityRaw);
        capabilities = applyAiCapabilityDescriptions(capabilities, workspaceDescriptionRepairItems(capabilityParsed, 'capability'), generatedAt);
      }
    } else {
      const raw = await withWorkspaceAiTimeout(generateWorkspaceAiText(workspaceDescriptionRepairPromptContext(graph, missingDomains, missingCapabilities)));
      writeWorkspaceAiRepairDebug({ stage: 'description-repair-raw', raw: truncateText(raw, 2400) });
      const parsed = parseWorkspaceNarrativeJson(raw);
      domains = applyAiDomainDescriptions(domains, workspaceDescriptionRepairItems(parsed, 'domain'), generatedAt);
      capabilities = applyAiCapabilityDescriptions(capabilities, workspaceDescriptionRepairItems(parsed, 'capability'), generatedAt);
    }
    domains = invalidateDuplicateWorkspaceDomainDescriptions(domains);
    capabilities = invalidateDuplicateWorkspaceCapabilityDescriptions(capabilities);
  } catch {

  }
  const singleRepairEnabled = process.env.KLAURO_WORKSPACE_AI_SINGLE_REPAIR !== 'false';
  if (!singleRepairEnabled) {
    return { domains, capabilities };
  }
  for (const domain of domains.slice(0, 6).filter(item => !isDefaultWorkspaceDescriptionReady(item.name, item.description, item.description_source, 'domain'))) {
    const description = await repairSingleDefaultWorkspaceDescription(graph, 'domain', domain);
    if (!isGroundedAiWorkspaceItemDescription(domain, description, 'domain')) continue;
    const aiDescription = description!;
    domains = domains.map(item => item.name === domain.name ? {
      ...item,
      description: aiDescription,
      description_source: 'ai',
      generation_pass: 'default-summary',
      degraded_reason: undefined,
      evidence: mergeStrings(item.evidence, [`ai-description:${new Date().toISOString()}`]).slice(0, 8),
    } : item);
  }
  for (const capability of capabilities.slice(0, 8).filter(item => !isDefaultWorkspaceDescriptionReady(item.name, item.description, item.description_source, 'capability'))) {
    const description = await repairSingleDefaultWorkspaceDescription(graph, 'capability', capability);
    if (!isGroundedAiWorkspaceItemDescription(capability, description, 'capability')) continue;
    const aiDescription = description!;
    capabilities = capabilities.map(item => item.name === capability.name ? {
      ...item,
      description: aiDescription,
      description_source: 'ai',
      generation_pass: 'default-summary',
      degraded_reason: undefined,
      evidence: mergeStrings(item.evidence, [`ai-description:${new Date().toISOString()}`]).slice(0, 12),
    } : item);
  }
  return { domains, capabilities };
}

function workspaceDescriptionRepairItems(
  parsed: ParsedWorkspaceNarrative,
  kind: 'domain' | 'capability',
): Array<{ name: string; description?: string }> {
  const primary = kind === 'domain' ? parsed.domain_items || [] : parsed.capability_items || [];
  const fallback = kind === 'domain' ? parsed.capability_items || [] : parsed.domain_items || [];
  const byName = new Map<string, { name: string; description?: string }>();
  for (const item of [...primary, ...fallback]) {
    const key = normalizeAiItemName(item.name);
    if (!key) continue;
    const existing = byName.get(key);
    if (existing && singleWorkspaceDescriptionScore(item.name, existing.description || '') >= singleWorkspaceDescriptionScore(item.name, item.description || '')) continue;
    byName.set(key, item);
  }
  return [...byName.values()];
}

async function repairSingleDefaultWorkspaceDescription(
  graph: WorkspaceAnalysisGraph,
  kind: 'domain' | 'capability',
  item: WorkspaceDomain | WorkspaceCapability,
): Promise<string | undefined> {
  let raw = '';
  try {
    raw = await withWorkspaceAiTimeout(generateWorkspaceAiText(workspaceSingleDescriptionRepairPromptContext(graph, kind, item)));
    const parsed = parseWorkspaceNarrativeJson(raw);
    const candidates = kind === 'domain' ? parsed.domain_items || [] : parsed.capability_items || [];
    const exact = candidates.find(candidate => normalizeAiItemName(candidate.name) === normalizeAiItemName(item.name));
    const singleCandidate = candidates.length === 1 ? candidates[0].description : undefined;
    const firstCandidate = bestSingleWorkspaceDescriptionCandidate(item.name, kind, [
      exact?.description,
      singleCandidate,
      parsed.description,
      cleanSingleDescriptionFromRaw(raw),
    ]);
    if (isUsefulAiWorkspaceDescription(item.name, firstCandidate, kind)) return firstCandidate;
    writeWorkspaceAiRepairDebug({ stage: 'single-repair-rejected', kind, name: item.name, candidate: firstCandidate, raw: truncateText(raw, 1200) });

    raw = await withWorkspaceAiTimeout(generateWorkspaceAiText(workspaceSingleDescriptionRepairPromptContext(graph, kind, item, firstCandidate, `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`)));
    const retryParsed = parseWorkspaceNarrativeJson(raw);
    const retryCandidates = kind === 'domain' ? retryParsed.domain_items || [] : retryParsed.capability_items || [];
    const retryExact = retryCandidates.find(candidate => normalizeAiItemName(candidate.name) === normalizeAiItemName(item.name));
    const retrySingleCandidate = retryCandidates.length === 1 ? retryCandidates[0].description : undefined;
    const retryCandidate = bestSingleWorkspaceDescriptionCandidate(item.name, kind, [
      retryExact?.description,
      retrySingleCandidate,
      retryParsed.description,
      cleanSingleDescriptionFromRaw(raw),
    ]);
    if (!isUsefulAiWorkspaceDescription(item.name, retryCandidate, kind)) {
      writeWorkspaceAiRepairDebug({ stage: 'single-repair-retry-rejected', kind, name: item.name, candidate: retryCandidate, raw: truncateText(raw, 1200) });
    }
    return retryCandidate;
  } catch (error) {
    writeWorkspaceAiRepairDebug({ stage: 'single-repair-error', kind, name: item.name, error: error instanceof Error ? error.message : String(error), raw: truncateText(raw, 1200) });
    return cleanSingleDescriptionFromRaw(raw);
  }
}

function bestSingleWorkspaceDescriptionCandidate(
  name: string,
  kind: 'domain' | 'capability',
  candidates: Array<string | undefined>,
): string | undefined {
  const usable = candidates
    .map(candidate => cleanNarrativeString(candidate))
    .filter((candidate): candidate is string => Boolean(candidate))
    .filter(candidate => isUsefulAiWorkspaceDescription(name, candidate, kind))
    .sort((left, right) => singleWorkspaceDescriptionScore(name, right) - singleWorkspaceDescriptionScore(name, left));

  return usable[0] || candidates
    .map(candidate => cleanNarrativeString(candidate))
    .find(candidate => Boolean(candidate) && !isWorkspaceAiParseArtifactText(candidate));
}

function singleWorkspaceDescriptionScore(name: string, description: string): number {
  const normalized = normalizeAiItemName(description);
  let score = Math.min(description.length, 220) / 20;
  for (const token of meaningfulWorkspaceNameTokens(name)) {
    if (new RegExp(`\\b${escapeRegExp(token)}\\b`).test(normalized)) score += 6;
  }
  const concreteTerms = normalized.match(/\b(api|sdk|mcp|cas|analyzer|analysis|telemetry|trace|runtime|agent|workflow|entity|graph|agent context|contract|database|postgres|redis|auth0|terraform|docker|route|service|package)\b/g) || [];
  score += new Set(concreteTerms).size;
  return score;
}

function cleanSingleDescriptionFromRaw(raw: string): string | undefined {
  const text = String(raw || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const descriptionMatch = text.match(/"description"\s*:\s*"([^"]{60,500})"/i);
  if (descriptionMatch?.[1]) {
    const extracted = descriptionMatch[1].replace(/\\"/g, '"').replace(/\s+/g, ' ').trim();
    if (!isWorkspaceAiParseArtifactText(extracted)) return extracted;
  }
  const line = text
    .split(/\n+/)
    .map(item => item.replace(/^[-*\d.\s]+/, '').trim())
    .find(item => item.length >= 80 && item.length <= 240 && !isWorkspaceAiParseArtifactText(item));
  if (line) return line;

  const cleaned = cleanNarrativeString(text);
  return cleaned && !isWorkspaceAiParseArtifactText(cleaned) ? cleaned : undefined;
}

function workspaceSingleDescriptionRepairPromptContext(
  graph: WorkspaceAnalysisGraph,
  kind: 'domain' | 'capability',
  item: WorkspaceDomain | WorkspaceCapability,
  rejectedDescription?: string,
  retryNonce?: string,
): Record<string, unknown> {
  const appById = new Map(graph.applications.map(app => [app.id, app]));
  const projectById = new Map(graph.codebases.map(project => [project.id, project]));
  const itemProjectIds = item.project_ids || [];
  const deployableIds = 'deployable_ids' in item ? item.deployable_ids : [];
  const requiredNameTerms = meaningfulWorkspaceNameTokens(item.name);
  const normalizedItemName = normalizeAiItemName(item.name);
  const targetSpecificRules = workspaceDescriptionTargetSpecificRules(normalizedItemName);
  const relatedWorkflows = graph.workspace_workflows
    .filter(workflow =>
      workflow.project_ids.some(projectId => itemProjectIds.includes(projectId)) ||
      workflow.deployable_ids.some(deployableId => deployableIds.includes(deployableId)) ||
      workflow.evidence.some(evidence => (item.evidence || []).some(itemEvidence => evidence.includes(itemEvidence) || itemEvidence.includes(evidence)))
    )
    .slice(0, 5);
  const relatedEntities = graph.workspace_entities
    .filter(entity => entity.project_ids.some(projectId => itemProjectIds.includes(projectId)) || normalizeAiItemName(entity.name) === normalizeAiItemName(item.name))
    .slice(0, 6);
  return {
    responseFormat: 'json',
    maxTokens: 450,
    prompt_version: 'workspace-single-default-description-repair-v1',
    task: `Return only valid JSON shaped {"${kind === 'domain' ? 'domains' : 'key_capabilities'}":[{"name":"${item.name}","description":"..."}]}. Generate exactly one AI description for the exact ${kind} name.`,
    exact_name: item.name,
    required_name_terms: requiredNameTerms,
    rejected_description: rejectedDescription,
    ...(retryNonce ? { retry_nonce: retryNonce } : {}),
    rules: [
      'Use the exact name provided.',
      'Write 1 sentence, 90-210 characters.',
      requiredNameTerms.length > 0 ? `The description must include at least one of these exact target words: ${requiredNameTerms.join(', ')}.` : 'Use the target name as the subject when it has no specific target word.',
      ...targetSpecificRules,
      'Name concrete evidence from the supplied facts: app, API, entity, route, worker, package, infrastructure, external dependency, or explicitly supplied workflow.',
      'Explain what this means for an engineer or AI agent changing the workspace.',
      'Do not say inferred, generic, whole-workspace, functionality, various services, or multiple components.',
      'Do not say "in AI", "AI workflows", or use AI as a domain unless the exact target is AI-related.',
      'Do not say though not explicitly, suggests, may serve, end-users, central repository, primary repository, or Contract as a Service.',
      'Do not use raw identifiers like entity_x, snake_case names, file paths, or "via lib"; translate evidence into product and engineering language.',
      'Never mention account, project, workspace, organization, deployable, or application identifiers; use only the supplied human-readable names.',
      'Do not invent facts outside the evidence.',
    ],
    evidence: {
      current_description: item.description,
      semantic_role: (item as any).semantic_role,
      terminal_score: (item as any).terminal_score,
      terminal_evidence: workspacePromptEvidence(graph, (item as any).terminal_evidence || [], 8),
      projects: itemProjectIds.map(projectId => projectById.get(projectId)?.name).filter((value): value is string => Boolean(value)).slice(0, 8),
      deployables: deployableIds.map(id => appById.get(id)?.name).filter((value): value is string => Boolean(value)).slice(0, 8),
      item_evidence: workspacePromptEvidence(graph, item.evidence || [], 12),
      related_workflows: relatedWorkflows.map(workflow => ({
        name: workflow.name,
        evidence_quality: workflow.evidence_quality,
        description: truncateText(workflow.description, 180),
      })),
      related_entities: relatedEntities.map(entity => ({
        name: entity.name,
        lifecycle: entity.lifecycle,
        sensitive_fields: entity.sensitive_fields.slice(0, 4),
      })),
      workspace_summary: graph.workspace_narrative.product_value_summary,
    },
  };
}

function workspaceDescriptionTargetSpecificRules(normalizedItemName: string): string[] {
  const rules: string[] = [];
  if (/^(?:view|access|list|read|show|retrieve)\b/.test(normalizedItemName)) {
    rules.push('This is a read-only capability. Describe viewing or retrieval only; never claim management, creation, update, deletion, or writes.');
  }
  if (/\bsdk\b|\bclient library\b|\bpackage\b/.test(normalizedItemName)) {
    rules.push('For SDK/package targets, describe the installable client/library surface and how agents or apps use it; do not describe telemetry collection unless telemetry is in the exact target name.');
  }
  if (/\btelemetry\b/.test(normalizedItemName)) {
    rules.push('For telemetry targets, describe captured runtime signals, events, traces, or performance data; do not describe the SDK as the main subject.');
  }
  if (/\bcodebase\b|\banalysis\b/.test(normalizedItemName)) {
    rules.push('For codebase analysis targets, describe how analyzed code structure, behavior, entities, and risks become usable context for engineers or agents.');
  }
  if (/\bcontract\b|\bvalidation\b/.test(normalizedItemName)) {
    rules.push('For validation targets, describe checks against CAS contracts or invariants at any level, not generic code correctness.');
  }
  return rules;
}

function writeWorkspaceAiDebug(raw: string): void {
  const debugPath = process.env.KLAURO_WORKSPACE_AI_DEBUG_PATH;
  if (!debugPath) return;
  try {
    fs.writeFileSync(debugPath, raw);
  } catch {

  }
}

function writeWorkspaceAiRepairDebug(payload: Record<string, unknown>): void {
  const debugPath = process.env.KLAURO_WORKSPACE_AI_REPAIR_DEBUG_PATH;
  if (!debugPath) return;
  try {
    fs.mkdirSync(path.dirname(debugPath), { recursive: true });
    fs.appendFileSync(debugPath, `${JSON.stringify({ at: new Date().toISOString(), ...payload })}\n`);
  } catch {

  }
}

function workspaceDescriptionRepairPromptContext(
  graph: WorkspaceAnalysisGraph,
  domains: WorkspaceDomain[],
  capabilities: WorkspaceCapability[],
): Record<string, unknown> {
  const projectById = new Map(graph.codebases.map(project => [project.id, project]));
  const appById = new Map(graph.applications.map(app => [app.id, app]));
  const appsByProjectId = new Map<string, SystemApplication[]>();
  for (const app of graph.applications) {
    appsByProjectId.set(app.codebase_id, [...(appsByProjectId.get(app.codebase_id) || []), app]);
  }
  return {
    responseFormat: 'json',
    maxTokens: Number(process.env.KLAURO_WORKSPACE_AI_REPAIR_MAX_TOKENS || String(Math.min(1100, 180 + domains.length * 170 + capabilities.length * 190))),
    prompt_version: 'workspace-default-description-repair-v2',
    task: 'Return only valid JSON shaped {"domain_items":[{"name":"...","description":"..."}],"capability_items":[{"name":"...","description":"..."}]}. Rewrite each current_description for every exact target name only. Do not invent new facts.',
    quality_gate: 'Each description must be 80-180 characters, include the exact target name or one important target word, preserve the concrete nouns from current_description, include at least one exact grounding_terms value when grounding_terms is non-empty, and explain why the target matters to an engineer or AI agent. Avoid generic phrases like manages functionality, inferred from evidence, or whole-workspace domain.',
    target_domains: domains.map(domain => ({
      name: domain.name,
      current_description: workspacePromptSafeText(graph, domain.description),
      required_name_terms: meaningfulWorkspaceNameTokens(domain.name),
      grounding_terms: workspaceItemGroundingTerms(domain).filter(term => !looksLikeInternalIdentifierToken(term)).slice(0, 10),
      evidence: workspacePromptEvidence(graph, domain.evidence, 8),
      terminal_evidence: workspacePromptEvidence(graph, domain.terminal_evidence || [], 6),
      project_count: domain.project_ids.length,
      projects: domain.project_ids.map(projectId => projectById.get(projectId)?.name).filter((value): value is string => Boolean(value)).slice(0, 6),
      deployables: workspacePromptRelevantDeployableNames(graph, domain.project_ids, domain.name, domain.evidence, domain.terminal_evidence || [], 8),
      related_capabilities: graph.workspace_capabilities
        .filter(capability => domain.evidence.includes(`capability:${capability.name}`) || capability.evidence.some(item => domain.evidence.includes(item)))
        .map(capability => capability.name)
        .slice(0, 6),
    })),
    target_capabilities: capabilities.map(capability => ({
      name: capability.name,
      current_description: workspacePromptSafeText(graph, capability.description),
      required_name_terms: meaningfulWorkspaceNameTokens(capability.name),
      grounding_terms: workspaceItemGroundingTerms(capability).filter(term => !looksLikeInternalIdentifierToken(term)).slice(0, 10),
      criticality: capability.criticality,
      semantic_role: capability.semantic_role,
      terminal_score: capability.terminal_score,
      terminal_evidence: workspacePromptEvidence(graph, capability.terminal_evidence || [], 6),
      evidence: workspacePromptEvidence(graph, capability.evidence, 10),
      deployables: capability.deployable_ids.map(id => appById.get(id)?.name).filter((value): value is string => Boolean(value)).slice(0, 8),
      projects: capability.project_ids.map(id => projectById.get(id)?.name).filter((value): value is string => Boolean(value)).slice(0, 6),
    })),
    rules: [
      'Every returned description must include at least one required_name_terms value for its exact target when required_name_terms is non-empty.',
      'Treat current_description as the seed: rewrite it into clear product/engineering prose while keeping its concrete entities, APIs, deployables, or workflows.',
      'Every returned description must include at least one grounding_terms value for its exact target when grounding_terms is non-empty.',
      'Use product and engineering language, not raw CAS identifiers, file paths, snake_case, or "via lib".',
      'Never mention source filenames, scripts, manifests, or configuration filenames; translate them into the behavior they implement.',
      'Do not use decorative claims such as robust, comprehensive, modern, flexible, scalable, or leveraging; state the concrete behavior directly.',
      'Never mention account, project, workspace, organization, deployable, or application identifiers; use only the supplied human-readable names.',
      'If evidence is thin, explain the concrete entity/API/deployable that is present instead of inventing a broader relationship.',
      'For semantic_role infrastructure, describe only declared provisioning, deployment, runtime, network, storage, or messaging responsibility. Never infer business processing from resource names, and never claim availability, utilization, scale, or performance without explicit evidence.',
      'Do not say "in AI", "AI workflows", or use AI as a domain unless the exact target is AI-related.',
      'Do not say though not explicitly, suggests, may serve, end-users, central repository, primary repository, or Contract as a Service.',
    ],
    workspace_facts: {
      description: graph.workspace_narrative.description,
      product_value_summary: graph.workspace_narrative.product_value_summary,
      relationships: graph.workspace_narrative.relationship_summary.slice(0, 8),
      insights: graph.system_insights.slice(0, 10).map(insight => ({
        type: insight.type,
        title: insight.title,
        description: insight.description,
        evidence: insight.evidence.slice(0, 4),
      })),
    },
  };
}

function workspacePromptEvidence(graph: WorkspaceAnalysisGraph, values: string[], limit: number): string[] {
  const replacements = [
    ...graph.codebases.map(codebase => [codebase.id, codebase.name] as const),
    ...graph.applications.map(application => [application.id, application.name] as const),
  ].sort((left, right) => right[0].length - left[0].length);
  return values
    .map(value => {
      let text = String(value || '');
      for (const [id, name] of replacements) text = text.split(id).join(name);
      return text
        .replace(/\baccount-project[-_:][a-z0-9_-]+\b/gi, '')
        .replace(/\b(?:prj|wsp|acct|proj|org|usr)[-_][a-z0-9_-]{6,}\b/gi, '')
        .replace(/\b[\w.-]+\.(?:tf|tfvars|hcl|ts|tsx|js|jsx|py|rs|go|php|cs|java|rb|sh|bash|zsh|ps1|bat|cmd|yml|yaml|json|toml)\b/gi, '')
        .replace(/\b(?:apps|packages|src|lib|crates|controllers?|routes?)\/[a-z0-9_./-]+/gi, '')
        .replace(/\s{2,}/g, ' ')
        .trim();
    })
    .filter(Boolean)
    .slice(0, limit);
}

function workspacePromptSafeText(graph: WorkspaceAnalysisGraph, value: unknown): string | undefined {
  return workspacePromptEvidence(graph, [String(value || '')], 1)[0];
}

export function workspaceNarrativeRepairPromptContext(graph: WorkspaceAnalysisGraph, rejectionReason?: string, attempt?: number): Record<string, unknown> {
  const productName = inferWorkspaceProductName(graph.codebases, graph.name);
  const links = graph.application_links.slice(0, 8).map(link => ({
    mode: link.mode,
    kind: link.kind,
    source: graph.applications.find(app => app.id === link.source_application_id)?.name,
    target: graph.applications.find(app => app.id === link.target_application_id)?.name,
    evidence: link.evidence.slice(0, 3),
  }));
  const deployables = graph.detail_views.overview.deployables.slice(0, 8).map(app => `${app.name} (${app.kind})`);

  const runtime = graph.runtime_components
    .filter(component => !/^image:|dockerfile/i.test(String(component.name || '')))
    .slice(0, 8)
    .map(component => workspacePromptSafeText(graph, `${component.name}${component.ports?.length ? `:${component.ports.join(',')}` : ''}`))
    .filter((value): value is string => Boolean(value));
  const hasSourceBackedLinks = graph.application_links.some(applicationLinkHasSourceBackedEvidence);
  const memberProjects = graph.codebases.slice(0, 8).map(codebase => ({
    name: codebase.name,
    ...(codebase.primary_domain ? { primary_domain: codebase.primary_domain } : {}),
    ...(codebase.description ? { member_description: workspacePromptSafeText(graph, codebase.description) } : {}),
    system_type: codebase.system_type,
    applications: graph.applications.filter(app => app.codebase_id === codebase.id).map(app => app.name).slice(0, 6),
    own_domains: graph.workspace_domains.filter(domain => domain.project_ids.length === 1 && domain.project_ids[0] === codebase.id).map(domain => domain.name).slice(0, 6),
    own_capabilities: graph.workspace_capabilities
      .filter(capability => capability.project_ids.length === 1 && capability.project_ids[0] === codebase.id)
      .map(capability => ({
        name: capability.name,
        description: workspacePromptSafeText(graph, capability.description),
        semantic_role: capability.semantic_role,
      }))
      .slice(0, 8),
    own_entities: graph.workspace_entities.filter(entity => entity.project_ids.length === 1 && entity.project_ids[0] === codebase.id).map(entity => entity.name).slice(0, 10),
  }));
  return {
    responseFormat: 'json',
    maxTokens: Number(process.env.KLAURO_WORKSPACE_AI_REPAIR_MAX_TOKENS || '520'),
    prompt_version: 'workspace-default-narrative-repair-v2',
    product_name: productName,

    retry_attempt: attempt ?? 0,

    retry_nonce: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    ...(rejectionReason ? { rejection_feedback: `A previous draft was rejected by the workspace narrative quality gate: ${rejectionReason}. Fix exactly this problem in the rewrite, grounding it in the supplied workspace_domains, primary_capabilities, and required_terms evidence.` } : {}),
    task: hasSourceBackedLinks
      ? 'Return only valid JSON with keys description and product_value_summary. Rewrite the workspace description from the supplied workspace-level CAS facts and source-backed links only.'
      : 'Return only valid JSON with keys description and product_value_summary. Describe each member project independently because no source-backed cross-project link exists.',
    rules: [
      'Write one concrete paragraph.',
      'Never include raw internal identifiers (prj_/wsp_/acct_ tokens), source file names, raw route paths with :params, or HTTP-method lists.',
      'Preserve capability action semantics exactly: View, Access, List, Read, Show, and Retrieve are read-only and must never become management, mutation, creation, update, deletion, or write claims.',
      'Describe the workspace as a whole, never a single flow or endpoint.',
      'Always include a non-empty product_value_summary.',
      'Do not say classified as, repo analysis input, language inventory, or describe the workspace as an inventory.',
      'Do not mention repo counts, language inventory, or "the system includes".',
      'Do not describe language diversity, framework coverage, polyglot support, language-specific endpoints, or a technology stack as product value. A member name containing words such as "polyglot" is only a proper name.',
      'Infrastructure technologies may be named only as concrete implementation context for an evidence-backed operational responsibility; lead with the responsibility and never with the tool inventory.',
      'Do not use decorative claims such as robust, comprehensive, modern, flexible, scalable, or leveraging; state the concrete behavior directly.',
      'Name concrete deployables, packages, data/runtime concepts, and infrastructure from evidence, attributing each fact to its owning member.',
      ...(hasSourceBackedLinks
        ? ['Explain cross-project work only through the supplied source-backed links, preserving direction.']
        : [
            'State plainly that the member projects are independent in the analyzed workspace.',
            'Return no relationship_summary entries because no source-backed cross-project link exists.',
            'Describe each member in its own sentence or clause; never combine one member\'s capabilities with another member\'s infrastructure into a workflow.',
            'Do not say work, data, orders, requests, or events flow through, use, connect to, or are deployed by another member.',
          ]),
      'Do not invent customers, pricing, revenue model, integrations, or links.',
      'member_projects are DISTINCT projects: attribute each capability, domain, and behavior to the member that owns it; never present one member as the workspace and never assign one member\'s capabilities to another member.',
      'Each member_projects.own_entities list is exclusive ownership evidence. Mention an entity only in the sentence or clause for its owning member; never assign one member\'s entity or data to another member.',
      'member_projects.member_description and own_capabilities are completed member-CAS comprehension and are authoritative for that member. Compose them; do not replace them with an interpretation of project names, runtimes, languages, or frameworks.',
      'workspace_insights and composition facts are internal analysis diagnostics: never quote their phrasing (e.g. "source-backed", "isolated deployable(s)", "should not be forced into the system graph", "Dockerfile") verbatim — translate them into plain engineering language or omit them.',
    ],
    required_terms: hasSourceBackedLinks ? [
      ...deployables.slice(0, 5),
      ...links.slice(0, 4).flatMap(link => [link.source, link.target]).filter(Boolean),
      ...runtime.slice(0, 4),
    ].slice(0, 14) : [],
    product_value_summary_hint: workspacePromptSafeText(graph, graph.workspace_narrative.product_value_summary),
    workspace_domains: (hasSourceBackedLinks ? primaryWorkspaceDomains(graph) : []).map(domain => ({
      name: domain.name,
      description: workspacePromptSafeText(graph, truncateText(domain.description, 140)),
      evidence: workspacePromptEvidence(graph, domain.evidence, 3),
    })),
    relationship_policy: hasSourceBackedLinks
      ? 'Only the supplied source-backed links may be described as cross-project interaction.'
      : 'No source-backed cross-project links exist. Members must be described as independent.',
    member_projects: memberProjects,
    source_backed_links: links,
    member_workflows: graph.workspace_workflows.slice(0, 6).map(workflow => ({
      name: workflow.name,
      description: workspacePromptSafeText(graph, workflow.description),
      projects: workflow.project_ids.map(projectId => graph.codebases.find(codebase => codebase.id === projectId)?.name).filter(Boolean),
      evidence: workspacePromptEvidence(graph, workflow.evidence, 3),
    })),
    primary_capabilities: (hasSourceBackedLinks ? graph.workspace_capabilities.slice(0, 6) : []).map(capability => ({
      name: capability.name,
      description: isDefaultWorkspaceDescriptionReady(capability.name, capability.description, capability.description_source, 'capability')
        ? workspacePromptSafeText(graph, capability.description)
        : undefined,
      evidence: workspacePromptEvidence(graph, capability.evidence, 4),
    })),
    workspace_insights: (hasSourceBackedLinks ? graph.system_insights.slice(0, 6) : []).map(insight => ({
      title: workspacePromptSafeText(graph, insight.title),
      description: workspacePromptSafeText(graph, insight.description),
      evidence: workspacePromptEvidence(graph, insight.evidence, 3),
    })).filter(insight => insight.title || insight.description),
  };
}

function applyAiDomainDescriptions(domains: WorkspaceDomain[], aiItems: Array<{ name: string; description?: string }>, generatedAt: string): WorkspaceDomain[] {
  const byName = fuzzyAiItemMap(aiItems);
  return domains.map(domain => {
    const item = findAiItem(byName, domain.name);
    if (!isGroundedAiWorkspaceItemDescription(domain, item?.description, 'domain')) return domain;
    return {
      ...domain,
      description: item!.description!,
      description_source: 'ai',
      generation_pass: 'default-summary',
      degraded_reason: undefined,
      evidence: mergeStrings(domain.evidence, [`ai-description:${generatedAt}`]).slice(0, 8),
    };
  });
}

function applyAiCapabilityDescriptions(capabilities: WorkspaceCapability[], aiItems: Array<{ name: string; description?: string }>, generatedAt: string): WorkspaceCapability[] {
  const byName = fuzzyAiItemMap(aiItems);
  return capabilities.map(capability => {

    if (capability.description_source === 'ai') return capability;
    const item = findAiItem(byName, capability.name);
    if (!isGroundedAiWorkspaceItemDescription(capability, item?.description, 'capability')) {
      if (item?.description) {
        writeWorkspaceAiRepairDebug({ stage: 'capability-description-rejected', name: capability.name, candidate: item.description });
      }
      return capability;
    }
    return {
      ...capability,
      description: item!.description!,
      description_source: 'ai',
      generation_pass: 'default-summary',
      degraded_reason: undefined,
      evidence: mergeStrings(capability.evidence, [`ai-description:${generatedAt}`]).slice(0, 12),
    };
  });
}

function invalidateDuplicateWorkspaceCapabilityDescriptions(capabilities: WorkspaceCapability[]): WorkspaceCapability[] {
  const byDescription = new Map<string, WorkspaceCapability[]>();
  for (const capability of capabilities) {
    if (capability.description_source !== 'ai') continue;
    const key = normalizeAiItemName(capability.description || '');
    if (key.length < 80) continue;
    byDescription.set(key, [...(byDescription.get(key) || []), capability]);
  }

  const ownerByDescription = new Map<string, string>();
  for (const [description, duplicates] of byDescription.entries()) {
    if (duplicates.length < 2) continue;
    const owner = duplicates
      .map(capability => ({ capability, score: capabilityDescriptionOwnershipScore(capability.name, description) }))
      .sort((left, right) => right.score - left.score || workspaceCapabilityRank(right.capability) - workspaceCapabilityRank(left.capability))[0]?.capability;
    if (owner) ownerByDescription.set(description, owner.name);
  }

  return capabilities.map(capability => {
    if (capability.description_source !== 'ai') return capability;
    const key = normalizeAiItemName(capability.description || '');
    const owner = ownerByDescription.get(key);
    if (!owner || normalizeAiItemName(owner) === normalizeAiItemName(capability.name)) return capability;
    return {
      ...capability,
      description_source: 'ai-required-degraded',
      degraded_reason: `AI description duplicated ${owner}; regenerate from this capability's own evidence before customer-facing use.`,
    };
  });
}

function invalidateDuplicateWorkspaceDomainDescriptions(domains: WorkspaceDomain[]): WorkspaceDomain[] {
  const byDescription = new Map<string, WorkspaceDomain[]>();
  for (const domain of domains) {
    if (domain.description_source !== 'ai') continue;
    const key = normalizeAiItemName(domain.description || '');
    if (key.length < 60) continue;
    byDescription.set(key, [...(byDescription.get(key) || []), domain]);
  }

  const ownerByDescription = new Map<string, string>();
  for (const [description, duplicates] of byDescription.entries()) {
    if (duplicates.length < 2) continue;
    const owner = duplicates
      .map(domain => ({
        domain,
        score: workspaceDomainSortScore(domain.name, {
          score: domain.confidence * 10,
          terminal_score: domain.terminal_score || 0,
          evidence: domain.evidence,
          terminal_evidence: domain.terminal_evidence || [],
        }, new Set()),
      }))
      .sort((left, right) => right.score - left.score || left.domain.name.localeCompare(right.domain.name))[0]?.domain;
    if (owner) ownerByDescription.set(description, owner.name);
  }

  return domains.map(domain => {
    if (domain.description_source !== 'ai') return domain;
    const key = normalizeAiItemName(domain.description || '');
    const owner = ownerByDescription.get(key);
    if (!owner || normalizeAiItemName(owner) === normalizeAiItemName(domain.name)) return domain;
    return {
      ...domain,
      description_source: 'ai-required-degraded',
      degraded_reason: `AI description duplicated ${owner}; regenerate from this domain's own evidence before customer-facing use.`,
    };
  });
}

function syncMatchingWorkspaceDomainCapabilityDescriptions(
  domains: WorkspaceDomain[],
  capabilities: WorkspaceCapability[],
  generatedAt: string,
): { domains: WorkspaceDomain[]; capabilities: WorkspaceCapability[] } {
  const capabilityByName = new Map(capabilities.map(capability => [normalizeAiItemName(capability.name), capability]));
  const domainByName = new Map(domains.map(domain => [normalizeAiItemName(domain.name), domain]));
  const syncedDomains = domains.map(domain => {
    if (isDefaultWorkspaceDescriptionReady(domain.name, domain.description, domain.description_source, 'domain')) return domain;
    const capability = capabilityByName.get(normalizeAiItemName(domain.name));
    if (!capability || capability.description_source !== 'ai') return domain;
    if (!isDefaultWorkspaceDescriptionReady(capability.name, capability.description, capability.description_source, 'capability')) return domain;
    if (!descriptionMatchesItemName(domain.name, normalizeAiItemName(capability.description || ''))) return domain;
    return {
      ...domain,
      description: capability.description,
      description_source: 'ai' as const,
      generation_pass: 'default-summary' as const,
      degraded_reason: undefined,
      evidence: mergeStrings(domain.evidence, [`ai-description-synced-from-capability:${generatedAt}`]).slice(0, 8),
    };
  });
  const syncedCapabilities = capabilities.map(capability => {
    if (isDefaultWorkspaceDescriptionReady(capability.name, capability.description, capability.description_source, 'capability')) return capability;
    const domain = domainByName.get(normalizeAiItemName(capability.name));
    if (!domain || domain.description_source !== 'ai') return capability;
    if (!isDefaultWorkspaceDescriptionReady(domain.name, domain.description, domain.description_source, 'domain')) return capability;
    if (!descriptionMatchesItemName(capability.name, normalizeAiItemName(domain.description || ''))) return capability;
    return {
      ...capability,
      description: domain.description,
      description_source: 'ai' as const,
      generation_pass: 'default-summary' as const,
      degraded_reason: undefined,
      evidence: mergeStrings(capability.evidence, [`ai-description-synced-from-domain:${generatedAt}`]).slice(0, 12),
    };
  });
  return { domains: syncedDomains, capabilities: syncedCapabilities };
}

function finalizeRequiredWorkspaceAiSemantics(graph: WorkspaceAnalysisGraph, generatedAt: string): void {
  const capabilityByName = new Map(graph.workspace_capabilities.map(capability => [normalizeAiItemName(capability.name), capability]));
  const domainByName = new Map(graph.workspace_domains.map(domain => [normalizeAiItemName(domain.name), domain]));

  graph.workspace_domains = graph.workspace_domains.map((domain, index) => {
    if (index >= 6) return domain;
    const counterpart = capabilityByName.get(normalizeAiItemName(domain.name))
      || findAiCapabilityCounterpartForDomain(domain, graph.workspace_capabilities);
    const currentDescription = String(domain.description || '').trim();
    if (counterpart?.description_source === 'ai') {
      const description = String(counterpart.description || '').trim();
      const shouldPreferCounterpart =
        !isDefaultWorkspaceDescriptionReady(domain.name, domain.description, domain.description_source, 'domain') ||
        currentDescription.length < 80 ||
        description.length > currentDescription.length + 20;
      if (shouldPreferCounterpart && description.length >= 68 && !isWorkspaceAiParseArtifactText(description) && descriptionMatchesItemName(domain.name, normalizeAiItemName(description))) {
        return {
          ...domain,
          description,
          description_source: 'ai' as const,
          generation_pass: 'default-summary' as const,
          degraded_reason: undefined,
          evidence: mergeStrings(domain.evidence, [`ai-description-finalized-from-capability:${generatedAt}`]).slice(0, 8),
        };
      }
    }
    if (isDefaultWorkspaceDescriptionReady(domain.name, domain.description, domain.description_source, 'domain') && currentDescription.length >= 80) return domain;
    return domain;
  });

  graph.workspace_capabilities = graph.workspace_capabilities.map((capability, index) => {
    if (index >= 8 || isDefaultWorkspaceDescriptionReady(capability.name, capability.description, capability.description_source, 'capability')) return capability;
    const counterpart = domainByName.get(normalizeAiItemName(capability.name));
    let description = '';
    if (counterpart?.description_source === 'ai') {
      const domainDescription = String(counterpart.description || '').trim();
      if (domainDescription.length >= 68 && !isWorkspaceAiParseArtifactText(domainDescription) && descriptionMatchesItemName(capability.name, normalizeAiItemName(domainDescription))) {
        description = domainDescription;
      }
    }
    if (!description) return capability;
    return {
      ...capability,
      description,
      description_source: 'ai' as const,
      generation_pass: 'default-summary' as const,
      degraded_reason: undefined,
      evidence: mergeStrings(capability.evidence, [`ai-description-finalized-from-domain:${generatedAt}`]).slice(0, 12),
    };
  });

}

function isAgentVisibleAiSemanticDescriptionReady(item: { description_source?: WorkspaceDescriptionSource; description?: string }): boolean {
  const text = String(item.description || '').trim();
  return item.description_source === 'ai' &&
    text.length >= 80 &&
    !/^(unnamed|null|undefined)$/i.test(text) &&
    !/\[object Object\]/.test(text);
}

function isRequiredWorkspaceSemanticDescriptionReady(
  name: string,
  description: string | undefined,
  source: WorkspaceDescriptionSource | undefined,
  kind: 'domain' | 'capability',
): boolean {
  if (isDefaultWorkspaceDescriptionReady(name, description, source, kind)) return true;
  const normalizedDescription = normalizeAiItemName(description || '');
  return isAgentVisibleAiSemanticDescriptionReady({ description_source: source, description }) &&
    descriptionMatchesItemName(name, normalizedDescription);
}

function findAiCapabilityCounterpartForDomain(domain: WorkspaceDomain, capabilities: WorkspaceCapability[]): WorkspaceCapability | undefined {
  const domainTokens = meaningfulWorkspaceNameTokens(domain.name);
  if (domainTokens.length === 0) return undefined;
  return capabilities.find(capability => {
    if (capability.description_source !== 'ai') return false;
    const capabilityTokens = new Set(meaningfulWorkspaceNameTokens(capability.name));
    const hasNameOverlap = domainTokens.some(token => capabilityTokens.has(token));
    if (!hasNameOverlap) return false;
    if (!isDefaultWorkspaceDescriptionReady(capability.name, capability.description, capability.description_source, 'capability')) return false;
    return descriptionMatchesItemName(domain.name, normalizeAiItemName(capability.description || ''));
  });
}

function capabilityDescriptionOwnershipScore(name: string, normalizedDescription: string): number {
  const normalizedName = normalizeAiItemName(name);
  let score = 0;
  if (normalizedName && new RegExp(`^${escapeRegExp(normalizedName).replace(/\s+/g, '\\s+')}`).test(normalizedDescription)) score += 10;
  for (const token of meaningfulWorkspaceNameTokens(name)) {
    if (new RegExp(`\\b${escapeRegExp(token)}\\b`).test(normalizedDescription)) score += 3;
  }
  return score;
}

function applyAiWorkflowDescriptions(workflows: WorkspaceWorkflow[], aiItems: Array<{ name: string; description?: string }>, generatedAt: string): WorkspaceWorkflow[] {
  const byName = fuzzyAiItemMap(aiItems);
  return workflows.map(workflow => {
    const item = findAiItem(byName, workflow.name);
    if (!isUsefulAiWorkspaceDescription(workflow.name, item?.description, 'workflow')) return workflow;
    return {
      ...workflow,
      description: item!.description!,
      evidence: mergeStrings(workflow.evidence, [`ai-description:${generatedAt}`]).slice(0, 12),
    };
  });
}

function applyAiEntityDescriptions(entities: WorkspaceEntity[], aiItems: Array<{ name: string; description?: string }>, generatedAt: string): WorkspaceEntity[] {
  const byName = fuzzyAiItemMap(aiItems);
  return entities.map(entity => {
    const item = findAiItem(byName, entity.name);
    if (!isUsefulAiWorkspaceDescription(entity.name, item?.description, 'entity')) return entity;
    return {
      ...entity,
      description: item!.description!,
      description_source: 'ai',
      evidence: mergeStrings(entity.evidence, [`ai-description:${generatedAt}`]).slice(0, 12),
    };
  });
}

function isDefaultWorkspaceDescriptionReady(
  name: string,
  description: string | undefined,
  source: WorkspaceDescriptionSource | undefined,
  kind: 'domain' | 'capability',
): boolean {
  return source === 'ai' && isUsefulAiWorkspaceDescription(name, description, kind);
}

export function isWorkspaceAiParseArtifactText(value: unknown): boolean {
  const raw = String(value ?? '').trim();
  if (!raw) return false;

  const text = raw.replace(/\\+"/g, '"');
  if (/^[{[]/.test(text)) return true;
  if (text.includes('```')) return true;

  if (/^"[a-z_][\w-]*"\s*:/i.test(text)) return true;

  if (/\bReturn only valid JSON\b/i.test(text)) return true;
  if (/\bGenerate exactly one AI description\b/i.test(text)) return true;
  if (/"(?:prompt_version|responseFormat|response_format|required_name_terms|exact_name|output_schema|rejected_description|retry_nonce)"\s*:/i.test(text)) return true;
  if (/"(?:key_capabilities|capabilities|capability_items|domain_items|domains|workflow_items|entity_items)"\s*:/i.test(text)) return true;
  if (/"(?:task|name|title|description|category|source_names|rules|evidence)"\s*:/i.test(text)) return true;
  if (/[{[]\s*"/.test(text)) return true;
  return false;
}

export function stripWorkspaceItemDescriptionArtifacts(graph: WorkspaceAnalysisGraph): number {
  let cleared = 0;
  const scrubItem = <T extends { description?: string; description_source?: WorkspaceDescriptionSource; degraded_reason?: string; name?: string }>(
    item: T,
    kind: 'capability' | 'domain' | 'workflow' | 'entity',
  ): T => {
    if (!isWorkspaceAiParseArtifactText(item.description)) return item;
    cleared += 1;
    writeWorkspaceAiRepairDebug({ stage: 'persist-seam-artifact-stripped', kind, name: item.name, candidate: truncateText(String(item.description || ''), 200) });
    return {
      ...item,
      description: '',
      description_source: 'ai-required-degraded',
      degraded_reason: `AI description was an unparsed model/prompt artifact and was rejected at the persist seam; regenerate the ${kind} description from its own evidence before customer-facing use.`,
    };
  };
  graph.workspace_capabilities = (graph.workspace_capabilities || []).map(item => scrubItem(item, 'capability'));
  graph.workspace_domains = (graph.workspace_domains || []).map(item => scrubItem(item, 'domain'));
  graph.workspace_workflows = (graph.workspace_workflows || []).map(item => scrubItem(item, 'workflow'));
  graph.workspace_entities = (graph.workspace_entities || []).map(item => scrubItem(item, 'entity'));
  const narrative = graph.workspace_narrative;
  if (narrative) {
    if (isWorkspaceAiParseArtifactText(narrative.description)) {
      cleared += 1;
      narrative.description = '';
      narrative.source = 'ai-required-degraded';
      narrative.degraded_reason = 'Workspace narrative was an unparsed model/prompt artifact and was rejected at the persist seam.';
    }
    if (isWorkspaceAiParseArtifactText(narrative.product_value_summary)) {
      cleared += 1;
      narrative.product_value_summary = '';
    }
  }

  if (graph.detail_views?.overview) {
    graph.detail_views.overview.capabilities = graph.workspace_capabilities.slice(0, 12);
    graph.detail_views.overview.description = graph.workspace_narrative?.description;
  }
  return cleared;
}

function isUsefulAiWorkspaceDescription(name: string, description: string | undefined, kind: 'domain' | 'capability' | 'workflow' | 'entity'): boolean {
  const text = String(description || '').trim();
  if (isWorkspaceAiParseArtifactText(text)) return false;
  if (workspaceProseLeaksInternalIdentifier(text)) return false;
  if (text.length < (kind === 'entity' ? 55 : kind === 'workflow' ? 52 : 68)) return false;
  const normalized = normalizeAiItemName(text);
  const normalizedName = normalizeAiItemName(name);
  if (!normalized || normalized === normalizedName) return false;
  const withoutName = normalized.replace(new RegExp(`\\b${escapeRegExp(normalizedName).replace(/\\s+/g, '\\\\s+')}\\b`, 'g'), '').trim();
  if (withoutName.length < 32) return false;
  if ((kind === 'capability' || kind === 'domain') && !descriptionMatchesItemName(name, normalized)) return false;
  const weakPatterns = [
    /^provides? .+ (services?|capabilities|functionality|features?)$/,
    /^manages? .+ (services?|capabilities|functionality|features?)$/,
    /^handles? .+ (services?|capabilities|functionality|features?)$/,
    /^supports? .+ (services?|capabilities|functionality|features?)$/,
    /various applications/,
    /multiple components/,
    /different services/,
    /across the system$/i,
    /\bvia lib\b/,
    /\bentity_[a-z0-9_]+\b/,
    /\bentity\s+[a-z0-9]+\b/,
    /\b[a-z]+_[a-z0-9_]+(?:_[a-z0-9_]+)?\b/,
    /\bvia\s+(?:apps|packages|src|lib)\//,
    /\bapps\/[a-z0-9/_-]+\b/,
    /\bpackages\/[a-z0-9/_-]+\b/,
    /\b[a-z0-9._-]+\.(?:tf|tfvars|hcl|ts|tsx|js|jsx|py|rs|go|php|cs|java|rb|sh|bash|zsh|ps1|bat|cmd|yml|yaml|json|toml)\b/,
    /\bthough not (?:explicitly|explicit)\b/,
    /\bnot explicitly mentioned\b/,
    /\bsuggests that\b/,
    /\bmay serve\b/,
    /\bunravl\b/,
    /\bunravelling\b/,
    /\bproof mechanisms?\b/,
    /\bpossibly\b/,
    /\bend users?\b/,
    /\bprimary (?:code )?repository\b/,
    /\bcentral repository\b/,
    /\bcontract as a service\b/,
    /\bcorrect behavior and compatibility\b/,
    /\bvarious projects\b/,
    /\bexternal libraries and dependencies\b/,
    /\bin ai(?:,|\s+domain|\s+workflows?\b)/,
    /\bai workflows?\b/,
    /\b(?:connects?|links?)\b[^.]{0,160}\bevidence\b[^.]{0,160}\bagents?\b/,
    /\bso agents can understand\b/,
    /\bchange impact at the workspace level\b/,
  ];
  if (weakPatterns.some(pattern => pattern.test(normalized))) return false;
  const hasConcreteVerb = /\b(routes?|calls?|brokers?|relays?|communicates?|pairs?|interacts?|implements?|integrates?|enforces?|ensures?|tracks?|audits?|analyzes?|examines?|identifies?|assesses?|ingests?|enables?|facilitates?|allows?|sets? up|enrolls?|authenticates?|authorizes?|provisions?|stores?|syncs?|ships?|installs?|connects?|links?|exposes?|validates?|collects?|records?|forwards?|protects?|coordinates?|manages?|maintains?|defines?|monitors?|deploys?|handles?|supports?|provides?|surfaces?|turns?|transforms?|generates?|retrieves?|returns?|maps?|compares?|compresses?|indexes?|guides?)\b/.test(normalized);
  if (kind === 'domain') {
    return workspaceSemanticTokens(normalized).size >= 3;
  }
  return hasConcreteVerb;
}

function looksLikeInternalIdentifierToken(value: string): boolean {
  const token = String(value || '').trim();
  return /^(?:account-project[-_:])|^(?:prj|wsp|acct|proj|org|usr)[-_]/i.test(token) ||
    (token.length >= 10 && /\d/.test(token) && /^[a-z0-9_-]+$/i.test(token));
}

function workspaceProseLeaksInternalIdentifier(value: string): boolean {
  const text = String(value || '');
  if (/\baccount-project[-_:][a-z0-9_-]+\b/i.test(text)) return true;
  if (/\b(?:prj|wsp|acct|proj|org|usr)[-_][a-z0-9_-]{6,}\b/i.test(text)) return true;
  return /\b(?:account|project|workspace|organization|user)\s+(?=[a-z0-9_-]{10,}\b)(?=[a-z0-9_-]*\d)[a-z0-9_-]+\b/i.test(text);
}

export function isGroundedAiWorkspaceItemDescription(
  item: WorkspaceDomain | WorkspaceCapability,
  description: string | undefined,
  kind: 'domain' | 'capability',
): boolean {
  if (!isUsefulAiWorkspaceDescription(item.name, description, kind)) return false;
  const rawDescription = String(description || '');
  if (/\b[\w.-]+\.(?:tf|tfvars|hcl|ts|tsx|js|jsx|py|rs|go|php|cs|java|rb|sh|bash|zsh|ps1|bat|cmd|yml|yaml|json|toml)\b/i.test(rawDescription)) return false;
  if (/\/(?:[A-Za-z0-9_.~-]+\/)*(?::|\{)[A-Za-z_][A-Za-z0-9_]*(?:\}|\b)/.test(rawDescription)) return false;
  const normalized = normalizeAiItemName(description || '');
  if (item.semantic_role === 'infrastructure') {
    const evidence = normalizeAiItemName([...(item.evidence || []), ...(item.terminal_evidence || [])].join(' '));
    for (const claim of normalized.match(/\b(?:high availability|resource utilization|fault tolerance|auto scaling|scalability|resilience|resilient)\b/g) || []) {
      if (!evidence.includes(claim)) return false;
    }
  }
  if (/^(?:view|access|list|read|show|retrieve)\b/.test(normalizeAiItemName(item.name)) &&
      /\b(?:manag(?:e|es|ing|ement)|creat(?:e|es|ing)|updat(?:e|es|ing)|delet(?:e|es|ing)|modif(?:y|ies|ying)|mutat(?:e|es|ing)|writ(?:e|es|ing)|submits?|configur(?:e|es|ing))\b/.test(normalized)) return false;
  const groundingTerms = workspaceItemGroundingTerms(item);
  if (ungroundedMarketingMatches(rawDescription, [], groundingTerms, (item.evidence || []).join(' ')).length > 0) return false;
  const nameTerms = new Set(meaningfulWorkspaceNameTokens(item.name));
  const allNameTermsMatched = nameTerms.size > 0 && [...nameTerms].every(term => normalizedDescriptionContainsTerm(normalized, term));
  const nonNameGroundingTerms = groundingTerms.filter(term => !nameTerms.has(term));
  const matchedGroundingTerms = groundingTerms.filter(term =>
    normalizedDescriptionContainsTerm(normalized, term)
  );
  const matchedNonNameTerms = nonNameGroundingTerms.filter(term =>
    normalizedDescriptionContainsTerm(normalized, term)
  );
  const hasTerminalEvidence = Boolean((item.terminal_evidence || []).length || (item.terminal_score || 0) >= 8);
  const hasConcreteSurface = 'deployable_ids' in item
    ? (item.deployable_ids || []).length > 0 || (item.project_ids || []).length > 0
    : (item.project_ids || []).length > 1;

  if (matchedNonNameTerms.length > 0) return true;
  if (allNameTermsMatched && hasTerminalEvidence) return true;
  if (allNameTermsMatched && hasConcreteSurface) return true;
  if (matchedGroundingTerms.length >= 2 && (hasTerminalEvidence || hasConcreteSurface)) return true;
  return false;
}

function normalizedDescriptionContainsTerm(normalizedDescription: string, term: string): boolean {
  const normalizedTerm = normalizeAiItemName(term);
  if (!normalizedTerm || normalizedTerm.length < 3) return false;
  if (new RegExp(`\\b${escapeRegExp(normalizedTerm)}s?\\b`).test(normalizedDescription)) return true;
  const singular = normalizedTerm.endsWith('s') && !normalizedTerm.endsWith('ss') ? normalizedTerm.slice(0, -1) : normalizedTerm;
  return singular !== normalizedTerm && new RegExp(`\\b${escapeRegExp(singular)}s?\\b`).test(normalizedDescription);
}

function workspaceItemGroundingTerms(item: WorkspaceDomain | WorkspaceCapability): string[] {
  const stop = new Set([
    'ai',
    'app',
    'apps',
    'cas',
    'codebase',
    'codebases',
    'concept',
    'core',
    'domain',
    'entity',
    'evidence',
    'project',
    'projects',
    'repo',
    'repos',
    'system',
    'workspace',
  ]);
  const values = [
    ...(item.evidence || []),
    ...(item.terminal_evidence || []),
  ];
  const terms = new Set<string>();
  for (const value of values) {
    const humanized = String(value || '')
      .replace(/^[a-z_ -]+:/i, ' ')
      .replace(/[-_:/.]+/g, ' ')
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2');
    for (const token of normalizeAiItemName(humanized).split(/\s+/)) {
      const singular = token.endsWith('s') && !token.endsWith('ss') ? token.slice(0, -1) : token;
      if (singular.length < 4 || stop.has(singular)) continue;
      terms.add(singular);
    }
  }
  return [...terms].slice(0, 24);
}

function descriptionMatchesItemName(name: string, normalizedDescription: string): boolean {
  const tokens = meaningfulWorkspaceNameTokens(name);
  if (tokens.length === 0) return true;
  return tokens.some(token => normalizedDescriptionContainsTerm(normalizedDescription, token));
}

function meaningfulWorkspaceNameTokens(name: string): string[] {
  const stop = new Set([
    'management',
    'manager',
    'services',
    'service',
    'control',
    'context',
    'infrastructure',
    'backend',
    'frontend',
    'provisioning',
    'domain',
    'capability',
    'system',
    'enterprise',
  ]);
  return normalizeAiItemName(name)
    .split(/\s+/)
    .map(token => token.endsWith('s') && !token.endsWith('ss') ? token.slice(0, -1) : token)
    .filter(token => token.length >= 3 && !stop.has(token));
}

const WORKSPACE_SEMANTIC_STOP_WORDS = new Set([
  'about', 'across', 'after', 'again', 'against', 'along', 'also', 'another', 'before', 'being', 'between',
  'both', 'build', 'built', 'capability', 'codebase', 'comprehensive', 'concrete', 'connect', 'coordinate', 'could',
  'description', 'each', 'engineering', 'every', 'existing', 'feature', 'from', 'functionality', 'helps', 'into',
  'itself', 'manage', 'member', 'members', 'multiple', 'offer', 'only', 'operator', 'other', 'product', 'project',
  'projects', 'provide', 'related', 'review', 'robust', 'route', 'run', 'serve', 'software', 'system', 'their',
  'these', 'through', 'together', 'using', 'with', 'workspace', 'would', 'application', 'backend',
]);

function workspaceSemanticTokens(value: string): Set<string> {
  const tokens = normalizeAiItemName(value)
    .split(/\s+/)
    .map(token => token.endsWith('s') && !token.endsWith('ss') ? token.slice(0, -1) : token)
    .filter(token => token.length >= 4 && !WORKSPACE_SEMANTIC_STOP_WORDS.has(token));
  return new Set(tokens);
}

function workspaceEvidenceTokens(graph: WorkspaceAnalysisGraph): Set<string> {
  const values = [
    ...(graph.codebases || []).flatMap(codebase => [codebase.name, codebase.primary_domain || '']),
    ...(graph.applications || []).flatMap(application => [application.name, application.description || '']),
    ...(graph.distribution_units || []).flatMap(unit => [unit.name, ...unit.component_names]),
    ...(graph.workspace_domains || []).flatMap(domain => [domain.name, domain.description, ...(domain.evidence || [])]),
    ...(graph.workspace_capabilities || []).flatMap(capability => [capability.name, capability.description, ...(capability.evidence || [])]),
    ...(graph.workspace_entities || []).flatMap(entity => [entity.name, entity.description || '', ...(entity.evidence || [])]),
    ...(graph.workspace_workflows || []).flatMap(workflow => [workflow.name, workflow.description, ...(workflow.evidence || [])]),
    ...(graph.interfaces || []).map(item => item.name),
    ...(graph.children || []).flatMap(child => [
      ...((child.capabilities || []).flatMap(capability => [capability.name, capability.description])),
      ...((child.entities || []).map(entity => entity.name)),
    ]),
  ];
  return workspaceSemanticTokens(values.join(' '));
}

export function humanizeWorkspaceNarrativeIdentifiers(value: string): string {
  const protectedPrefix = /^(?:prj|wsp|acct|proj|org|usr)_/i;
  const identifierPrefix = /^(?:entity|node|function|method|class|interface|type)_/i;
  const snakeHumanized = String(value || '').replace(
    /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g,
    (identifier, offset, source) => {
      if (protectedPrefix.test(identifier)) return identifier;
      if (source[offset - 1] === '.' || source[offset + identifier.length] === '.') return identifier;
      return identifier.replace(identifierPrefix, '').split('_').filter(Boolean).join(' ');
    }
  );
  return snakeHumanized
    .replace(/\b([a-z][a-z0-9]*)([A-Z][A-Za-z0-9]*)\b/g, (_match, head, tail) => {
      const splitTail = tail.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
      const proseTail = /^[A-Z]{2}/.test(splitTail)
        ? splitTail
        : splitTail.charAt(0).toLowerCase() + splitTail.slice(1);
      return `${head} ${proseTail}`;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

export function workspaceNarrativeHardRejectReason(description: string, effectiveProductValueSummary?: unknown): string | null {
  const raw = String(description || '');
  if (!raw.trim()) return 'the description is empty';
  if (isWorkspaceAiParseArtifactText(raw)) {
    return 'the description is an unparsed structured-output artifact (raw JSON/model output pasted as prose) — return plain narrative text, never the raw response';
  }
  if (/\b(?:prj|wsp|acct|proj|org|usr)_[A-Za-z0-9]{6,}\b/.test(raw)) {
    return 'the description leaks raw internal id tokens (prj_/wsp_/acct_ style identifiers)';
  }
  if (/\baccount-project[-_:]|\b(?:prj|wsp|acct)[-_](?:[a-z0-9]+[-_]){1,}[a-z0-9]+\b/i.test(raw)) {
    return 'the description leaks an internal account/project storage identifier';
  }
  if (workspaceProseLeaksInternalIdentifier(raw)) {
    return 'the description leaks a human-labeled internal account/project/workspace identifier';
  }
  if (/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/.test(raw)) {
    return 'the description leaks a raw implementation identifier; translate snake_case/camelCase symbols into ordinary workspace language';
  }
  if (/\b(?:resource|data|module)\.[a-z0-9_]+\.[a-z0-9_]+\b/i.test(raw)) {
    return 'the description leaks a raw infrastructure address instead of explaining the workspace-level resource';
  }
  if (/\b[\w.-]+\.(?:tf|tfvars|hcl|ts|tsx|js|jsx|py|rs|go|php|cs|java|rb|sh|bash|zsh|ps1|bat|cmd|yml|yaml|json|toml)\b/i.test(raw)) {
    return 'the description leaks source-file names instead of workspace-level behavior';
  }
  if (/\b(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s*\/\s*(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/.test(raw)) {
    return 'the description dumps HTTP-method route fragments (e.g. "DELETE/PATCH/GET route(s)") instead of workspace-level behavior';
  }
  if (/\/:[A-Za-z_]/.test(raw) || /\/[A-Za-z0-9_.~-]+\/:\s?[A-Za-z_]/.test(raw)) {
    return 'the description quotes raw route path fragments with parameter placeholders (e.g. "/api/friends/:friendshipId")';
  }
  if (/\bis an? (?:[a-z][a-z-]*\s+){0,3}flow\b/i.test(raw) || /\b(?:reached|triggered|invoked) by\b[^.]{0,120}\broutes?\b/i.test(raw)) {
    return 'the description is single-flow altitude prose (describes one flow/endpoint, not the workspace)';
  }

  if (
    /\b(?:hash(?:es)?|sha-?\d*|checksums?|digests?)\b[\s:=("'`-]{0,4}(?:value\s+|token\s+|id\s+)?[0-9a-f]{4,64}\b/i.test(raw) ||
    /\b[0-9a-f]{7,64}\b[\s)"'`-]{0,3}(?:hash(?:es)?|sha|checksums?|digests?)\b/i.test(raw)
  ) {
    return 'the description leaks a raw hash-shaped token (bare digit/hex token tied to hash/sha context)';
  }

  const summary = String(effectiveProductValueSummary ?? '').trim();
  if (!summary) {
    return 'the narrative has an empty product_value_summary alongside a non-empty description';
  }
  return null;
}

function workspaceMarketingGroundingTokens(graph: WorkspaceAnalysisGraph | undefined): { tokens: string[]; text: string } {
  if (!graph) return { tokens: [], text: '' };
  const sources = [
    ...(graph.workspace_domains || []).slice(0, 16).map(domain => domain.name),
    ...(graph.workspace_capabilities || []).slice(0, 24).map(capability => capability.name),
    ...(graph.codebases || []).map(codebase => codebase.primary_domain || ''),
    ...(graph.workspace_entities || []).slice(0, 24).map(entity => entity.name),
  ].filter(Boolean);
  const tokens = sources
    .flatMap(value => normalizeAiItemName(String(value)).split(/\s+/))
    .filter(token => token.length > 2);
  return { tokens, text: sources.join(' ').toLowerCase() };
}

export function workspaceNarrativeMarketingMatches(graph: WorkspaceAnalysisGraph | undefined, text: string): string[] {
  const grounding = workspaceMarketingGroundingTokens(graph);
  return ungroundedMarketingMatches(String(text || ''), [], grounding.tokens, grounding.text);
}

export function stripUngroundedWorkspaceMarketingLanguage(graph: WorkspaceAnalysisGraph | undefined, text: string): string {
  const matches = workspaceNarrativeMarketingMatches(graph, text);
  if (matches.length === 0) return String(text || '');
  let result = String(text || '');
  for (const match of matches) {
    const pattern = new RegExp(`\\s*\\b${match.split(/[\s-]+/).map(part => escapeRegExp(part)).join('[- ]')}\\b`, 'gi');
    result = result.replace(pattern, '');
  }
  return result
    .replace(/\s+([.,;:])/g, '$1')
    .replace(/\ban?\s+([.,;:])/gi, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function cleanWorkspaceValueDrivers(
  graph: WorkspaceAnalysisGraph,
  candidates: string[] | undefined,
  fallback: string[] = [],
): string[] {
  const clean = (values: string[]): string[] => values
    .map(value => String(value || '').replace(/\s+/g, ' ').trim())
    .filter(value => value.length >= 12 && value.length <= 180)
    .filter(value => workspaceNarrativeMarketingMatches(graph, value).length === 0)
    .filter(value => !/\b(?:use of|built with|frameworks? and languages?|technology stack|modern technolog|multi[- ]language|polyglot|language support|development needs|modular infrastructure)\b/i.test(value));
  const preferred = clean(candidates || []);
  return (preferred.length > 0 ? preferred : clean(fallback)).slice(0, 8);
}

export function workspaceNarrativeMisattributionReason(graph: WorkspaceAnalysisGraph, description: string): string | null {
  const codebases = graph.codebases || [];
  if (codebases.length < 2) return null;
  const workspaceName = normalizeAiItemName(graph.name || '');
  const members = codebases
    .map(codebase => ({ id: codebase.id, name: codebase.name, normalized: normalizeAiItemName(codebase.name) }))
    .filter(member => member.normalized.length >= 3 && member.normalized !== workspaceName);
  if (members.length < 2) return null;
  const exclusiveCapabilities: Array<{ ownerId: string; ownerName: string; ownerNormalized: string; capability: string; normalized: string }> = [];
  for (const capability of graph.workspace_capabilities || []) {
    const owners = [...new Set(capability.project_ids || [])];
    if (owners.length !== 1) continue;
    const owner = members.find(member => member.id === owners[0]);
    if (!owner) continue;
    const normalized = normalizeAiItemName(capability.name);
    if (normalized.length < 8 || normalized.split(/\s+/).length < 2) continue;
    exclusiveCapabilities.push({ ownerId: owner.id, ownerName: owner.name, ownerNormalized: owner.normalized, capability: capability.name, normalized });
  }
  const sentences = String(description || '').split(/(?<=[.!?])\s+/).filter(Boolean);
  for (const sentence of sentences) {
    const normalizedSentence = normalizeAiItemName(sentence);

    const subject = members
      .map(member => ({ member, index: normalizedSentence.search(new RegExp(`\\b${escapeRegExp(member.normalized)}\\b`)) }))
      .filter(item => item.index >= 0)
      .sort((left, right) => left.index - right.index)[0];
    if (!subject || subject.index > 24) continue;
    for (const item of exclusiveCapabilities) {
      if (item.ownerId === subject.member.id) continue;
      if (new RegExp(`\\b${escapeRegExp(item.ownerNormalized)}\\b`).test(normalizedSentence)) continue;
      if (new RegExp(`\\b${escapeRegExp(item.normalized)}\\b`).test(normalizedSentence)) {
        return `the narrative attributes "${item.capability}" (evidence only in member ${item.ownerName}) to ${subject.member.name} — attribute each member project's domains/capabilities to that member, and describe the workspace by its own name, never as a single member`;
      }
    }
  }

  return (
    workspaceNarrativeDomainMisattributionReason(graph, description) ||

    workspaceNarrativeEntityMisattributionReason(graph, description) ||
    workspaceNarrativeApplicationMisattributionReason(graph, description)
  );
}

export function workspaceNarrativeApplicationMisattributionReason(graph: WorkspaceAnalysisGraph, description: string): string | null {
  if ((graph.application_links || []).some(applicationLinkHasSourceBackedEvidence)) return null;
  const members = (graph.codebases || []).map(codebase => ({
    id: codebase.id,
    name: codebase.name,
    normalized: normalizeAiItemName(codebase.name),
  }));
  if (members.length < 2) return null;
  const canonicalApplicationById = new Map((graph.applications || []).map(application => [application.id, application]));
  const surfaces = (graph.detail_views?.overview?.deployables || [])
    .map(application => {
      const ownerId = canonicalApplicationById.get(application.id)?.codebase_id;
      return {
        ownerId,
        ownerName: members.find(member => member.id === ownerId)?.name || ownerId,
        name: application.name,
        normalized: normalizeAiItemName(application.name),
      };
    })
    .filter(surface => Boolean(surface.ownerId))
    .filter(surface => surface.normalized.length >= 5);
  for (const sentence of String(description || '').split(/(?<=[.!?])\s+/).filter(Boolean)) {
    const normalizedSentence = normalizeAiItemName(sentence);
    const subject = members
      .map(member => ({ member, index: normalizedSentence.search(new RegExp(`\\b${escapeRegExp(member.normalized)}\\b`)) }))
      .filter(item => item.index >= 0)
      .sort((left, right) => left.index - right.index)[0];
    if (!subject || subject.index > 24) continue;
    for (const surface of surfaces) {
      if (surface.ownerId === subject.member.id) continue;
      if (!new RegExp(`\\b${escapeRegExp(surface.normalized)}\\b`).test(normalizedSentence)) continue;
      const owner = members.find(member => member.id === surface.ownerId);
      if (owner && new RegExp(`\\b${escapeRegExp(owner.normalized)}\\b`).test(normalizedSentence)) continue;
      return `the narrative attributes deployable "${surface.name}" (owned by member ${surface.ownerName}) to ${subject.member.name}, but no source-backed cross-project link exists`;
    }
  }
  return null;
}

export function workspaceNarrativeEntityMisattributionReason(graph: WorkspaceAnalysisGraph, description: string): string | null {
  const codebases = graph.codebases || [];
  if (codebases.length < 2) return null;
  const workspaceName = normalizeAiItemName(graph.name || '');
  const members = codebases
    .map(codebase => ({ id: codebase.id, name: codebase.name, normalized: normalizeAiItemName(codebase.name) }))
    .filter(member => member.normalized.length >= 3 && member.normalized !== workspaceName);
  if (members.length < 2) return null;
  const normalizeEntityPhrase = (value: string): string => normalizeAiItemName(splitCamelCaseProseToken(String(value || '')));
  const exclusiveEntities: Array<{ ownerId: string; ownerName: string; ownerNormalized: string; entity: string; normalized: string; lastToken: string }> = [];
  for (const entity of graph.workspace_entities || []) {
    const owners = [...new Set(entity.project_ids || [])];
    if (owners.length !== 1) continue;
    const owner = members.find(member => member.id === owners[0]);
    if (!owner) continue;
    const normalized = normalizeEntityPhrase(entity.name);
    const tokens = normalized.split(/\s+/).filter(Boolean);

    if (normalized.length < 4) continue;
    if (tokens.length === 1 && WORKSPACE_GENERIC_ENTITY_TOKENS.has(tokens[0])) continue;
    if (tokens.length > 1 && tokens.every(token => WORKSPACE_GENERIC_ENTITY_TOKENS.has(token))) continue;
    exclusiveEntities.push({
      ownerId: owner.id,
      ownerName: owner.name,
      ownerNormalized: owner.normalized,
      entity: entity.name,
      normalized,
      lastToken: tokens[tokens.length - 1] || normalized,
    });
  }
  if (exclusiveEntities.length === 0) return null;

  const creditingVerb = /\b(provid\w*|offer\w*|includ\w*|deliver\w*|serv\w*|host\w*|run\w*|operat\w*|expos\w*|power\w*|enabl\w*|features?|manag\w*|purchas\w*|buy\w*|buys|sell\w*|track\w*|handl\w*|process\w*|creat\w*|store\w*|stores|support\w*|maintain\w*|own\w*)\b/;
  const sentences = String(description || '').split(/(?<=[.!?])\s+/).filter(Boolean);
  for (const sentence of sentences) {
    const normalizedSentence = normalizeEntityPhrase(sentence);
    const subject = members
      .map(member => ({ member, index: normalizedSentence.search(new RegExp(`\\b${escapeRegExp(member.normalized)}\\b`)) }))
      .filter(item => item.index >= 0)
      .sort((left, right) => left.index - right.index)[0];
    if (!subject || subject.index > 24) continue;
    for (const ent of exclusiveEntities) {
      if (ent.ownerId === subject.member.id) continue;

      const phraseWithPlural = ent.normalized.replace(/\s*$/, '') + 's?';
      const re = new RegExp(`(?:\\b(\\w+)\\s+)?\\b${phraseWithPlural}\\b`, 'g');
      let match: RegExpExecArray | null;
      while ((match = re.exec(normalizedSentence)) !== null) {
        const precedingWord = match[1] || '';
        if (precedingWord === ent.ownerNormalized) continue;
        if (creditingVerb.test(normalizedSentence.slice(0, match.index))) {
          return `the narrative credits ${subject.member.name} with the "${ent.entity}" entity, which the deterministic workspace attribution assigns exclusively to member ${ent.ownerName} — attribute "${ent.entity}" (and its data) to ${ent.ownerName}, describe each member's own entities under that member, and never fold one member's product into another`;
        }
      }
    }
  }
  return null;
}

const WORKSPACE_GENERIC_ENTITY_TOKENS = new Set([
  'user', 'users', 'account', 'accounts', 'order', 'orders', 'session', 'sessions',
  'data', 'item', 'items', 'record', 'records', 'event', 'events', 'request',
  'requests', 'response', 'responses', 'token', 'tokens', 'config', 'message',
  'messages', 'log', 'logs', 'job', 'jobs', 'task', 'tasks', 'file', 'files',
  'node', 'nodes', 'edge', 'edges', 'role', 'roles', 'status', 'entry', 'entries',
  'value', 'key', 'keys', 'name', 'names', 'operation', 'operations', 'decision',
  'decisions', 'profile', 'profiles', 'source', 'sources', 'company', 'product',
  'products', 'location', 'delivery', 'invoice', 'approval', 'approvals',
]);

export function workspaceNarrativeDomainMisattributionReason(graph: WorkspaceAnalysisGraph, description: string): string | null {
  const codebases = graph.codebases || [];
  if (codebases.length < 2) return null;
  const workspaceName = normalizeAiItemName(graph.name || '');
  const members = codebases
    .map(codebase => ({ id: codebase.id, name: codebase.name, normalized: normalizeAiItemName(codebase.name) }))
    .filter(member => member.normalized.length >= 3 && member.normalized !== workspaceName);
  if (members.length < 2) return null;
  const exclusiveDomains: Array<{ ownerId: string; ownerName: string; ownerNormalized: string; domain: string; normalized: string }> = [];
  for (const domain of graph.workspace_domains || []) {
    const owners = [...new Set(domain.project_ids || [])];
    if (owners.length !== 1) continue;
    const owner = members.find(member => member.id === owners[0]);
    if (!owner) continue;
    const normalized = normalizeAiItemName(domain.name);

    if (normalized.length < 5 || WORKSPACE_GENERIC_DOMAIN_TOKENS.has(normalized)) continue;
    exclusiveDomains.push({ ownerId: owner.id, ownerName: owner.name, ownerNormalized: owner.normalized, domain: domain.name, normalized });
  }
  if (exclusiveDomains.length === 0) return null;
  const creditingVerb = /\b(provid\w*|offer\w*|includ\w*|deliver\w*|serv\w*|act\w*|function\w*|host\w*|run\w*|operat\w*|expos\w*|power\w*|enabl\w*|features?)\b/;
  const sentences = String(description || '').split(/(?<=[.!?])\s+/).filter(Boolean);
  for (const sentence of sentences) {
    const normalizedSentence = normalizeAiItemName(sentence);
    const subject = members
      .map(member => ({ member, index: normalizedSentence.search(new RegExp(`\\b${escapeRegExp(member.normalized)}\\b`)) }))
      .filter(item => item.index >= 0)
      .sort((left, right) => left.index - right.index)[0];
    if (!subject || subject.index > 24) continue;
    for (const dom of exclusiveDomains) {
      if (dom.ownerId === subject.member.id) continue;

      const re = new RegExp(`(?:\\b(\\w+)\\s+)?\\b${escapeRegExp(dom.normalized)}\\b`, 'g');
      let match: RegExpExecArray | null;
      while ((match = re.exec(normalizedSentence)) !== null) {
        const precedingWord = match[1] || '';
        if (precedingWord === dom.ownerNormalized) continue;
        if (creditingVerb.test(normalizedSentence.slice(0, match.index))) {
          return `the narrative credits ${subject.member.name} with the "${dom.domain}" domain, which the deterministic workspace attribution assigns exclusively to member ${dom.ownerName} — attribute "${dom.domain}" to ${dom.ownerName}, describe each member's own domains under that member, and never fold one member's product into another`;
        }
      }
    }
  }
  return null;
}

const WORKSPACE_GENERIC_DOMAIN_TOKENS = new Set([
  'access', 'rules', 'order', 'orders', 'cards', 'network', 'security', 'channel',
  'operations', 'risks', 'verification', 'agents', 'agent', 'tools', 'devices',
  'profiles', 'terms', 'approvals', 'session', 'sessions', 'status', 'data',
]);

export function evaluateWorkspaceNarrativeGate(
  graph: WorkspaceAnalysisGraph,
  description: string,
  productValueSummary?: unknown,
  fallbackProductValueSummary?: string,
): { accepted: boolean; reason?: string } {
  const effectiveSummary = String(productValueSummary ?? '').trim() || String(fallbackProductValueSummary ?? '').trim();
  const hardReject = workspaceNarrativeHardRejectReason(description, effectiveSummary);
  if (hardReject) return { accepted: false, reason: hardReject };
  const misattribution = workspaceNarrativeMisattributionReason(graph, description);
  if (misattribution) {
    return { accepted: false, reason: misattribution };
  }
  const unsupportedMutation = workspaceNarrativeUnsupportedMutationClaim(graph, `${description} ${effectiveSummary}`);
  if (unsupportedMutation) return { accepted: false, reason: unsupportedMutation };
  if (workspaceNarrativeUsesImplementationStackAsProductFrame(graph, `${description} ${effectiveSummary}`)) {
    return { accepted: false, reason: 'the workspace narrative substitutes implementation-stack diversity for product behavior; describe what each member does and why it exists' };
  }
  if ((graph.codebases || []).length > 1 &&
    (graph.application_links || []).filter(applicationLinkHasSourceBackedEvidence).length === 0 &&
    !/\b(?:independent|separate|not connected|no source-backed connection)\b/i.test(description)) {
    return { accepted: false, reason: 'the analyzed members have no source-backed cross-project links; state clearly that they are independent rather than implying one combined runtime' };
  }
  if (
    (graph.application_links || []).filter(applicationLinkHasSourceBackedEvidence).length === 0 &&
    (
      /\b(?:(?:both|the two|these)\s+(?:projects?|codebases?|services?|systems?)|(?:projects?|systems?)\s+(?:are|that are)?)\b[^.]{0,140}\b(?:interact|communicat|connect|integrat|share|exchange|flow through|route through|through a shared|via a shared|work together)/i.test(description) ||
      /\bthese\s+(?:projects?|codebases?|services?|systems?)\s+work together\b/i.test(description)
    )
  ) {
    return {
      accepted: false,
      reason: 'the description invents cross-project interaction, but the workspace-level CAS has no source-backed application link; describe the members as independent unless deterministic link evidence appears',
    };
  }
  const unsupportedCrossProjectClaim = workspaceNarrativeUnsupportedCrossProjectClaim(graph, description);
  if (unsupportedCrossProjectClaim) {
    return { accepted: false, reason: unsupportedCrossProjectClaim };
  }

  const marketingMatches = workspaceNarrativeMarketingMatches(graph, `${description} ${String(productValueSummary ?? '')}`);
  if (marketingMatches.length >= 3) {

    const strippedDescription = stripUngroundedWorkspaceMarketingLanguage(graph, description);
    const strippedStandsAlone =
      strippedDescription.length >= 180 &&
      (isUsefulAiWorkspaceNarrative(strippedDescription) ||
        isGroundedAiWorkspaceNarrative(graph, strippedDescription, productValueSummary) ||
        isWorkspaceSemanticsGroundedNarrative(graph, strippedDescription));
    if (!strippedStandsAlone) {
      return {
        accepted: false,
        reason: `unsupported-marketing-language saturation (${marketingMatches.join(', ')}): replace marketing adjectives with concrete, evidence-backed workspace behavior`,
      };
    }

  }
  const unsupportedFrame = workspaceNarrativeUnsupportedFrameReason(graph, description, productValueSummary);
  if (unsupportedFrame) {
    return { accepted: false, reason: unsupportedFrame };
  }
  if (isUsefulAiWorkspaceNarrative(description)) return { accepted: true };
  if (isGroundedAiWorkspaceNarrative(graph, description, productValueSummary)) return { accepted: true };
  if (isWorkspaceSemanticsGroundedNarrative(graph, description)) return { accepted: true };
  return {
    accepted: false,
    reason: 'the description is generic or ungrounded: it needs a multi-sentence workspace-level narrative (>=180 chars) that names the workspace\'s real capabilities, domains, codebases, or deployables and uses concrete behavior verbs',
  };
}

function workspaceNarrativeUsesImplementationStackAsProductFrame(
  graph: WorkspaceAnalysisGraph,
  narrative: string,
): boolean {
  let normalized = normalizeAiItemName(narrative);
  const evidenceNames = [
    graph.name,
    ...(graph.codebases || []).map(codebase => codebase.name),
    ...(graph.applications || []).map(application => application.name),
    ...(graph.distribution_units || []).map(unit => unit.name),
  ]
    .map(normalizeAiItemName)
    .filter(name => name.length >= 4)
    .sort((left, right) => right.length - left.length);
  for (const name of evidenceNames) {
    normalized = normalized.replace(new RegExp(`\\b${escapeRegExp(name)}\\b`, 'g'), ' ');
  }
  return /\b(?:polyglot|multi[- ]language|language support|language specific|frameworks? and languages?|development needs|technology stack)\b/.test(normalized);
}

function workspaceNarrativeUnsupportedMutationClaim(graph: WorkspaceAnalysisGraph, text: string): string | null {
  const mutationVerb = /\b(?:manage|management|create|creation|update|delete|write|configure|modify|mutate|mutation|submit|process|processing|handle)\b/i;
  const readSignal = /\b(?:view|viewing|read|reading|list|listing|access|retrieve|retrieval|review|reviewing|show|browse|lookup|search|present|presentation)\b/i;
  const mutationCapabilities = (graph.workspace_capabilities || []).filter(capability => mutationVerb.test(capability.name));
  const normalizedText = normalizeAiItemName(text);
  for (const capability of graph.workspace_capabilities || []) {
    if (!readSignal.test(capability.name) || mutationVerb.test(capability.name)) continue;
    const subject = normalizeAiItemName(capability.name)
      .replace(/\b(?:view|viewing|read|reading|list|listing|access|retrieve|retrieval|review|reviewing|show|browse|lookup|search|present|presentation|surface)\b/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const subjectTokens = subject.split(/\s+/).filter(token => token.length >= 3);
    if (subjectTokens.length === 0) continue;
    const hasMutationCounterpart = mutationCapabilities.some(candidate => {
      const candidateText = normalizeAiItemName(candidate.name);
      return subjectTokens.some(token => candidateText.includes(token));
    });
    if (hasMutationCounterpart) continue;
    const subjectPattern = subjectTokens
      .map(token => `${escapeRegExp(token.replace(/s$/, ''))}s?`)
      .join('\\s+');
    const claimPattern = new RegExp(`(?:\\b(?:manag(?:e|es|ed|ing|ement)|creat(?:e|es|ed|ing|ion)|updat(?:e|es|ed|ing|ion)|delet(?:e|es|ed|ing|ion)|writ(?:e|es|ing)|configur(?:e|es|ed|ing|ation)|modif(?:y|ies|ied|ying|ication)|mutat(?:e|es|ed|ing|ion)|process(?:es|ed|ing)?|handl(?:e|es|ed|ing))(?:\\s+and\\s+(?:view|views|viewing|review|reviews|reviewing|analyz(?:e|es|ing)|read|reads|reading|present|presents|presenting))?\\s+(?:the\\s+)?${subjectPattern}\\b|\\b${subjectPattern}\\s+(?:management|processing|mutation|lifecycle)\\b)`, 'i');
    if (claimPattern.test(normalizedText)) {
      return `the narrative claims mutation of ${subject}, but the workspace evidence exposes only the read capability "${capability.name}"`;
    }
  }
  return null;
}

function workspaceNarrativeUnsupportedCrossProjectClaim(graph: WorkspaceAnalysisGraph, description: string): string | null {
  if ((graph.application_links || []).some(applicationLinkHasSourceBackedEvidence)) return null;
  if ((graph.codebases || []).length < 2) return null;

  const termsByProject = new Map<string, Set<string>>();
  const add = (projectId: string, value: string): void => {
    const normalized = normalizeAiItemName(value);
    if (normalized.length < 4) return;
    const terms = termsByProject.get(projectId) || new Set<string>();
    terms.add(normalized);
    termsByProject.set(projectId, terms);
  };
  for (const codebase of graph.codebases || []) add(codebase.id, codebase.name);
  for (const application of graph.applications || []) add(application.codebase_id, application.name);
  for (const domain of graph.workspace_domains || []) {
    if (domain.project_ids.length === 1) add(domain.project_ids[0], domain.name);
  }
  for (const capability of graph.workspace_capabilities || []) {
    if (capability.project_ids.length === 1) add(capability.project_ids[0], capability.name);
  }
  for (const entity of graph.workspace_entities || []) {
    if (entity.project_ids.length === 1) add(entity.project_ids[0], entity.name);
  }

  const relationshipVerb = /\b(?:using|through|via|between|together|shared|connect\w*|integrat\w*|interact\w*|communicat\w*|exchang\w*|send\w*|receiv\w*|publish\w*|consum\w*|broker\w*|relay\w*|route\w*|flow\w*|facilitat\w*|coordinat\w*|orchestrat\w*)\b/i;
  for (const sentence of String(description || '').split(/(?<=[.!?])\s+/).filter(Boolean)) {
    if (!relationshipVerb.test(sentence)) continue;
    const normalizedSentence = normalizeAiItemName(sentence);
    const matchedProjects = [...termsByProject.entries()].filter(([, terms]) =>
      [...terms].some(term => new RegExp(`\\b${escapeRegExp(term).replace(/\\s+/g, '\\\\s+')}\\b`).test(normalizedSentence))
    );
    if (matchedProjects.length >= 2) {
      return 'the description claims interaction between independently analyzed projects without a source-backed application link; describe each member separately unless deterministic link evidence appears';
    }
  }
  return null;
}

const WORKSPACE_BEHAVIOR_WORD_PATTERN = /\b(?:brokers?|relays?|routes?|ships?|installs?|communicates?|calls?|pairs?|interacts?|authenticates?|authorizes?|enrolls?|connects?|protects?|provisions?|declares?|exposes?|records?|forwards?|coordinates?|manages?|handles?|supports?|provides?|processes?|captures?|uses?|consumes?|performs?|orchestrates?|flows?|turns?|transforms?|generates?|retrieves?|returns?|maps?|compares?|compresses?|guides?|validates?|depends?|enables?|enabling|powers?|drives?|runs?|executes?|requires?|syncs?|trades?|settles?|holds?|tracks?|surfaces?|lets?|gives?|fronts?|stores?|persists?|publishes?|streams?|schedules?|triggers?|signs?|verifies?|secures?|enforces?|monitors?)\b/g;

function isWorkspaceSemanticsGroundedNarrative(graph: WorkspaceAnalysisGraph, description: string): boolean {
  const text = String(description || '').trim();
  if (text.length < 180) return false;
  const normalized = normalizeAiItemName(text);
  if (/\b(?:classified as|repo analysis input|language inventory|primarily built using|consists of multiple|contains analyzed projects)\b/.test(normalized)) return false;
  const semanticNames = new Set<string>();
  for (const capability of (graph.workspace_capabilities || []).slice(0, 16)) semanticNames.add(normalizeAiItemName(capability.name));
  for (const domain of (graph.workspace_domains || []).slice(0, 12)) semanticNames.add(normalizeAiItemName(domain.name));
  for (const codebase of (graph.codebases || []).slice(0, 24)) semanticNames.add(normalizeAiItemName(codebase.name));
  for (const app of (graph.applications || []).slice(0, 48)) semanticNames.add(normalizeAiItemName(app.name));
  const mentioned = [...semanticNames].filter(name => name.length >= 3 && normalized.includes(name)).length;
  const behaviorWords = (normalized.match(WORKSPACE_BEHAVIOR_WORD_PATTERN) || []).length;
  return mentioned >= 2 && behaviorWords >= 2;
}

function isUsefulAiWorkspaceNarrative(description: string): boolean {
  const text = description.trim();
  const normalized = normalizeAiItemName(text);
  if (text.length < 180) return false;
  const bannedInventoryPhrases = [
    /consists of multiple/,
    /contains (?:\d+ )?(?:analyzed )?projects/,
    /primarily built using/,
    /the system includes (?:an?|various|multiple) /,
    /various (?:applications|services|components)/,
    /multiple applications and services/,
  ];
  if (bannedInventoryPhrases.some(pattern => pattern.test(normalized))) return false;
  const behaviorWords = (normalized.match(WORKSPACE_BEHAVIOR_WORD_PATTERN) || []).length;
  const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean).length;
  return behaviorWords >= 3 && sentences >= 2 && workspaceSemanticTokens(text).size >= 5;
}

function workspaceNarrativeUnsupportedFrameReason(graph: WorkspaceAnalysisGraph, description: string, productValueSummary?: unknown): string | null {
  const claim = cleanNarrativeSummaryString(productValueSummary) || description;
  const claimTokens = workspaceSemanticTokens(claim);
  if (claimTokens.size < 3) return null;
  const evidenceTokens = workspaceEvidenceTokens(graph);
  const tokenSupported = (token: string) => [...evidenceTokens].some(evidenceToken =>
    token === evidenceToken ||
    (Math.min(token.length, evidenceToken.length) >= 4 && (token.startsWith(evidenceToken) || evidenceToken.startsWith(token)))
  );
  const supported = [...claimTokens].filter(tokenSupported);
  const unsupported = [...claimTokens].filter(token => !tokenSupported(token));
  if (supported.length >= Math.max(1, Math.ceil(claimTokens.size * 0.25)) || unsupported.length < 2) return null;
  const evidenceHint = () => {
    const domains = [
      ...graph.codebases.map(codebase => codebase.primary_domain).filter(Boolean) as string[],
      ...primaryWorkspaceDomains(graph).map(domain => domain.name),
    ].filter(Boolean).slice(0, 5);
    const capabilities = primaryWorkspaceCapabilities(graph).map(capability => capability.name).slice(0, 5);
    const parts: string[] = [];
    if (domains.length) parts.push(`domains: ${[...new Set(domains)].join(', ')}`);
    if (capabilities.length) parts.push(`capabilities: ${capabilities.join(', ')}`);
    return parts.length ? ` Reframe the description around the workspace's own evidence (${parts.join('; ')}).` : '';
  };
  return `the workspace evidence does not support the claimed product frame "${claim.slice(0, 120)}"; unsupported concepts: ${unsupported.slice(0, 5).join(', ')}.${evidenceHint()}`;
}

function isGroundedAiWorkspaceNarrative(graph: WorkspaceAnalysisGraph, description: string, productValueSummary?: unknown): boolean {
  const normalized = normalizeAiItemName(`${description} ${cleanNarrativeString(productValueSummary)}`);
  if (description.trim().length < 180) return false;
  if (/\b(?:classified as|repo analysis input|language inventory|primarily built using|consists of multiple|contains analyzed projects)\b/.test(normalized)) return false;
  const claimTokens = workspaceSemanticTokens(normalized);
  const evidenceTokens = workspaceEvidenceTokens(graph);
  const overlap = [...claimTokens].filter(token => evidenceTokens.has(token)).length;
  const behaviorWords = (normalized.match(WORKSPACE_BEHAVIOR_WORD_PATTERN) || []).length;
  return overlap >= 3 && behaviorWords >= 3;
}

function usefulAiProductValueSummary(value: unknown, fallback?: string, graph?: WorkspaceAnalysisGraph): string | undefined {
  const text = safeAiProductValueSummary(value, fallback, graph);
  if (!text) return undefined;
  const normalized = normalizeAiItemName(text);
  const hasBehavior = (normalized.match(WORKSPACE_BEHAVIOR_WORD_PATTERN) || []).length > 0;
  return hasBehavior && workspaceSemanticTokens(text).size >= 3 ? text : undefined;
}

function safeAiProductValueSummary(value: unknown, fallback?: string, graph?: WorkspaceAnalysisGraph): string | undefined {
  const text = cleanNarrativeSummaryString(value);
  if (!text) return undefined;
  const normalized = normalizeAiItemName(text);
  if (graph && workspaceNarrativeUnsupportedFrameReason(graph, text, text)) return undefined;
  const unsupportedMarketing = /\b(scalable|scalability|flexibility|enterprise grade|enterprise-grade|real time|mission critical|mission-critical|compliance|hybrid environments?)\b/.test(normalized);
  if (unsupportedMarketing) return undefined;

  const marketingMatches = workspaceNarrativeMarketingMatches(graph, text);
  if (marketingMatches.length >= 3) return undefined;
  if (marketingMatches.length > 0) {
    const stripped = stripUngroundedWorkspaceMarketingLanguage(graph, text);
    return stripped.length >= 20 ? stripped : undefined;
  }
  return text;
}

function fuzzyAiItemMap(items: Array<{ name: string; description?: string }>): Map<string, { name: string; description?: string }> {
  const byName = new Map<string, { name: string; description?: string }>();
  for (const item of items) {
    byName.set(normalizeAiItemName(item.name), item);
  }
  return byName;
}

function findAiItem(byName: Map<string, { name: string; description?: string }>, name: string): { name: string; description?: string } | undefined {
  const normalized = normalizeAiItemName(name);
  const exact = byName.get(normalized);
  if (exact) return exact;
  const direct = [...byName.entries()].find(([key]) => {
    if (key === normalized) return true;
    const keyTokens = key.split(/\s+/).filter(token => token.length >= 4);
    const targetTokens = normalized.split(/\s+/).filter(token => token.length >= 4);
    if (keyTokens.length < 2 || targetTokens.length < 2) return false;
    return key.includes(normalized) || normalized.includes(key);
  })?.[1];
  if (direct) return direct;
  const tokens = new Set(normalized.split(/\s+/).filter(token => token.length >= 4));
  if (tokens.size === 0) return undefined;
  let best: { item?: { name: string; description?: string }; score: number } = { score: 0 };
  for (const [key, item] of byName.entries()) {
    const keyTokens = new Set(key.split(/\s+/).filter(token => token.length >= 4));
    const overlap = [...tokens].filter(token => keyTokens.has(token)).length;
    const score = overlap / Math.max(tokens.size, keyTokens.size, 1);
    if (score > best.score) best = { item, score };
  }
  return best.score >= 0.5 ? best.item : undefined;
}

function normalizeAiItemName(value: string): string {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function workspaceInterpretationEnabled(): boolean {
  return process.env.KLAURO_WORKSPACE_INTERPRETATION !== 'false' &&
    process.env.KLAURO_AI_INTERPRETATION_ENABLED !== 'false' &&
    process.env.KLAURO_AI_INTERPRETATION !== 'false';
}

export async function withWorkspaceAiTimeout<T>(promise: Promise<T>): Promise<T> {
  const slowMs = Number(
    process.env.KLAURO_WAS_AI_SLOW_MS ||
    process.env.KLAURO_WAS_AI_TIMEOUT_MS ||
    process.env.KLAURO_WORKSPACE_AI_TIMEOUT_MS ||
    120_000,
  );
  let timer: NodeJS.Timeout | undefined;
  const startedAt = Date.now();
  try {
    if (Number.isFinite(slowMs) && slowMs > 0) {
      timer = setTimeout(() => {
        process.stderr.write(`${JSON.stringify({
          event: 'workspace_ai_slow',
          elapsed_ms: Date.now() - startedAt,
          threshold_ms: slowMs,
          action: 'continuing',
        })}\n`);
      }, slowMs);
      timer.unref?.();
    }
    return await promise;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function workspaceNarrativePromptContext(graph: WorkspaceAnalysisGraph): Record<string, unknown> {
  const productName = inferWorkspaceProductName(graph.codebases, graph.name);

  return {
    compactPrompt: true,
    responseFormat: 'json',
    maxTokens: Number(process.env.KLAURO_WORKSPACE_AI_MAX_TOKENS || '650'),
    prompt_version: 'workspace-default-primary-semantics-v10',
    product_name: productName,
    task: 'Return only valid JSON with keys description, product_value_summary, domain_items, capability_items, value_drivers, relationship_summary. domain_items and capability_items must include every required exact name exactly once. Use only supplied workspace-level CAS facts.',
    style: `Write for a senior engineer or AI agent changing ${productName}. The description is one concrete paragraph about product/runtime behavior, not an inventory. It must explain how the key deployables, contracts, data, or infrastructure work together.`,
    quality_gate: 'The output is rejected unless every required domain/capability has a specific description grounded in its target evidence. Descriptions must not merely restate the name, say "provides/manages functionality", or invent relationships.',
    contract: 'Keep graph facts deterministic. AI may describe existing facts but must not create new links, dependencies, deployables, workflows, entities, or runtime claims.',
    required_domain_names: primaryWorkspaceDomains(graph).map(domain => domain.name),
    required_capability_names: primaryWorkspaceCapabilities(graph).map(capability => capability.name),
    output_schema: {
      description: 'one paragraph, 180-420 characters, evidence-backed',
      product_value_summary: 'one sentence explaining the product/business job this workspace appears to serve',
      domain_items: [{ name: 'exact required domain name', description: '80-180 chars; includes target word and concrete evidence' }],
      capability_items: [{ name: 'exact required capability name', description: '80-190 chars; includes target word and concrete evidence' }],
      value_drivers: ['short evidence-backed product or engineering value driver'],
      relationship_summary: ['source -> target or deployable relationship from the facts'],
    },
    required_output_rules: [
      'The description must reflect product_value_summary_hint and then explain concrete app/deployable relationships from must_explain.',
      'Return product_value_summary as one evidence-backed sentence explaining the product/business job this workspace appears to serve.',
      'Do not use unsupported marketing claims such as scalable, enterprise-grade, real-time, mission-critical, compliance, or hybrid environments unless those exact facts appear in evidence.',
      'facts.member_projects lists DISTINCT member projects, each with its OWN own_capabilities/own_domains. Attribute every capability, domain, and behavior to the member project that owns it; never present one member as the workspace, never assign one member\'s capabilities to another member, and never frame or title the workspace as a single member.',
      'facts.member_projects.own_entities is exclusive ownership evidence. Mention an entity only under its owning member and never assign one member\'s entity or data to another member.',
      'facts.member_projects.member_description and own_capabilities are completed member-CAS comprehension and are authoritative for that member. Compose them; do not replace them with an interpretation of project names, runtimes, languages, or frameworks.',
      'Describe what each member does and why it exists. Do not describe language diversity, framework coverage, polyglot support, or a technology stack as product value. A member name containing words such as "polyglot" is only a proper name and is not evidence of a product capability.',
      'Infrastructure technologies may be named only as concrete implementation context for an evidence-backed operational responsibility, such as Terraform provisioning a declared queue or Kubernetes running a declared service; they must never replace the member\'s responsibility or product behavior.',
      'facts.behavior_facts.insights and facts.composition are internal analysis diagnostics: NEVER quote their phrasing (e.g. "source-backed", "isolated deployable(s)", "should not be forced into the system graph", "Dockerfile", raw image/port tokens) in customer prose — translate them into plain engineering language or omit them.',
      'For every connection, preserve direction exactly as source -> target. For sdk-install, the source depends on or imports the target; do not reverse that relationship.',
      'Do not turn warnings, unclaimed-provider insights, or topology-only declarations into active source-backed relationships.',
      'Do not describe a service as communicating with another service unless the connection appears in behavior_facts.important_connections with the same source and target.',
      'When facts.relationship_policy says no source-backed cross-project links exist, describe members as independent and never claim they interact through shared infrastructure.',
      'Frame the workspace ONLY through the domains, capabilities, and member-project facts supplied in facts.member_projects, facts.semantic_targets, and must_explain. Never assign the workspace a product category or frame that is not named there.',
      'Return domain_items for every required_domain_names item, using exact names.',
      'Return capability_items for every required_capability_names item, using exact names.',
      'Every domain/capability description must include at least one meaningful word from the exact target name.',
      'Every domain/capability description must name concrete evidence from its target context: app, API, route, entity, workflow, infrastructure, external dependency, or distribution unit.',
      'Only name deployables that appear in that target context. If no target-specific deployable is listed, describe the domain or capability through entities, workflows, routes, or interfaces instead.',
      'If a target is supporting rather than core, say what support plane it represents instead of inflating it into a product capability.',
      'Capability/domain descriptions must be behavior-first; do not expose raw identifiers such as entity_*, snake_case table names, "via lib", or implementation-only names unless they are public product terms.',
      'Preserve capability action semantics exactly: View, Access, List, Read, Show, and Retrieve are read-only and must never become management, mutation, creation, update, deletion, or write claims.',
    ],
    facts: workspaceAiFactSheet(graph, productName),
  };
}

function workspaceAiFactSheet(graph: WorkspaceAnalysisGraph, productName = inferWorkspaceProductName(graph.codebases, graph.name)): Record<string, unknown> {
  const overview = graph.detail_views.overview;
  const appById = new Map(graph.applications.map(app => [app.id, app]));
  const deployables = overview.deployables.slice(0, 8).map(app => {
    const ports = app.ports.map(port => String(port)).filter(Boolean);
    return `${workspacePromptApplicationName(graph, app)}(${app.kind}${ports.length ? `,ports:${ports.slice(0, 4).join('/')}` : ''}${app.isolated ? ',isolated' : ''})`;
  });
  const connections = overview.connections.slice(0, 6).map(connection => {
    const verb = connection.kind === 'sdk-install' ? 'depends on/imports' : 'calls/communicates with';
    return `${workspacePromptApplicationLabel(graph, connection.source)} -> ${workspacePromptApplicationLabel(graph, connection.target)} (${connection.mode} ${connection.kind}, ${connection.evidence_quality}, ${verb})`;
  });
  const distributionUnits = graph.distribution_units.slice(0, 4).map(unit =>
    `${unit.name} ships ${unit.component_names.join(' + ')} together (${unit.kind})`
  );
  const domains = primaryWorkspaceDomains(graph).map(domain => workspaceDomainPromptContext(domain, graph, appById));
  const capabilities = primaryWorkspaceCapabilities(graph).map(capability => workspaceCapabilityPromptContext(capability, graph, appById));
  const workflows = graph.workspace_workflows.slice(0, 4).map(workflow =>
    workspacePromptSafeText(graph, `${workflow.name}: ${workflow.deployable_ids.map(id => appById.get(id) ? workspacePromptApplicationName(graph, appById.get(id)!) : workspacePromptApplicationLabel(graph, id)).slice(0, 3).join(', ')}`)
  ).filter((value): value is string => Boolean(value));
  const codebaseNameById = new Map(graph.codebases.map(codebase => [codebase.id, codebase.name]));
  const entities = graph.workspace_entities.slice(0, 5).map(entity =>
    workspacePromptSafeText(graph, `${entity.name}: ${entity.project_ids.map(id => codebaseNameById.get(id)).filter(Boolean).slice(0, 3).join(', ')}; paths=${entity.path_count || 0}`)
  ).filter((value): value is string => Boolean(value));
  const insights = graph.system_insights.slice(0, 5).map(insight =>
    workspacePromptSafeText(graph, `${insight.type}: ${insight.title} - ${truncateText(insight.description, 96)}`)
  ).filter((value): value is string => Boolean(value));
  const external = overview.external_dependencies.slice(0, 6).map(dep =>
    `${dep.name}(${dep.kind}) ${dep.usage} in ${dep.project}`
  );
  const environments = graph.environments.map(environment =>
    `${environment.name}: ${environment.infrastructure_kinds.slice(0, 3).join(', ')}`
  );

  const memberProjects = graph.codebases.slice(0, 12).map(codebase => ({
    name: codebase.name,
    ...(codebase.primary_domain ? { primary_domain: codebase.primary_domain } : {}),
    ...(codebase.description ? { member_description: workspacePromptSafeText(graph, codebase.description) } : {}),
    system_type: codebase.system_type,
    role: codebase.project_role,
    own_capabilities: (graph.workspace_capabilities || [])
      .filter(capability => (capability.project_ids || []).length >= 1 && capability.project_ids.every(id => id === codebase.id))
      .map(capability => ({
        name: capability.name,
        description: workspacePromptSafeText(graph, capability.description),
        semantic_role: capability.semantic_role,
      }))
      .slice(0, 6),
    own_domains: (graph.workspace_domains || [])
      .filter(domain => (domain.project_ids || []).length >= 1 && domain.project_ids.every(id => id === codebase.id))
      .map(domain => domain.name)
      .slice(0, 5),
    own_entities: (graph.workspace_entities || [])
      .filter(entity => (entity.project_ids || []).length === 1 && entity.project_ids[0] === codebase.id)
      .map(entity => entity.name)
      .slice(0, 10),
  }));
  const memberDomainFacts = graph.codebases
    .filter(codebase => codebase.primary_domain)
    .slice(0, 6)
    .map(codebase => `${codebase.name}: member primary_domain is ${codebase.primary_domain}`);
  const workspaceDomainNames = primaryWorkspaceDomains(graph).map(domain => domain.name).filter(Boolean);
  const mustExplain = [
    ...memberDomainFacts.slice(0, 4),
    ...(workspaceDomainNames.length ? [`workspace domains: ${workspaceDomainNames.slice(0, 6).join(', ')}`] : []),
    ...distributionUnits,
    ...connections,
    ...insights.slice(0, 3),
    ...external.filter(dep => /source-backed/i.test(dep)).slice(0, 3),
  ].slice(0, 14);
  return {
    product_name: productName,
    product_value_summary_hint: graph.workspace_narrative.product_value_summary,
    relationship_policy: connections.length > 0
      ? 'Only the exact source -> target connections listed in behavior_facts.important_connections may be described.'
      : 'No source-backed cross-project links exist. The member projects are independent; shared vocabulary or infrastructure names do not prove communication.',
    must_explain: mustExplain,
    member_projects: memberProjects,
    composition: {
      kind: graph.composition.kind,
      primary_view: graph.composition.recommended_primary_view,
    },
    behavior_facts: {
      distribution_units: distributionUnits,
      important_connections: connections,
      insights,
      external_dependencies: external,
      environments,
    },
    semantic_targets: {
      required_domains: domains,
      required_capabilities: capabilities,
      workflows,
      entities,
    },
    deployables,
  };
}

function workspacePromptApplicationName(
  graph: WorkspaceAnalysisGraph,
  app: { name: string; codebase_id?: string; project_id?: string },
): string {
  const raw = String(app.name || '').trim();
  const ownerId = app.codebase_id || app.project_id || '';
  const codebase = graph.codebases.find(item => item.id === ownerId);
  if (/^(?:account-project[-_:]|prj[-_:])/i.test(raw) || normalizeAiItemName(raw) === normalizeAiItemName(ownerId)) {
    return codebase?.name || 'member project';
  }
  return raw || codebase?.name || 'member project';
}

function workspacePromptApplicationLabel(graph: WorkspaceAnalysisGraph, value: string): string {
  const app = graph.applications.find(item => item.id === value || item.name === value);
  if (app) return workspacePromptApplicationName(graph, app);
  if (/^(?:account-project[-_:]|prj[-_:])/i.test(String(value || ''))) {
    const codebase = graph.codebases.find(item => normalizeAiItemName(item.id) === normalizeAiItemName(value));
    return codebase?.name || 'member project';
  }
  return value;
}

function primaryWorkspaceDomains(graph: WorkspaceAnalysisGraph): WorkspaceDomain[] {
  const productDomains = graph.workspace_domains.filter(domain => domain.semantic_role !== 'infrastructure');
  const coreDomains = productDomains.filter(domain => domain.semantic_role === 'core');
  return (coreDomains.length > 0 ? coreDomains : productDomains.length > 0 ? productDomains : graph.workspace_domains).slice(0, 6);
}

function primaryWorkspaceCapabilities(graph: WorkspaceAnalysisGraph): WorkspaceCapability[] {
  const productCapabilities = graph.workspace_capabilities.filter(capability => capability.semantic_role !== 'infrastructure');
  const coreCapabilities = productCapabilities.filter(capability => capability.semantic_role === 'core');
  return (coreCapabilities.length > 0 ? coreCapabilities : productCapabilities.length > 0 ? productCapabilities : graph.workspace_capabilities).slice(0, 8);
}

function workspaceDomainPromptContext(
  domain: WorkspaceDomain,
  graph: WorkspaceAnalysisGraph,
  appById: Map<string, SystemApplication>,
): Record<string, unknown> {
  const relatedCapabilities = graph.workspace_capabilities
    .filter(capability =>
      capability.evidence.some(evidence => domain.evidence.includes(evidence)) ||
      domain.evidence.some(evidence => evidence.includes(capability.name) || capability.evidence.includes(evidence))
    )
    .slice(0, 4);
  const relatedEntities = graph.workspace_entities
    .filter(entity => normalizeAiItemName(entity.name).includes(normalizeAiItemName(domain.name)) || entity.project_ids.some(projectId => domain.project_ids.includes(projectId)))
    .slice(0, 5);
  const relatedWorkflows = graph.workspace_workflows
    .filter(workflow =>
      workflow.project_ids.some(projectId => domain.project_ids.includes(projectId)) ||
      workflow.evidence.some(evidence => domain.evidence.some(domainEvidence => evidence.includes(domainEvidence) || domainEvidence.includes(evidence)))
    )
    .slice(0, 4);
  const deployables = workspacePromptRelevantDeployableNames(graph, domain.project_ids, domain.name, domain.evidence, domain.terminal_evidence || [], 5);
  return {
    name: domain.name,
    role: domain.semantic_role,
    terminal_score: domain.terminal_score,
    target_words: meaningfulWorkspaceNameTokens(domain.name),
    evidence: workspacePromptEvidence(graph, domain.evidence, 8),
    terminal_evidence: workspacePromptEvidence(graph, domain.terminal_evidence || [], 6),
    grounding_terms: workspaceItemGroundingTerms(domain).filter(term => !looksLikeInternalIdentifierToken(term)).slice(0, 12),
    deployables,
    related_capabilities: relatedCapabilities.map(capability => ({
      name: capability.name,
      role: capability.semantic_role,
      description: isDefaultWorkspaceDescriptionReady(capability.name, capability.description, capability.description_source, 'capability')
        ? workspacePromptSafeText(graph, truncateText(capability.description, 140))
        : undefined,
      evidence: workspacePromptEvidence(graph, capability.evidence, 4),
    })),
    related_entities: relatedEntities.map(entity => ({
      name: entity.name,
      role: entity.semantic_role,
      paths: entity.path_count || 0,
      lifecycle: entity.lifecycle,
    })),
    related_workflows: relatedWorkflows.map(workflow => ({
      name: workflow.name,
      role: workflow.semantic_role,
      evidence_quality: workflow.evidence_quality,
      deployables: workflow.deployable_ids.map(id => appById.get(id) ? workspacePromptApplicationName(graph, appById.get(id)!) : workspacePromptApplicationLabel(graph, id)).slice(0, 4),
    })),
    distribution_units: graph.distribution_units
      .filter(unit => unit.component_deployable_ids.some(id => deployables.includes(
        appById.get(id) ? workspacePromptApplicationName(graph, appById.get(id)!) : workspacePromptApplicationLabel(graph, id)
      )))
      .map(unit => unit.name)
      .slice(0, 3),
  };
}

function workspaceCapabilityPromptContext(
  capability: WorkspaceCapability,
  graph: WorkspaceAnalysisGraph,
  appById: Map<string, SystemApplication>,
): Record<string, unknown> {
  const deployables = capability.deployable_ids
    .map(id => appById.get(id) ? workspacePromptApplicationName(graph, appById.get(id)!) : workspacePromptApplicationLabel(graph, id))
    .slice(0, 4);
  const workflows = graph.workspace_workflows
    .filter(workflow =>
      workflow.deployable_ids.some(id => capability.deployable_ids.includes(id)) ||
      workflow.project_ids.some(projectId => capability.project_ids.includes(projectId)) ||
      normalizeAiItemName(workflow.name).includes(normalizeAiItemName(capability.name).split(' ')[0] || '')
    )
    .map(workflow => workflow.name)
    .slice(0, 5);
  const entities = graph.workspace_entities
    .filter(entity =>
      entity.project_ids.some(projectId => capability.project_ids.includes(projectId)) ||
      entity.evidence.some(evidence => capability.evidence.includes(evidence))
    )
    .map(entity => entity.name)
    .slice(0, 6);
  return {
    name: capability.name,
    role: capability.semantic_role,
    criticality: capability.criticality,
    terminal_score: capability.terminal_score,
    target_words: meaningfulWorkspaceNameTokens(capability.name),
    evidence: workspacePromptEvidence(graph, capability.evidence, 4),
    terminal_evidence: workspacePromptEvidence(graph, capability.terminal_evidence || [], 3),
    deployables,
    workflows,
    entities,
    distribution_units: graph.distribution_units
      .filter(unit => unit.component_deployable_ids.some(id => capability.deployable_ids.includes(id)))
      .map(unit => unit.name)
      .slice(0, 3),
  };
}

function workspacePromptRelevantDeployableNames(
  graph: WorkspaceAnalysisGraph,
  projectIds: string[],
  targetName: string,
  evidence: string[],
  terminalEvidence: string[],
  limit: number,
): string[] {
  const targetTerms = meaningfulWorkspaceNameTokens(targetName);
  const evidenceText = normalizeAiItemName([...evidence, ...terminalEvidence].join(' '));
  const connectedIds = new Set(graph.application_links.flatMap(link => [link.source_application_id, link.target_application_id]));
  return graph.applications
    .filter(app => projectIds.includes(app.codebase_id) && isPromptUsefulDeployableName(app))
    .map(app => {
      const appText = normalizeAiItemName(`${app.name} ${app.kind} ${app.path_hint || ''}`);
      const nameMentioned = Boolean(app.name && evidenceText.includes(normalizeAiItemName(app.name)));
      const idMentioned = Boolean(app.id && evidenceText.includes(normalizeAiItemName(app.id)));
      const targetScore = targetTerms.length ? scoreTextForTerms(appText, targetTerms) : 0;
      const connectedScore = connectedIds.has(app.id) ? 8 : 0;
      const deployableScore = (app.deployable || isDeployableApplication(app.name, app.path_hint, [], graph.codebases.find(codebase => codebase.id === app.codebase_id)?.system_type)) ? 6 : 0;
      const evidenceScore = (nameMentioned ? 20 : 0) + (idMentioned ? 12 : 0) + targetScore * 10 + connectedScore + deployableScore;
      return { app, evidenceScore, rank: workspaceOverviewApplicationRank(app, graph.codebases.find(codebase => codebase.id === app.codebase_id), connectedIds) };
    })
    .filter(item => item.evidenceScore >= 12 || (targetTerms.length > 0 && item.evidenceScore >= 10))
    .sort((left, right) => right.evidenceScore - left.evidenceScore || right.rank - left.rank || left.app.name.localeCompare(right.app.name))
    .map(item => workspacePromptApplicationName(graph, item.app))
    .filter((name, index, names) => names.indexOf(name) === index)
    .slice(0, limit);
}

function isPromptUsefulDeployableName(app: SystemApplication): boolean {
  const normalized = normalizeAiItemName(app.name);
  if (!normalized) return false;
  if (/^(domain|domains|infra|infrastructure|lib|library|libraries|core|shared|common|types|utils|model|models|entity|entities|repository|repositories)$/.test(normalized)) return false;
  if (isExternalRuntimeDependency(app.name, app.kind)) return false;
  return true;
}

interface ParsedWorkspaceNarrative {
  description?: string;
  product_value_summary?: string;
  domains?: string[];
  key_capabilities?: string[];
  value_drivers?: string[];
  relationship_summary?: string[];
  domain_items?: Array<{ name: string; description?: string }>;
  capability_items?: Array<{ name: string; description?: string }>;
  workflow_items?: Array<{ name: string; description?: string }>;
  entity_items?: Array<{ name: string; description?: string }>;
}

function parseWorkspaceNarrativeJson(raw: string): ParsedWorkspaceNarrative {
  const text = String(raw || '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  const jsonText = text.match(/\{[\s\S]*\}/)?.[0] || text;
  let parsed: any;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return parseMalformedWorkspaceNarrative(text);
  }
  const domainItems = cleanNarrativeItems(parsed.domains)
    .concat(cleanNarrativeItems(parsed.domain_items))
    .concat(cleanNarrativeItems(parsed.workspace_domains));
  const capabilityItems = cleanNarrativeItems(parsed.key_capabilities)
    .concat(cleanNarrativeItems(parsed.capabilities))
    .concat(cleanNarrativeItems(parsed.primary_capabilities))
    .concat(cleanNarrativeItems(parsed.capability_items))
    .concat(cleanNarrativeItems(parsed.workspace_capabilities));
  const workflowItems = cleanNarrativeItems(parsed.workflows)
    .concat(cleanNarrativeItems(parsed.workflow_items))
    .concat(cleanNarrativeItems(parsed.workspace_workflows));
  const entityItems = cleanNarrativeItems(parsed.entities)
    .concat(cleanNarrativeItems(parsed.entity_items))
    .concat(cleanNarrativeItems(parsed.workspace_entities));
  return {
    description: cleanNarrativeString(parsed.description),
    product_value_summary: cleanNarrativeSummaryString(parsed.product_value_summary),
    domains: domainItems.length ? domainItems.map(item => item.name) : cleanNarrativeArray(parsed.domains),
    key_capabilities: capabilityItems.length ? capabilityItems.map(item => item.name) : cleanNarrativeArray(parsed.key_capabilities),
    value_drivers: cleanNarrativeArray(parsed.value_drivers),
    relationship_summary: cleanNarrativeArray(parsed.relationship_summary),
    domain_items: domainItems,
    capability_items: capabilityItems,
    workflow_items: workflowItems,
    entity_items: entityItems,
  };
}

function parseMalformedWorkspaceNarrative(text: string): ParsedWorkspaceNarrative {
  const description = extractJsonLikeStringField(text, 'description');
  const productValueSummary = extractJsonLikeStringField(text, 'product_value_summary');
  return {
    description: cleanNarrativeString(description),
    product_value_summary: cleanNarrativeSummaryString(productValueSummary),
    domains: undefined,
    key_capabilities: undefined,
    value_drivers: undefined,
    relationship_summary: undefined,
    domain_items: extractJsonLikeNarrativeItems(text, ['domain_items', 'domains', 'workspace_domains']),
    capability_items: extractJsonLikeNarrativeItems(text, ['capability_items', 'key_capabilities', 'capabilities', 'workspace_capabilities']),
    workflow_items: extractJsonLikeNarrativeItems(text, ['workflow_items', 'workflows', 'workspace_workflows']),
    entity_items: extractJsonLikeNarrativeItems(text, ['entity_items', 'entities', 'workspace_entities']),
  };
}

function extractJsonLikeStringField(text: string, field: string): string | undefined {
  const pattern = new RegExp(`"${escapeRegExp(field)}"\\s*:\\s*"((?:\\\\.|[^"\\\\]){20,2000})"`, 'i');
  const match = text.match(pattern);
  return match?.[1]?.replace(/\\"/g, '"').replace(/\\\\n/g, ' ').replace(/\s+/g, ' ').trim();
}

function extractJsonLikeNarrativeItems(text: string, fields: string[]): Array<{ name: string; description?: string }> {
  const items: Array<{ name: string; description?: string }> = [];
  for (const field of fields) {
    const start = text.search(new RegExp(`"${escapeRegExp(field)}"\\s*:\\s*\\[`, 'i'));
    if (start < 0) continue;
    const slice = text.slice(start);
    const arrayStart = slice.indexOf('[');
    const section = extractJsonLikeArraySection(slice, arrayStart);
    const objectPattern = /\{[^{}]*"name"\s*:\s*"([^"]{3,160})"[^{}]*"description"\s*:\s*"((?:\\.|[^"\\]){35,600})"[^{}]*\}/gi;
    for (const match of section.matchAll(objectPattern)) {
      const name = match[1]?.replace(/\\"/g, '"').replace(/\s+/g, ' ').trim();
      const description = normalizeWorkspaceAiDescriptionText(match[2]?.replace(/\\"/g, '"').replace(/\\n/g, ' '));
      if (name) items.push({ name, description: description && description.length >= 40 ? description : undefined });
    }
  }
  const byName = new Map<string, { name: string; description?: string }>();
  for (const item of items) byName.set(item.name.toLowerCase(), item);
  return [...byName.values()];
}

function extractJsonLikeArraySection(text: string, start: number): string {
  if (start < 0) return text;
  let depth = 0;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (char === '[') depth += 1;
    if (char === ']') {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  const nextTopLevelField = text.slice(start + 1).search(/,\s*"\w+"\s*:/);
  return nextTopLevelField > 0 ? text.slice(start, start + 1 + nextTopLevelField) : text.slice(start);
}

const PRESERVED_TECH_COMPOUNDS = new Set([
  'typescript', 'javascript', 'coffeescript', 'actionscript', 'postgresql',
  'graphql', 'nosql', 'mysql', 'mssql', 'sqlite', 'dynamodb', 'mongodb',
  'github', 'gitlab', 'bitbucket', 'devops', 'webassembly', 'openapi',
  'graphviz', 'nodejs', 'openai', 'chatgpt', 'websocket', 'websockets',
]);

function splitCamelCaseProseToken(token: string): string {
  if (PRESERVED_TECH_COMPOUNDS.has(token.toLowerCase())) return token;
  if (/^[a-z][A-Z]/.test(token)) return token;
  return token
    .replace(/([a-z0-9])([A-Z][a-z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
}

function cleanNarrativeString(value: unknown): string | undefined {
  const text = normalizeWorkspaceAiDescriptionText(value);
  return text.length >= 80 ? text : undefined;
}

function cleanNarrativeSummaryString(value: unknown): string | undefined {
  const text = normalizeWorkspaceAiDescriptionText(value);
  return text.length >= 20 ? text : undefined;
}

export function normalizeWorkspaceAiDescriptionText(value: unknown): string {
  return String(value || '')
    .replace(/\b[A-Za-z][A-Za-z0-9]*\b/g, token => splitCamelCaseProseToken(token))
    .replace(/\b([a-zA-Z]+)-([a-zA-Z]+)\b/g, '$1 $2')
    .replace(/\bRES Tful\b/g, 'RESTful')
    .replace(/\bAP Is\b/g, 'APIs')
    .replace(/\bSD Ks\b/g, 'SDKs')
    .replace(/\bID Es\b/g, 'IDEs')
    .replace(/\bU Is\b/g, 'UIs')

    .replace(/\bType Script\b/g, 'TypeScript')
    .replace(/\bJava Script\b/g, 'JavaScript')
    .replace(/\bPostgre SQL\b/g, 'PostgreSQL')
    .replace(/\bGraph QL\b/g, 'GraphQL')
    .replace(/\bproof and unravelling\b/gi, 'analysis evidence')
    .replace(/\bproof mechanisms?\b/gi, 'analysis mechanisms')
    .replace(/\bunravelling\b/gi, 'analysis')
    .replace(/\bunravl\b/gi, 'Klauro')
    .replace(/\busing Klauro and analysis mechanisms\b/gi, 'through organization, workspace, and access-control records')
    .replace(/\bvia Klauro and analysis mechanisms\b/gi, 'through organization, workspace, and access-control records')
    .replace(/\banalysisrun\b/gi, 'AnalysisRun')
    .replace(/\banalysisresult\b/gi, 'AnalysisResult')
    .replace(/\btelemetrysnapshot\b/gi, 'TelemetrySnapshot')
    .replace(/\btelemetrydata\b/gi, 'TelemetryData')
    .replace(/\bAnalysis Run\b/g, 'AnalysisRun')
    .replace(/\bAnalysis Result\b/g, 'AnalysisResult')
    .replace(/\bTelemetry Snapshot\b/g, 'TelemetrySnapshot')
    .replace(/\bTelemetry Data\b/g, 'TelemetryData')
    .replace(/\bfrom 20\d{2}\b/gi, '')
    .replace(/\bPostgre SQL\b/g, 'PostgreSQL')
    .replace(/\bmachine to-machine\b/gi, 'machine-to-machine')
    .replace(/\bmachine to machine\b/gi, 'machine-to-machine')
    .replace(/\bself hosted\b/gi, 'self-hosted')
    .replace(/\badmin ui\b/gi, 'admin UI')
    .replace(/\buser ui\b/gi, 'user UI')
    .replace(/\bclient ui\b/gi, 'client UI')
    .replace(/\bui\b/g, 'UI')
    .replace(/\bmcp server\b/gi, 'MCP server')
    .replace(/\banalyzer core\b/gi, 'analyzer core')
    .replace(/\bpython\b/g, 'Python')
    .replace(/\brepo level\b/gi, 'repo-level')
    .replace(/\bagent context\b/gi, 'work-context')
    .replace(/\bMCPs?\b/gi, match => match.toLowerCase().endsWith('s') ? 'MCPs' : 'MCP')
    .replace(/\bSDKs?\b/gi, match => match.toLowerCase().endsWith('s') ? 'SDKs' : 'SDK')
    .replace(/\bAPIs?\b/gi, match => match.toLowerCase().endsWith('s') ? 'APIs' : 'API')
    .replace(/\bCAS\b/gi, 'CAS')
    .replace(/\s+\./g, '.')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanNarrativeArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.map(item => String(item || '').replace(/\s+/g, ' ').trim()).filter(item => item.length >= 3);
  return items.length ? [...new Set(items)] : undefined;
}

function cleanNarrativeItems(value: unknown): Array<{ name: string; description?: string }> {
  if (!Array.isArray(value)) return [];
  const items: Array<{ name: string; description?: string }> = [];
  for (const item of value) {
    if (typeof item === 'string') {
      const name = item.replace(/\s+/g, ' ').trim();
      if (name.length >= 3) items.push({ name });
      continue;
    }
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const name = String(record.name || record.title || record.capability || record.domain || '').replace(/\s+/g, ' ').trim();
    const description = normalizeWorkspaceAiDescriptionText(record.description || record.summary || record.text || record.value || record.explanation || record.details || '');
    if (name.length >= 3) items.push({
      name,
      description: description.length >= 40 ? description : undefined,
    });
  }
  const byName = new Map<string, { name: string; description?: string }>();
  for (const item of items) byName.set(item.name.toLowerCase(), item);
  return [...byName.values()];
}

export function summarizeWorkspaceAnalysis(graph: WorkspaceAnalysisGraph) {
  return summarizeCrossCodebaseSystemGraph(graph);
}

export function summarizeCrossCodebaseSystemGraph(graph: CrossCodebaseSystemGraph) {
  return {
    id: graph.id,
    name: graph.name,
    cas_version: graph.cas_version,
    composition_mode: graph.composition_mode,
    generated_at: graph.generated_at,
    composition_kind: graph.composition?.kind,
    recommended_primary_view: graph.composition?.recommended_primary_view,
    codebase_count: graph.codebase_count,
    application_count: graph.applications?.length || 0,
    interface_count: graph.interfaces.length,
    link_count: graph.links.length,
    application_link_count: graph.application_links.length,
    isolated_deployable_count: graph.detail_views?.overview?.isolated_deployables?.length || 0,
    data_flow_path_count: graph.data_flow_paths.length,
    unmatched_interface_count: graph.unmatched_interfaces.length,
    quality_flags: graph.quality_flags || [],
    summary: graph.summary,
  };
}

export function selectWorkspaceAnalysisDetail(graph: WorkspaceAnalysisGraph, level: WorkspaceDetailLevel = 'overview') {
  if (level === 'full') return graph;
  if (level === 'evidence') return {
    summary: summarizeWorkspaceAnalysis(graph),
    ...graph.detail_views.evidence,
  };
  if (level === 'connections') return {
    summary: summarizeWorkspaceAnalysis(graph),
    ...graph.detail_views.connections,
  };
  const overview = graph.detail_views.overview;
  return {
    summary: compactWorkspaceSummary(graph),
    level: overview.level,
    composition: overview.composition,
    description: truncateText(overview.description, 420),
    product_value_summary: truncateText(graph.workspace_narrative.product_value_summary, 180),
    quality_flags: (graph.quality_flags || []).slice(0, 2).map(compactWorkspaceQualityFlag),
    projects: overview.projects.slice(0, 6).map(compactWorkspaceProject),
    health: overview.health,
    activity: compactActivitySummary(overview.activity),
    telemetry: compactTelemetrySummary(overview.telemetry),
    risk_areas: overview.risk_areas.slice(0, 1).map(compactWorkspaceRisk),
    capabilities: overview.capabilities.slice(0, 2).map(compactWorkspaceCapability),
    workflows: overview.workflows.slice(0, 1).map(compactWorkspaceWorkflow),
    entities: overview.entities.slice(0, 1).map(compactWorkspaceEntity),
    environments: overview.environments.slice(0, 5).map(compactWorkspaceEnvironment),
    infrastructure_overlay: compactWorkspaceInfrastructureOverlay(overview.infrastructure_overlay),
    deployables: overview.deployables.slice(0, 5).map(compactWorkspaceDeployable),
    distribution_units: overview.distribution_units.slice(0, 3).map(compactWorkspaceDistributionUnit),
    connections: overview.connections.slice(0, 1).map(compactWorkspaceConnection),
    trusted_connections: overview.trusted_connections.slice(0, 2).map(compactWorkspaceConnection),
    source_backed_connections: overview.source_backed_connections.slice(0, 2).map(compactWorkspaceConnection),
    candidate_connections: overview.candidate_connections.slice(0, 2).map(compactWorkspaceConnection),
    external_dependencies: overview.external_dependencies.slice(0, 4).map(compactExternalDependency),
    isolated_deployables: overview.isolated_deployables.slice(0, 3).map(compactIsolatedDeployable),
  };
}

export function buildWorkspaceAgentContext(
  graph: WorkspaceAnalysisGraph,
  options: WorkspaceAgentContextOptions = {},
): WorkspaceAgentContext {
  const taskType = options.task_type || 'cross-repo';
  const maxApps = Math.min(5, clampPositiveInteger(options.max_apps, 4));
  const maxConnections = Math.min(3, clampPositiveInteger(options.max_connections, 3));
  const maxExternalDependencies = Math.min(4, clampPositiveInteger(options.max_external_dependencies, 4));
  const taskText = `${options.target || ''} ${options.instructions || ''}`.trim();
  const terms = tokenizeTaskText(taskText);
  const overview = graph.detail_views.overview;
  const appById = new Map(graph.applications.map(app => [app.id, app]));
  const codebaseById = new Map(graph.codebases.map(codebase => [codebase.id, codebase]));
  const visibleApps = graph.deployables.length
    ? graph.deployables
    : graph.applications.filter(app => shouldExposeInWorkspaceOverview(app, graph.applications));
  const linkByApp = new Map<string, SystemApplicationLink[]>();
  for (const link of graph.application_links) {
    linkByApp.set(link.source_application_id, [...(linkByApp.get(link.source_application_id) || []), link]);
    linkByApp.set(link.target_application_id, [...(linkByApp.get(link.target_application_id) || []), link]);
  }
  const appScores = visibleApps.map(app => {
    const project = codebaseById.get(app.codebase_id);
    const relatedLinks = linkByApp.get(app.id) || [];
    const haystack = [
      app.name,
      app.kind,
      app.path_hint,
      project?.name,
      project?.system_type,
      ...(project?.languages || []),
      ...(project?.frameworks || []),
      ...relatedLinks.flatMap(link => link.evidence),
    ].join(' ');
    const directScore = scoreTextForTerms(haystack, terms);
    const topologyScore = relatedLinks.length > 0 ? 1 : 0;
    const insightScore = graph.system_insights.some(insight => insight.application_ids.includes(app.id)) ? 1 : 0;
    return {
      app,
      score: directScore + topologyScore + insightScore,
      reasons: selectedAppReasons(app, project, directScore, topologyScore, insightScore),
    };
  });
  const seedApps = appScores
    .filter(item => terms.length === 0 ? item.score > 0 : item.score > 0)
    .sort((left, right) => right.score - left.score || left.app.name.localeCompare(right.app.name))
    .slice(0, Math.max(4, Math.ceil(maxApps / 2)));
  const selectedIds = new Set(seedApps.map(item => item.app.id));
  for (const item of seedApps) {
    for (const link of linkByApp.get(item.app.id) || []) {
      selectedIds.add(link.source_application_id);
      selectedIds.add(link.target_application_id);
      if (selectedIds.size >= maxApps) break;
    }
    if (selectedIds.size >= maxApps) break;
  }
  if (selectedIds.size === 0) {
    for (const app of visibleApps.slice(0, maxApps)) selectedIds.add(app.id);
  }
  const reasonsByAppId = new Map(seedApps.map(item => [item.app.id, item.reasons]));
  const selectedApps = visibleApps
    .filter(app => selectedIds.has(app.id))
    .slice(0, maxApps)
    .map(app => compactWorkspaceContextSurface(
      app,
      codebaseById.get(app.codebase_id),
      graph,
      (reasonsByAppId.get(app.id) || ['Connected to a selected workspace deployable.']).slice(0, 1),
    ));
  const selectedAppIds = new Set(selectedApps.map(app => app.id));
  const relatedConnections = graph.application_links
    .filter(link => selectedAppIds.has(link.source_application_id) || selectedAppIds.has(link.target_application_id))
    .sort(compareWorkspaceLinksByTrust);
  const selectedConnections = relatedConnections
    .filter(link => link.evidence_quality === 'source-backed')
    .slice(0, maxConnections)
    .map(link => ({
      source: appById.get(link.source_application_id)?.name || link.source_application_id,
      source_id: link.source_application_id,
      source_project_id: link.source_codebase_id,
      target: appById.get(link.target_application_id)?.name || link.target_application_id,
      target_id: link.target_application_id,
      target_project_id: link.target_codebase_id,
      kind: link.kind,
      mode: link.mode,
      runtime_behavior: workspaceLinkRuntimeBehavior(link),
      connection_nature: workspaceLinkConnectionNature(link),
      inferred_reason: workspaceLinkInferredReason(link),
      confidence: link.confidence,
      evidence_quality: link.evidence_quality,
      trust_guidance: compactWorkspaceLinkTrustGuidance(link.evidence_quality),
      link_id: link.id,
      source_interface_id: link.source_interface_id,
      target_interface_id: link.target_interface_id,
    }));
  const candidateConnections = relatedConnections
    .filter(link => link.evidence_quality !== 'source-backed')
    .slice(0, Math.max(1, Math.ceil(maxConnections / 2)))
    .map(link => ({
      source: appById.get(link.source_application_id)?.name || link.source_application_id,
      source_id: link.source_application_id,
      source_project_id: link.source_codebase_id,
      target: appById.get(link.target_application_id)?.name || link.target_application_id,
      target_id: link.target_application_id,
      target_project_id: link.target_codebase_id,
      kind: link.kind,
      mode: link.mode,
      runtime_behavior: workspaceLinkRuntimeBehavior(link),
      connection_nature: workspaceLinkConnectionNature(link),
      inferred_reason: workspaceLinkInferredReason(link),
      confidence: link.confidence,
      evidence_quality: link.evidence_quality,
      trust_guidance: compactWorkspaceLinkTrustGuidance(link.evidence_quality),
      link_id: link.id,
      source_interface_id: link.source_interface_id,
      target_interface_id: link.target_interface_id,
    }));
  const linkedSupportingSurfaceIds = new Set<string>();
  for (const connection of [...selectedConnections, ...candidateConnections]) {
    if (!selectedAppIds.has(connection.source_id)) linkedSupportingSurfaceIds.add(connection.source_id);
    if (!selectedAppIds.has(connection.target_id)) linkedSupportingSurfaceIds.add(connection.target_id);
  }
  const linkedSupportingSurfaces = [...linkedSupportingSurfaceIds]
    .map(id => appById.get(id))
    .filter((app): app is SystemApplication => Boolean(app))
    .slice(0, 4)
    .map(app => compactWorkspaceContextSurface(
      app,
      codebaseById.get(app.codebase_id),
      graph,
      ['Linked by selected connection but not part of selected deployable set.'],
    ));
  const selectedEntityBundle = selectWorkspaceEntitiesForContext(graph, terms, selectedAppIds, 2, 1);
  const selectedDistributionUnits = graph.distribution_units
    .filter(unit => unit.component_deployable_ids.some(id => selectedAppIds.has(id)) || terms.some(term => scoreTextForTerms(`${unit.name} ${unit.component_names.join(' ')} ${unit.artifact_paths.join(' ')}`, [term]) > 0))
    .slice(0, 4);
  const externalDependencies = overview.external_dependencies
    .filter(dependency => {
      if (terms.length === 0) return dependency.usage !== 'declared';
      return scoreTextForTerms(`${dependency.name} ${dependency.kind} ${dependency.project} ${dependency.usage}`, terms) > 0 || dependency.usage === 'source-backed';
    })
    .sort((left, right) => usageRank(right.usage) - usageRank(left.usage) || left.name.localeCompare(right.name))
    .slice(0, maxExternalDependencies);
  const isolated = overview.isolated_deployables
    .filter(item => terms.length === 0 || scoreTextForTerms(`${item.name} ${item.project} ${item.reason}`, terms) > 0)
    .slice(0, 2);
  const warnings = [
    ...(graph.quality_flags || [])
      .filter(flag => flag.severity !== 'info' || flag.code === 'prototype-or-demo-projects-present')
      .sort((left, right) => Number(right.code === 'prototype-or-demo-projects-present') - Number(left.code === 'prototype-or-demo-projects-present'))
      .map(flag => `${flag.code}: ${conciseText(flag.message, 150)}`),
    ...(graph.workspace_narrative.source !== 'ai' ? [`Workspace narrative is ${graph.workspace_narrative.source}; default workspace enrichment requires AI and this artifact should be refreshed with AI enabled before customer-facing use.`] : []),
    ...graph.system_insights
      .filter(insight => insight.type === 'declared-unused-infrastructure')
      .map(insight => insight.title)
      .slice(0, 6),
    ...(graph.unmatched_interfaces.length > 0 ? [`${graph.unmatched_interfaces.length} unmatched workspace interface(s) need deeper evidence before assuming no link exists.`] : []),
  ];
  const contextWithoutBudget = {
    product: 'workspace_agent_context' as const,
    analysis_id: graph.id,
    workspace: {
      name: graph.name,
      cas_version: graph.cas_version,
      generated_at: graph.generated_at,
      project_count: graph.codebase_count,
      deployable_count: graph.deployables.length,
      composition_kind: graph.composition?.kind,
      recommended_primary_view: graph.composition?.recommended_primary_view,
    },
    task: {
      task_type: taskType,
      target: options.target,
      instructions: options.instructions,
      max_apps: maxApps,
      max_connections: maxConnections,
      max_external_dependencies: maxExternalDependencies,
    },
    system_summary: {
      product_value_summary: graph.workspace_narrative.product_value_summary,
	      description: truncateText(graph.workspace_narrative.description, 180) || graph.workspace_narrative.description,
      domains: graph.workspace_narrative.domains.slice(0, 5),
      key_capabilities: graph.workspace_narrative.key_capabilities.slice(0, 4),
	      relationship_summary: compactAgentRelationshipSummary(selectedConnections, candidateConnections),
	      composition_reasons: (graph.composition?.reasons || []).slice(0, 2).map(reason => truncateText(reason, 72)).filter((reason): reason is string => Boolean(reason)),
      quality_flags: (graph.quality_flags || []).slice(0, 1).map(compactWorkspaceQualityFlag),
    },
    selected_surfaces: selectedApps.map(({ project_path: _projectPath, ...app }) => app),
    linked_supporting_surfaces: linkedSupportingSurfaces.map(({ project_path: _projectPath, ...app }) => app),
    source_backed_connections: selectedConnections,
    candidate_connections: candidateConnections,
    selected_distribution_units: selectedDistributionUnits.map(compactWorkspaceDistributionUnit),
    external_dependencies: externalDependencies.map(compactExternalDependency),
    isolated_deployables: isolated.map(compactIsolatedDeployable),
    risk_areas: graph.risk_areas.slice(0, 1).map(compactWorkspaceRisk),
    capabilities: graph.workspace_capabilities.slice(0, 1).map(compactWorkspaceCapability),
    workflows: graph.workspace_workflows.slice(0, 1).map(compactWorkspaceWorkflow),
    entities: selectedEntityBundle.entities.map(compactWorkspaceEntity),
    entity_paths: selectedEntityBundle.paths.map(compactWorkspaceEntityPath),
    health: graph.health,
    activity: compactActivitySummary(graph.activity),
    telemetry: compactTelemetrySummary(graph.telemetry),
    agent_guidance: {
	    read_order: selectedApps.map(app => `${stripLocalPathPrefix(app.project_path)} (${app.project}:${app.name})`).slice(0, 2),
      agent_should_read_next: workspaceAgentReadNext(graph, selectedApps, selectedConnections, candidateConnections, options).slice(0, 3),
	      validation: [
        'Use get_workspace_analysis detail_level=evidence before cross-repo contract, infra, auth, messaging, or deploy changes.',
        'Use repo-level get_agent_context before source edits.',
        'Preserve distribution units; topology-only links are not source-confirmed until repo CAS confirms them.',
      ],
      warnings: warnings.slice(0, 2).map(warning => conciseText(warning, 260)).filter((warning): warning is string => Boolean(warning)),
	      next_mcp_calls: compactWorkspaceNextMcpCalls([
	        { tool: 'get_workspace_analysis', when: 'Need full interfaces, runtime topology, unmatched interfaces, or evidence refs.', args: { analysis_id_or_name: graph.id, detail_level: 'evidence' } },
	        { tool: 'get_workspace_entity_map', when: 'Need entity lineage, readers/writers, or cross-project entity paths.', args: { analysis_id_or_name: graph.id, target: options.target || graph.name, limit: 12 } },
	        ...selectedApps.slice(0, 1).map(app => ({ tool: 'get_agent_context', when: `Before editing ${app.project}:${app.name}.`, args: { path: app.project_path, workspace_analysis_id: graph.id, task: { task_type: taskType, target: options.target || app.name } } })),
	      ]),
	    },
	  };
  const fullTokens = estimatedJsonTokens(graph);
  const contextTokens = estimatedJsonTokens(contextWithoutBudget);
  return {
    ...contextWithoutBudget,
    context_budget: {
      estimated_full_was_tokens: fullTokens,
      estimated_context_tokens: contextTokens,
      estimated_token_reduction_percentage: Math.max(0, Math.round((1 - contextTokens / Math.max(fullTokens, 1)) * 100)),
      signal_quality: workspaceSignalQuality(graph),
      signal_reasons: workspaceSignalReasons(graph).slice(0, 5),
    },
  };
}

function selectWorkspaceEntitiesForContext(
  graph: WorkspaceAnalysisGraph,
  terms: string[],
  selectedAppIds: Set<string>,
  entityLimit: number,
  pathLimit: number,
): { entities: WorkspaceEntity[]; paths: WorkspaceEntityPath[] } {
  const selectedProjectIds = new Set(
    graph.applications
      .filter(app => selectedAppIds.has(app.id))
      .map(app => app.codebase_id)
  );
  const scoreEntity = (entity: WorkspaceEntity): number => {
    const haystack = [
      entity.name,
      entity.description,
      ...entity.project_ids,
      ...entity.related_capability_ids,
      ...entity.related_workflow_ids,
      ...entity.evidence,
    ].join(' ');
    let score = scoreTextForTerms(haystack, terms) * 8;
    score += Math.min(16, (entity.path_count || 0) * 1.5);
    score += Math.min(10, entity.related_workflow_ids.length * 2);
    score += Math.min(8, entity.related_capability_ids.length * 1.5);
    score += Math.min(8, entity.entity_refs.length * 2);
    if (entity.project_ids.some(projectId => selectedProjectIds.has(projectId))) score += 12;
    if (entity.sensitive_fields?.length) score += 4;
    return score;
  };
  const entities = [...graph.workspace_entities]
    .sort((left, right) => scoreEntity(right) - scoreEntity(left) || left.name.localeCompare(right.name))
    .slice(0, entityLimit);
  const entityNames = new Set(entities.map(entity => entity.name.toLowerCase()));
  const entityScores = new Map(entities.map(entity => [entity.name, scoreEntity(entity)]));
  const paths = graph.workspace_entity_paths
    .filter(path => entityNames.has(path.entity_name.toLowerCase()))
    .sort((left, right) => {
      return (entityScores.get(right.entity_name) || 0) - (entityScores.get(left.entity_name) || 0) ||
        left.entity_name.localeCompare(right.entity_name);
    })
    .slice(0, pathLimit);
  return { entities, paths };
}

function compactWorkspaceSummary(graph: WorkspaceAnalysisGraph): Record<string, unknown> {
  const summary = summarizeWorkspaceAnalysis(graph);
  return {
    id: summary.id,
    name: summary.name,
    cas_version: summary.cas_version,
    composition_mode: summary.composition_mode,
    generated_at: summary.generated_at,
    composition_kind: summary.composition_kind,
    recommended_primary_view: summary.recommended_primary_view,
    codebase_count: summary.codebase_count,
    application_count: summary.application_count,
    interface_count: summary.interface_count,
    link_count: summary.link_count,
    application_link_count: summary.application_link_count,
    isolated_deployable_count: summary.isolated_deployable_count,
    data_flow_path_count: summary.data_flow_path_count,
    unmatched_interface_count: summary.unmatched_interface_count,
    quality_flag_count: (graph.quality_flags || []).length,
    quality_warn_count: (graph.quality_flags || []).filter(flag => flag.severity === 'warn').length,
    quality_fail_count: (graph.quality_flags || []).filter(flag => flag.severity === 'fail').length,
    distribution_unit_count: graph.distribution_units.length,
    health: graph.health.status,
  };
}

function compactWorkspaceQualityFlag(flag: WorkspaceQualityFlag): Record<string, unknown> {
  return pickDefined({
    severity: flag.severity,
    code: flag.code,
    message: truncateText(flag.message, 120),
    evidence: compactStringArray(flag.evidence, 2, 70),
  });
}

function compactWorkspaceOwnership(ownership: WorkspaceOwnership | undefined): Record<string, unknown> | undefined {
  if (!ownership) return undefined;
  return pickDefined({
    owner_source: ownership.owner_source,
    owners: ownership.owners?.slice(0, 2),
    team: ownership.team,
    product_area: ownership.product_area,
    lifecycle: ownership.lifecycle,
    tier: ownership.tier,
  });
}

function compactWorkspaceProject(project: any): Record<string, unknown> {
  return pickDefined({
    id: project.id,
    name: project.name,
    path: project.path,
    project_role: project.project_role,
    system_type: project.system_type,
    languages: Array.isArray(project.languages) ? project.languages.slice(0, 4) : undefined,
    frameworks: Array.isArray(project.frameworks) ? project.frameworks.slice(0, 4) : undefined,
    deployable_count: project.deployable_count,
    interface_count: project.interface_count,
  });
}

function compactWorkspaceDeployable(app: any): Record<string, unknown> {
  return pickDefined({
    id: app.id,
    name: app.name,
    project: app.project,
    project_id: app.project_id,
    project_role: app.project_role,
    ownership: app.ownership,
    kind: app.kind,
    surface_kind: app.surface_kind || app.kind,
    deployable: app.deployable,
    description: truncateText(app.description, 90),
    isolated: app.isolated,
    confidence: app.confidence,
    ports: app.ports,
    evidence: (app.evidence || []).slice(0, 1),
    trust_guidance: app.trust_guidance,
  });
}

function compactWorkspaceDistributionUnit(unit: any): Record<string, unknown> {
  return pickDefined({
    id: unit.id,
    project: unit.project,
    project_id: unit.project_id,
    name: unit.name,
    kind: unit.kind,
    platforms: unit.platforms,
    component_names: unit.component_names?.slice?.(0, 4),
    component_deployable_ids: unit.component_deployable_ids?.slice?.(0, 4),
    artifact_paths: (unit.artifact_paths || []).slice(0, 1),
    confidence: unit.confidence,
    evidence: (unit.evidence || []).slice(0, 1).map((item: any) => pickDefined({
      source: item.source,
      file: item.file,
      line: item.line,
      claim: truncateText(item.claim, 100),
      confidence: item.confidence,
    })),
    agent_guidance: truncateText(unit.agent_guidance, 90),
  });
}

function compactWorkspaceConnection(connection: any): Record<string, unknown> {
  return pickDefined({
    link_id: connection.link_id,
    source: connection.source,
    source_id: connection.source_id,
    target: connection.target,
    target_id: connection.target_id,
    kind: connection.kind,
    mode: connection.mode,
    runtime_behavior: connection.runtime_behavior,
    connection_nature: connection.connection_nature,
    inferred_reason: connection.inferred_reason,
    confidence: connection.confidence,
    evidence_quality: connection.evidence_quality,
    trust_guidance: connection.trust_guidance || (connection.evidence_quality ? compactWorkspaceLinkTrustGuidance(connection.evidence_quality) : undefined),
  });
}

function compactAgentRelationshipSummary(
  sourceBackedConnections: Array<Record<string, unknown>>,
  candidateConnections: Array<Record<string, unknown>>,
): string[] {
  const sourceBacked = sourceBackedConnections.slice(0, 2).map(connection => {
    const source = String(connection.source || 'unknown');
    const target = String(connection.target || 'unknown');
    const kind = String(connection.kind || 'link');
    const runtime = String(connection.runtime_behavior || 'unknown');
    const nature = String(connection.connection_nature || 'relationship');
    return truncateText(`source-backed: ${source} -> ${target} ${kind}/${runtime}/${nature}`, 110);
  }).filter((item): item is string => Boolean(item));
  const candidates = candidateConnections.slice(0, 2).map(connection => {
    const source = String(connection.source || 'unknown');
    const target = String(connection.target || 'unknown');
    const quality = String(connection.evidence_quality || 'candidate');
    const reason = truncateText(String(connection.inferred_reason || connection.trust_guidance || 'verify before relying on this relationship'), 70);
    return truncateText(`candidate: ${source} -> ${target} ${quality}; ${reason}`, 120);
  }).filter((item): item is string => Boolean(item));
  return [...sourceBacked, ...candidates].slice(0, 3);
}

function compactExternalDependency(dependency: any): Record<string, unknown> {
  return pickDefined({
    name: dependency.name,
    kind: dependency.kind,
    project: dependency.project,
    ports: dependency.ports,
    used: dependency.used,
    usage: dependency.usage,
  });
}

function compactIsolatedDeployable(deployable: any): Record<string, unknown> {
  return pickDefined({
    id: deployable.id,
    name: deployable.name,
    project: deployable.project,
    project_id: deployable.project_id,
    reason_category: deployable.reason_category,
    reason: truncateText(deployable.reason, 140),
  });
}

function compactWorkspaceRisk(risk: any): Record<string, unknown> {
  return pickDefined({
    id: risk.id,
    title: risk.title || risk.name,
    type: risk.type,
    severity: risk.severity,
    confidence: risk.confidence,
    description: truncateText(risk.description || risk.reason, 110),
    project_ids: (risk.project_ids || risk.projects || []).slice?.(0, 4),
    deployable_ids: (risk.deployable_ids || risk.application_ids || []).slice?.(0, 5),
    evidence: compactStringArray(risk.evidence, 1, 90),
  });
}

function semanticTerminalTrustGuidance(item: any): string | undefined {
  const terminalScore = Number(item?.terminal_score || 0);
  if (terminalScore <= 0 && item?.description_source === 'ai') {
    return 'AI-enriched orientation with little terminal/last-in-chain evidence; drill into repo CAS before treating as core product truth.';
  }
  if (terminalScore > 0 && terminalScore < 8 && item?.semantic_role === 'core') {
    return 'Core-ranked but low terminal evidence; verify supporting repo-level paths before strategic or architectural decisions.';
  }
  return undefined;
}

function compactWorkspaceCapability(capability: any): Record<string, unknown> {
  return pickDefined({
    id: capability.id,
    name: capability.name || capability.title,
    domain: capability.domain,
    confidence: capability.confidence,
	    description: truncateText(capability.description || capability.summary, 80),
	    description_source: capability.description_source,
	    generation_pass: capability.generation_pass,
	    semantic_role: capability.semantic_role,
	    terminal_score: capability.terminal_score,
	    semantic_trust_guidance: semanticTerminalTrustGuidance(capability),
	    terminal_evidence: compactStringArray(capability.terminal_evidence, 1, 60),
	    project_ids: (capability.project_ids || capability.projects || []).slice?.(0, 3),
	    deployable_ids: (capability.deployable_ids || capability.application_ids || []).slice?.(0, 4),
	    evidence: compactStringArray(capability.evidence, 1, 60),
	  });
}

function compactWorkspaceWorkflow(workflow: any): Record<string, unknown> {
  return pickDefined({
    id: workflow.id,
    name: workflow.name || workflow.title,
    mode: workflow.mode,
    confidence: workflow.confidence,
	    evidence_quality: workflow.evidence_quality,
	    trust_guidance: workflow.evidence_quality ? workspaceLinkTrustGuidance(workflow.evidence_quality) : undefined,
	    description: truncateText(workflow.description || workflow.summary, 80),
	    semantic_role: workflow.semantic_role,
	    terminal_score: workflow.terminal_score,
	    semantic_trust_guidance: semanticTerminalTrustGuidance(workflow),
	    terminal_evidence: compactStringArray(workflow.terminal_evidence, 1, 60),
	    project_ids: (workflow.project_ids || workflow.projects || []).slice?.(0, 3),
	    deployable_ids: (workflow.deployable_ids || workflow.application_ids || []).slice?.(0, 4),
    steps: Array.isArray(workflow.steps) ? workflow.steps.slice(0, 2).map((step: any) => typeof step === 'string' ? truncateText(step, 48) : pickDefined({
      name: step.name || step.title,
      deployable_id: step.deployable_id || step.application_id,
      project_id: step.project_id,
    })) : undefined,
    evidence: compactStringArray(workflow.evidence, 1, 60),
  });
}

function compactWorkspaceEntityPath(pathItem: any): Record<string, unknown> {
  const compactSteps = Array.isArray(pathItem.steps) ? pathItem.steps.slice(0, 2).map(compactWorkspaceEntityPathStep) : undefined;
  return pickDefined({
    id: pathItem.id,
    name: truncateText(pathItem.name, 80),
    entity_name: pathItem.entity_name,
    path_type: pathItem.path_type,
    description: truncateText(pathItem.description, 110),
    project_ids: (pathItem.project_ids || []).slice?.(0, 3),
    source: compactWorkspaceEntityPathEndpoint(pathItem.source),
    target: compactWorkspaceEntityPathEndpoint(pathItem.target),
    steps: compactSteps,
    step_count: Array.isArray(pathItem.steps) ? pathItem.steps.length : undefined,
    via: compactSteps?.length ? undefined : Array.isArray(pathItem.via) ? pathItem.via.slice(0, 3).map((step: any) => pickDefined({
      project_id: step.project_id,
      deployable_id: step.deployable_id,
      role: step.role,
      label: truncateText(step.label, 48),
    })) : undefined,
    sensitive: pathItem.sensitive,
    confidence: pathItem.confidence,
    evidence_quality: pathItem.evidence_quality,
    evidence: compactStringArray(pathItem.evidence, 1, 55),
  });
}

function compactWorkspaceEntityPathEndpoint(endpoint: any): Record<string, unknown> | undefined {
  if (!endpoint) return undefined;
  return pickDefined({
    project_id: endpoint.project_id,
    deployable_id: endpoint.deployable_id,
    role: endpoint.role,
    label: truncateText(endpoint.label, 44),
    file: endpoint.file ? truncateText(stripLocalPathPrefix(endpoint.file), 64) : undefined,
  });
}

function compactWorkspaceEntityPathStep(step: any): Record<string, unknown> {
  return pickDefined({
    sequence: step.sequence,
    project_id: step.project_id,
    deployable_id: step.deployable_id,
    role: step.role,
    label: truncateText(step.label, 44),
    edge_type: step.edge_type,
    evidence_quality: step.evidence_quality,
    file: step.file ? truncateText(stripLocalPathPrefix(step.file), 64) : undefined,
  });
}

function compactWorkspaceEntity(entity: any): Record<string, unknown> {
  return pickDefined({
    id: entity.id,
    name: entity.name,
    description: truncateText(entity.description, 80),
    description_source: entity.description_source,
    project_ids: (entity.project_ids || []).slice?.(0, 3),
    entity_ref_count: Array.isArray(entity.entity_refs) ? entity.entity_refs.length : undefined,
    related_capability_count: (entity.related_capability_ids || []).length,
    related_workflow_count: (entity.related_workflow_ids || []).length,
    related_data_flow_path_count: (entity.related_data_flow_path_ids || []).length,
    path_count: entity.path_count,
	    path_types: (entity.path_types || []).slice?.(0, 4),
	    semantic_role: entity.semantic_role,
	    terminal_score: entity.terminal_score,
	    semantic_trust_guidance: semanticTerminalTrustGuidance(entity),
	    terminal_evidence: compactStringArray(entity.terminal_evidence, 1, 60),
	    sensitive_fields: (entity.sensitive_fields || []).slice?.(0, 3),
    lifecycle: entity.lifecycle,
    confidence: entity.confidence,
  });
}

function compactWorkspaceEnvironment(environment: any): Record<string, unknown> {
  return pickDefined({
    name: environment.name,
    type: environment.type,
    provider: environment.provider,
    resolution_status: environment.resolution_status,
    resolution_note: environment.resolution_note,
    confidence: environment.confidence,
    project_ids: (environment.project_ids || environment.projects || []).slice?.(0, 5),
    runtime_component_count: environment.runtime_component_count,
    evidence: compactStringArray(environment.evidence, 1, 100),
  });
}

function compactWorkspaceInfrastructureOverlay(overlay: WorkspaceInfrastructureOverlay | undefined): Record<string, unknown> | undefined {
  if (!overlay) return undefined;
  return pickDefined({
    status: overlay.status,
    summary: truncateText(overlay.summary, 130),
    environments: overlay.environments.slice(0, 1).map(environment => pickDefined({
      name: environment.name,
      resource_count: environment.resource_count,
      deployable_ids: environment.deployable_ids.slice(0, 3),
      resource_kinds: environment.resource_kinds.slice(0, 2),
      key_resources: environment.key_resources.slice(0, 1),
    })),
    shared_resources: overlay.shared_resources.slice(0, 3).map(resource => pickDefined({
      name: resource.name,
      kind: resource.kind,
      usage: resource.usage,
      environment: resource.environment,
      deployable_ids: resource.connected_deployable_ids.slice(0, 2),
    })),
    gaps: compactStringArray(overlay.gaps, 1, 80),
  });
}

function compactActivitySummary(activity: any): Record<string, unknown> {
  return pickDefined({
    status: activity?.status,
    change_rate: activity?.change_rate,
    commits_30d: activity?.commits_30d,
    commits_90d: activity?.commits_90d,
    unique_authors_30d: activity?.unique_authors_30d,
    lines_changed_30d: activity?.lines_changed_30d,
    hotspots: Array.isArray(activity?.hotspots) ? activity.hotspots.slice(0, 3).map((item: any) => pickDefined({
      project_id: item.project_id,
      deployable_id: item.deployable_id,
      label: item.label,
      reason: truncateText(item.reason, 80),
      score: item.score,
    })) : undefined,
  });
}

function compactTelemetrySummary(telemetry: any): Record<string, unknown> {
  return pickDefined({
    status: telemetry?.status,
    runtime_signal_count: telemetry?.runtime_signal_count,
    error_count: telemetry?.error_count,
    trace_count: telemetry?.trace_count,
    flow_volume_count: telemetry?.flow_volume_count,
    top_runtime_signals: Array.isArray(telemetry?.top_runtime_signals) ? telemetry.top_runtime_signals.slice(0, 3).map((item: any) => pickDefined({
      label: item.label || item.name,
      project_id: item.project_id,
      deployable_id: item.deployable_id,
      signal_type: item.signal_type || item.type,
      count: item.count,
      severity: item.severity,
      reason: truncateText(item.reason || item.description, 80),
    })) : undefined,
  });
}

function compactStringArray(value: unknown, limit: number, maxLength: number): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.map(item => truncateText(String(item || ''), maxLength)).filter((item): item is string => Boolean(item)).slice(0, limit);
  return items.length ? items : undefined;
}

function truncateText(value: unknown, maxLength: number): string | undefined {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  return text.length > maxLength ? `${text.slice(0, Math.max(0, maxLength - 15)).trimEnd()}...[truncated]` : text;
}

function conciseText(value: unknown, maxLength: number): string | undefined {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  if (text.length <= maxLength) return text;
  return text.slice(0, Math.max(0, maxLength)).trimEnd();
}

function pickDefined(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) =>
    value !== undefined &&
    value !== null &&
    (!Array.isArray(value) || value.length > 0)
  ));
}

function workspaceSignalQuality(graph: WorkspaceAnalysisGraph): WorkspaceAgentContext['context_budget']['signal_quality'] {
  if (graph.health.status === 'healthy' && graph.composition?.evidence_quality === 'high' && graph.workspace_narrative.source === 'ai') return 'high';
  if (graph.health.status === 'at-risk' || graph.composition?.evidence_quality === 'low') return 'low';
  return 'medium';
}

function workspaceSignalReasons(graph: WorkspaceAnalysisGraph): string[] {
  return [
    `composition=${graph.composition?.kind || 'unknown'} confidence=${graph.composition?.confidence ?? 'unknown'} evidence=${graph.composition?.evidence_quality || 'unknown'}`,
    `health=${graph.health.status} score=${graph.health.score}`,
    `cas_inputs_ready=${graph.health.analysis_trust.ready_inputs}/${graph.inputs.length}`,
    `workspace_links=${graph.application_links.length}`,
    `distribution_units=${graph.distribution_units.length}`,
    `unmatched_interfaces=${graph.unmatched_interfaces.length}`,
    `telemetry=${graph.telemetry.status}`,
    `narrative_source=${graph.workspace_narrative.source}`,
  ];
}

function clampPositiveInteger(value: number | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(1, Math.min(80, Math.floor(parsed)));
}

function tokenizeTaskText(text: string): string[] {
  return [...new Set(String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9_.-]+/)
    .map(term => term.trim())
    .filter(term => term.length >= 3)
    .filter(term => !/^(the|and|for|with|from|that|this|into|need|needs|change|fix|debug|add|remove|update|system|service|repo|codebase|workspace)$/.test(term)))];
}

function scoreTextForTerms(text: string, terms: string[]): number {
  if (terms.length === 0) return 0;
  const haystack = String(text || '').toLowerCase();
  return terms.reduce((score, term) => score + (haystack.includes(term) ? 2 : 0), 0);
}

function selectedAppReasons(
  app: SystemApplication,
  project: SystemCodebase | undefined,
  directScore: number,
  topologyScore: number,
  insightScore: number,
): string[] {
  const reasons = [];
  if (directScore > 0) reasons.push('Matches task target or instructions.');
  if (topologyScore > 0) reasons.push('Has workspace-level integration links.');
  if (insightScore > 0) reasons.push('Appears in a higher-order workspace insight.');
  if (app.ports.length) reasons.push(`Exposes runtime port(s): ${app.ports.join(', ')}.`);
  if (project?.frameworks?.length) reasons.push(`Project framework context: ${project.frameworks.slice(0, 3).join(', ')}.`);
  return reasons.length ? reasons : ['Relevant workspace deployable.'];
}

function buildWorkspaceInputs(repositories: CrossCodebaseInput[]): WorkspaceAnalysisInputRef[] {
  return repositories.map(repository => {
    const cas = repository.cas as CASOutput & {
      id?: string;
      analysis_id?: string;
      version?: string;
      generated_at?: string;
      metadata?: { analysis_id?: string; version?: string; generated_at?: string };
    };
    const id = codebaseId(repository.path);
    return {
      project_id: id,
      codebase_id: id,
      repo_path: repository.path,
      cas_analysis_id: cas.analysis_id || cas.id || cas.metadata?.analysis_id,
      cas_version: cas.version || (cas as any).cas_version || cas.metadata?.version,
      cas_generated_at: cas.generated_at || (cas as any).analysis_timestamp || cas.metadata?.generated_at,
      repository: {
        url: cas.system?.repository?.url,
        branch: cas.system?.repository?.branch,
        commit: cas.system?.repository?.commit,
        dirty_state: String(cas.system?.repository?.commit || '').trim() ? 'clean' : 'unknown',
      },
      analysis_trust: analysisTrust(repository.cas),
    };
  });
}

function buildWorkspaceValidation(
  codebases: SystemCodebase[],
  applications: SystemApplication[],
  interfaces: SystemInterface[],
  applicationLinks: SystemApplicationLink[],
  unmatchedInterfaces: UnmatchedSystemInterface[],
  inputs: WorkspaceAnalysisInputRef[],
  health: WorkspaceHealth,
): WorkspaceValidation {
  const deployables = applications.filter(app => app.deployable);
  const linkedApplicationIds = new Set(applicationLinks.flatMap(link => [link.source_application_id, link.target_application_id]));
  const linkedModes = applicationLinks.reduce((counts, link) => {
    counts[link.mode] = (counts[link.mode] || 0) + 1;
    return counts;
  }, {} as Partial<Record<SystemInterfaceMode, number>>);
  const missingRequiredSections = [
    inputs.length ? '' : 'inputs',
    codebases.length ? '' : 'projects',
    applications.length ? '' : 'deployables',
    health ? '' : 'health',
  ].filter(Boolean);
  const knownUnknowns = [
    ...inputs.filter(input => input.analysis_trust.status !== 'ready').map(input => `${input.project_id}: ${input.analysis_trust.reasons.join('; ')}`),
    ...(unmatchedInterfaces.length ? [`${unmatchedInterfaces.length} unmatched interface(s) require deeper evidence or explicit review.`] : []),
  ];
  return {
    conforms_to_was: missingRequiredSections.length === 0,
    missing_required_sections: missingRequiredSections,
    source_code_read_required: false,
    cas_inputs_validated: codebases.map(codebase => {
      const input = inputs.find(candidate => candidate.codebase_id === codebase.id);
      const missingFacts = [
        codebase.graph.nodes > 0 ? '' : 'nodes',
        codebase.graph.entry_points > 0 || codebase.graph.exit_points > 0 ? '' : 'entry_or_exit_points',
        input?.cas_analysis_id ? '' : 'cas_analysis_id',
        input?.cas_generated_at ? '' : 'cas_generated_at',
      ].filter(Boolean);
      const status: WorkspaceValidation['cas_inputs_validated'][number]['status'] = input?.analysis_trust.status === 'stale'
        ? 'stale'
        : missingFacts.length ? 'missing-required-facts'
          : 'valid';
      return {
        project_id: codebase.id,
        codebase_id: codebase.id,
        cas_analysis_id: input?.cas_analysis_id,
        status,
        missing_facts: missingFacts,
        has_nodes: codebase.graph.nodes > 0,
        has_edges: codebase.graph.edges > 0,
        has_entry_points: codebase.graph.entry_points > 0,
        has_exit_points: codebase.graph.exit_points > 0,
      };
    }),
    relationship_coverage: {
      deployable_count: deployables.length,
      deployables_with_interfaces: deployables.filter(app => app.interface_ids.length > 0).length,
      deployables_with_links: deployables.filter(app => linkedApplicationIds.has(app.id)).length,
      integration_link_count: applicationLinks.length,
      application_link_count: applicationLinks.length,
      unmatched_interface_count: unmatchedInterfaces.length,
      linked_modes: linkedModes,
    },
    known_unknowns: knownUnknowns,
  };
}

function buildWorkspaceDetailViews(
  codebases: SystemCodebase[],
  applications: SystemApplication[],
  distributionUnits: WorkspaceDistributionUnit[],
  interfaces: SystemInterface[],
  runtimeComponents: SystemRuntimeComponent[],
  runtimeLinks: SystemRuntimeLink[],
  applicationLinks: SystemApplicationLink[],
  insights: SystemInsight[],
  dataFlowPaths: SystemDataFlowPath[],
  workspaceEntities: WorkspaceEntity[],
  workspaceEntityPaths: WorkspaceEntityPath[],
  unmatchedInterfaces: UnmatchedSystemInterface[],
  validation: WorkspaceValidation,
  narrative: WorkspaceNarrative,
  composition: WorkspaceCompositionProfile,
  ownership: Record<string, WorkspaceOwnership>,
  activity: WorkspaceActivitySummary,
  telemetry: WorkspaceTelemetrySummary,
  health: WorkspaceHealth,
  riskAreas: WorkspaceRiskArea[],
  capabilities: WorkspaceCapability[],
  workflows: WorkspaceWorkflow[],
  environments: WorkspaceEnvironment[],
  infrastructureOverlay: WorkspaceInfrastructureOverlay,
  sharedCodeRollup: WorkspaceSharedCodeRollup[] = [],
): WorkspaceDetailViews {
  const codebaseById = new Map(codebases.map(codebase => [codebase.id, codebase]));
  const appById = new Map(applications.map(app => [app.id, app]));
  const connectedApps = new Set(applicationLinks.flatMap(link => [link.source_application_id, link.target_application_id]));
  const overviewApplications = applications
    .filter(app => shouldExposeInWorkspaceOverview(app, applications))
    .sort((left, right) =>
      workspaceOverviewApplicationRank(right, codebaseById.get(right.codebase_id), connectedApps) -
        workspaceOverviewApplicationRank(left, codebaseById.get(left.codebase_id), connectedApps) ||
      left.name.localeCompare(right.name)
    );
  const overviewAppIds = new Set(overviewApplications.map(app => app.id));
  const overview: WorkspaceLevelOneOverview = {
    level: 'overview',
    composition,
    description: narrative.description,
    projects: codebases.map(codebase => ({
      id: codebase.id,
      name: codebase.name,
      path: codebase.path,
      system_type: codebase.system_type,
      project_role: codebase.project_role,
    })),
    health,
    activity,
    telemetry,
    risk_areas: riskAreas.slice(0, 10),
    capabilities: capabilities.slice(0, 12),
    workflows: workflows.slice(0, 12),
    entities: workspaceEntities.slice(0, 12),
    environments,
    infrastructure_overlay: infrastructureOverlay,
    deployables: overviewApplications
      .map(app => ({
        id: app.id,
        name: app.name,
        project: codebaseById.get(app.codebase_id)?.name || app.codebase_id,
        project_id: app.codebase_id,
        project_path: app.codebase_path,
        project_role: codebaseById.get(app.codebase_id)?.project_role || 'unknown',
        kind: app.kind,
        surface_kind: app.kind,
        deployable: app.deployable,
        ports: app.ports,
        isolated: !connectedApps.has(app.id),
        confidence: deployableConfidence(app),
        ownership: ownership[app.id] || unknownOwnership(),
        description: app.description,
        evidence: (app.evidence || []).slice(0, 6),
        trust_guidance: app.trust_guidance,
      })),
    distribution_units: distributionUnits.slice(0, 40),
    connections: dedupeOverviewConnections(applicationLinks
      .filter(link => overviewAppIds.has(link.source_application_id) && overviewAppIds.has(link.target_application_id))
      .map(link => ({
      source: appById.get(link.source_application_id)?.name || link.source_application_id,
      source_id: link.source_application_id,
      source_project_id: link.source_codebase_id,
      target: appById.get(link.target_application_id)?.name || link.target_application_id,
      target_id: link.target_application_id,
      target_project_id: link.target_codebase_id,
      kind: link.kind,
      mode: link.mode,
      runtime_behavior: workspaceLinkRuntimeBehavior(link),
      connection_nature: workspaceLinkConnectionNature(link),
      inferred_reason: workspaceLinkInferredReason(link),
      confidence: link.confidence,
      link_id: link.id,
      source_interface_id: link.source_interface_id,
      target_interface_id: link.target_interface_id,
      evidence_quality: link.evidence_quality,
      trust_guidance: link.trust_guidance || workspaceLinkTrustGuidance(link.evidence_quality),
    }))).slice(0, 120),
    trusted_connections: dedupeOverviewConnections(applicationLinks
      .filter(link => overviewAppIds.has(link.source_application_id) && overviewAppIds.has(link.target_application_id) && isTrustedWorkspaceApplicationLink(link))
      .sort(compareWorkspaceLinksByTrust)
      .map(link => ({
      source: appById.get(link.source_application_id)?.name || link.source_application_id,
      source_id: link.source_application_id,
      source_project_id: link.source_codebase_id,
      target: appById.get(link.target_application_id)?.name || link.target_application_id,
      target_id: link.target_application_id,
      target_project_id: link.target_codebase_id,
      kind: link.kind,
      mode: link.mode,
      runtime_behavior: workspaceLinkRuntimeBehavior(link),
      connection_nature: workspaceLinkConnectionNature(link),
      inferred_reason: workspaceLinkInferredReason(link),
      confidence: link.confidence,
      link_id: link.id,
      source_interface_id: link.source_interface_id,
      target_interface_id: link.target_interface_id,
      evidence_quality: link.evidence_quality,
      trust_guidance: link.trust_guidance || workspaceLinkTrustGuidance(link.evidence_quality),
    }))).slice(0, 80),
    source_backed_connections: dedupeOverviewConnections(applicationLinks
      .filter(link => overviewAppIds.has(link.source_application_id) && overviewAppIds.has(link.target_application_id) && link.evidence_quality === 'source-backed')
      .sort(compareWorkspaceLinksByTrust)
      .map(link => ({
      source: appById.get(link.source_application_id)?.name || link.source_application_id,
      source_id: link.source_application_id,
      source_project_id: link.source_codebase_id,
      target: appById.get(link.target_application_id)?.name || link.target_application_id,
      target_id: link.target_application_id,
      target_project_id: link.target_codebase_id,
      kind: link.kind,
      mode: link.mode,
      runtime_behavior: workspaceLinkRuntimeBehavior(link),
      connection_nature: workspaceLinkConnectionNature(link),
      inferred_reason: workspaceLinkInferredReason(link),
      confidence: link.confidence,
      link_id: link.id,
      source_interface_id: link.source_interface_id,
      target_interface_id: link.target_interface_id,
      evidence_quality: link.evidence_quality,
      trust_guidance: link.trust_guidance || workspaceLinkTrustGuidance(link.evidence_quality),
    }))).slice(0, 80),
    candidate_connections: dedupeOverviewConnections(applicationLinks
      .filter(link => overviewAppIds.has(link.source_application_id) && overviewAppIds.has(link.target_application_id) && !isTrustedWorkspaceApplicationLink(link))
      .sort(compareWorkspaceLinksByTrust)
      .map(link => ({
      source: appById.get(link.source_application_id)?.name || link.source_application_id,
      source_id: link.source_application_id,
      source_project_id: link.source_codebase_id,
      target: appById.get(link.target_application_id)?.name || link.target_application_id,
      target_id: link.target_application_id,
      target_project_id: link.target_codebase_id,
      kind: link.kind,
      mode: link.mode,
      runtime_behavior: workspaceLinkRuntimeBehavior(link),
      connection_nature: workspaceLinkConnectionNature(link),
      inferred_reason: workspaceLinkInferredReason(link),
      confidence: link.confidence,
      link_id: link.id,
      source_interface_id: link.source_interface_id,
      target_interface_id: link.target_interface_id,
      evidence_quality: link.evidence_quality,
      trust_guidance: link.trust_guidance || workspaceLinkTrustGuidance(link.evidence_quality),
    }))).slice(0, 80),
    external_dependencies: dedupeExternalDependencies([
      ...runtimeComponents
        .filter(component => isExternalRuntimeDependency(component.name, component.kind))
        .map(component => {
          const usage = runtimeComponentUsage(component, runtimeLinks);
          return {
        name: component.name,
        kind: component.kind,
        project: codebaseById.get(component.codebase_id)?.name || component.codebase_id,
        ports: component.ports,
            used: usage === 'source-backed',
            usage,
          };
        }),
      ...externalDependenciesFromInterfaces(interfaces, codebaseById),
    ]),
    isolated_deployables: applications
      .filter(app => shouldExposeInWorkspaceOverview(app, applications) && !connectedApps.has(app.id))
      .map(app => ({
        id: app.id,
        name: app.name,
        project: codebaseById.get(app.codebase_id)?.name || app.codebase_id,
        project_id: app.codebase_id,
        reason: isolatedDeployableReason(app),
        reason_category: isolatedDeployableReasonCategory(app),
      })),
  };
  return {
    overview,
    connections: {
      level: 'connections',
      overview,
      integration_links: applicationLinks,
      runtime_links: runtimeLinks,
      inferred_insights: insights,
      unmatched_interfaces: unmatchedInterfaces.slice(0, 120),
    },
    evidence: {
      level: 'evidence',
      overview,
      interfaces,
      integration_links: applicationLinks,
      runtime_topology: {
        components: runtimeComponents,
        links: runtimeLinks,
      },
      distribution_units: distributionUnits,
      data_flow_paths: dataFlowPaths,
      workspace_entities: workspaceEntities,
      workspace_entity_paths: workspaceEntityPaths,
      inferred_insights: insights,
      unmatched_interfaces: unmatchedInterfaces,
      validation,
      shared_code_rollup: sharedCodeRollup,
    },
  };
}

function deployableConfidence(app: SystemApplication): number {
  let score = app.deployable ? 0.72 : 0.58;
  if (app.interface_ids.length > 0) score += 0.12;
  if (app.runtime_component_ids.length > 0) score += 0.1;
  if (app.path_hint && /(?:^|\/)(apps|services|packages|cmd|bin|src)\//.test(app.path_hint)) score += 0.04;
  return Math.min(0.96, score);
}

function isolatedDeployableReasonCategory(app: SystemApplication): WorkspaceLevelOneOverview['isolated_deployables'][number]['reason_category'] {
  const text = `${app.name} ${app.kind} ${app.path_hint || ''}`.toLowerCase();
  if (/marketing|website|docs|storybook|demo|example|fixture|scan|ci|jenkins|contractor|tray|desktop-tray|system-tray|tool/.test(text)) return 'validated-standalone';
  if (app.interface_ids.length > 0 || app.runtime_component_ids.length > 0) return 'unresolved-candidate';
  if (app.deployable) return 'weak-cas-signal';
  return 'no-evidence';
}

function isolatedDeployableReason(app: SystemApplication): string {
  const category = isolatedDeployableReasonCategory(app);
  if (category === 'validated-standalone') return 'No workspace link was found and the surface looks intentionally standalone or auxiliary from name/path/runtime evidence.';
  if (category === 'unresolved-candidate') return 'No workspace link was found even though the deployable has interfaces or runtime topology; treat this as a cross-CAS investigation candidate before assuming isolation.';
  if (category === 'weak-cas-signal') return 'No workspace link was found for this deployable; there is not enough cross-project evidence to prove whether isolation is intentional.';
  return 'No interface, runtime, or link evidence connects this surface at workspace level.';
}

function workspaceOverviewApplicationRank(
  app: SystemApplication,
  codebase: SystemCodebase | undefined,
  connectedApps: Set<string>,
): number {
  const name = normalizeAiItemName(app.name);
  const pathHint = normalizeAiItemName(app.path_hint || '');
  let score = 0;
  if (app.deployable) score += 24;
  if (connectedApps.has(app.id)) score += 22;
  if (codebase?.project_role === 'production') score += 18;
  if (codebase?.project_role === 'prototype' || codebase?.project_role === 'demo') score -= 14;
  if (app.kind === 'service' || app.kind === 'app' || app.kind === 'worker') score += 12;
  if (app.kind === 'package') score -= 8;
  if (app.ports.length) score += 6;
  if (/\b(api|frontend|backend|web|ui|mobile|client|client service|agent|coordinator|drop server|gateway|worker|sync|lens|link|mcp server)\b/.test(name)) score += 34;
  if (/\b(test|spec|fixture|mock|demo|example|sandbox|old|legacy|sample|btm)\b/.test(`${name} ${pathHint}`)) score -= 72;
  if (/\b(root|shared|types|utils|common|core)\b/.test(name) && app.kind === 'package' && !connectedApps.has(app.id)) score -= 18;
  return score;
}

function isExternalRuntimeDependency(name: string, kind = ''): boolean {
  return /postgres|mysql|mariadb|mongodb|redis|memcached|rabbit|kafka|nats|minio|s3|elastic|opensearch|clickhouse|timescale|database|db|aws[_ .-]|azurerm[_ .-]|google[_ .-]|ecs|ec2|nlb|alb|load[_ .-]?balancer|vpc|subnet|security[_ .-]?group|cloudwatch|iam|route53|ecr|rds/i.test(`${name} ${kind}`);
}

function runtimeComponentUsage(component: SystemRuntimeComponent, runtimeLinks: SystemRuntimeLink[]): WorkspaceLevelOneOverview['external_dependencies'][number]['usage'] {
  const links = runtimeLinks.filter(link => link.source_component_id === component.id || link.target_component_id === component.id);
  if (links.some(link => link.evidence.some(isSourceBackedRuntimeEvidence))) return 'source-backed';
  if (links.length > 0) return 'topology-only';
  if (component.refs.length > 0 || component.topology_surface) return 'topology-only';
  return 'declared';
}

function isSourceBackedRuntimeEvidence(evidence: string): boolean {
  return !/(?:topology-backed:|name-inferred:|route-shape-inferred:|SERVICE-DEPENDENCY|SERVICE-REFERENCE|Compose dependency|Compose service|ALL http:\/\/|FETCH http:\/\/|docker-compose|compose_service|consumer:docker-compose|provider:docker-compose|Dockerfile)/i.test(evidence);
}

function applicationLinkHasSourceBackedEvidence(link: SystemApplicationLink): boolean {
  if (link.evidence_quality) return link.evidence_quality === 'source-backed' || link.evidence_quality === 'package-declared';
  return link.evidence.length > 0 && link.evidence.some(isSourceBackedRuntimeEvidence);
}

function isTrustedWorkspaceApplicationLink(link: SystemApplicationLink): boolean {
  return link.evidence_quality === 'source-backed' ||
    link.evidence_quality === 'package-declared' ||
    (link.evidence_quality === 'topology-backed' && link.confidence >= 0.82);
}

function compareWorkspaceLinksByTrust(left: SystemApplicationLink, right: SystemApplicationLink): number {
  return linkQualityRank(right) - linkQualityRank(left) ||
    right.confidence - left.confidence ||
    left.source_application_id.localeCompare(right.source_application_id) ||
    left.target_application_id.localeCompare(right.target_application_id);
}

function externalDependenciesFromInterfaces(
  interfaces: SystemInterface[],
  codebaseById: Map<string, SystemCodebase>,
): WorkspaceLevelOneOverview['external_dependencies'] {
  return interfaces
    .filter(item => item.role === 'consumer' && item.kind === 'sdk' && item.package_name && isWorkspaceRelevantExternalDependency(item.package_name))
    .map(item => ({
      name: displayExternalDependencyName(item.package_name || item.name),
      kind: 'sdk',
      project: codebaseById.get(item.codebase_id)?.name || item.codebase_id,
      ports: [],
      used: true,
      usage: 'source-backed' as const,
    }));
}

function dedupeExternalDependencies(
  dependencies: WorkspaceLevelOneOverview['external_dependencies'],
): WorkspaceLevelOneOverview['external_dependencies'] {
  const byKey = new Map<string, WorkspaceLevelOneOverview['external_dependencies'][number]>();
  for (const dependency of dependencies) {
    const key = `${dependency.project}:${dependency.name.toLowerCase()}:${dependency.kind}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, dependency);
      continue;
    }
    const usage = usageRank(dependency.usage) > usageRank(existing.usage) ? dependency.usage : existing.usage;
    byKey.set(key, {
      ...existing,
      ports: mergeStrings(existing.ports, dependency.ports).sort(),
      used: existing.used || dependency.used || usage === 'source-backed',
      usage,
    });
  }
  return [...byKey.values()].sort((left, right) =>
    left.project.localeCompare(right.project) || left.name.localeCompare(right.name)
  );
}

function usageRank(usage: WorkspaceLevelOneOverview['external_dependencies'][number]['usage']): number {
  if (usage === 'source-backed') return 3;
  if (usage === 'topology-only') return 2;
  return 1;
}

function linkQualityRank(link: Pick<SystemApplicationLink, 'evidence_quality' | 'confidence'>): number {
  const quality = link.evidence_quality || 'route-shape-inferred';
  if (quality === 'source-backed') return 5;
  if (quality === 'package-declared') return 4;
  if (quality === 'topology-backed') return 3;
  if (quality === 'route-shape-inferred') return 2;
  return 1;
}

function workspaceLinkTrustGuidance(quality: WorkspaceLinkEvidenceQuality): string {
  if (quality === 'source-backed') return 'Treat as source-backed, but still drill into the repo CAS before editing contracts.';
  if (quality === 'package-declared') return 'Treat as a declared package dependency; inspect imports and call sites before changing behavior.';
  if (quality === 'topology-backed') return 'Treat as deployment/topology evidence, not proof of source-level calls.';
  if (quality === 'route-shape-inferred') return 'Treat as route-shape inference; verify caller and provider code before relying on it.';
  return 'Treat as weak name inference; use only as an orientation hint until source evidence is found.';
}

function compactWorkspaceLinkTrustGuidance(quality: WorkspaceLinkEvidenceQuality): string {
  if (quality === 'source-backed') return 'source-backed; drill into repo CAS before editing contracts';
  if (quality === 'package-declared') return 'declared package dependency; inspect imports/call sites';
  if (quality === 'topology-backed') return 'deployment/topology evidence, not source-level usage';
  if (quality === 'route-shape-inferred') return 'route-shape inference; verify caller/provider code';
  return 'weak name inference; orientation only';
}

function workspaceLinkRuntimeBehavior(link: Pick<SystemApplicationLink, 'kind' | 'evidence_quality' | 'source_runtime_component_id' | 'target_runtime_component_id'>): WorkspaceRuntimeBehavior {
  if (link.kind === 'sdk-install') return 'no';
  if (link.evidence_quality === 'source-backed') return 'yes';
  if (link.source_runtime_component_id || link.target_runtime_component_id) return 'unknown';
  return 'unknown';
}

function workspaceLinkConnectionNature(link: Pick<SystemApplicationLink, 'kind' | 'evidence_quality'>): string {
  if (link.kind === 'sdk-install') return 'code-dependency';
  if (link.evidence_quality === 'source-backed') return 'runtime-communication';
  if (link.evidence_quality === 'package-declared') return 'declared-code-dependency';
  if (link.evidence_quality === 'topology-backed') return 'runtime-topology';
  if (link.evidence_quality === 'route-shape-inferred') return 'route-shape-candidate';
  return 'name-candidate';
}

function workspaceLinkInferredReason(link: Pick<SystemApplicationLink, 'kind' | 'evidence_quality'>): string | undefined {
  if (link.evidence_quality === 'source-backed') return undefined;
  if (link.kind === 'sdk-install') return 'Package/import evidence proves a code dependency, not runtime communication.';
  if (link.evidence_quality === 'package-declared') return 'Declared package dependency; inspect imports and call sites before treating as behavior.';
  if (link.evidence_quality === 'topology-backed') return 'Deployment/config topology connects these surfaces, but source-level caller/provider evidence is not present.';
  if (link.evidence_quality === 'route-shape-inferred') return 'Consumer/provider route shapes look compatible, but a concrete caller-to-provider path was not found.';
  return 'Name or alias similarity only; use as orientation until source evidence confirms the relationship.';
}

function workspaceAgentReadNext(
  graph: WorkspaceAnalysisGraph,
  selectedApps: Array<{
    id: string;
    name: string;
    project: string;
    project_id: string;
    project_path: string;
  }>,
  selectedConnections: Array<{ source: string; target: string; evidence_quality: WorkspaceLinkEvidenceQuality; link_id: string }>,
  candidateConnections: Array<{ source: string; target: string; evidence_quality: WorkspaceLinkEvidenceQuality; link_id: string }>,
  options: WorkspaceAgentContextOptions,
): Array<{ target: string; why: string; tool?: string; args?: Record<string, unknown> }> {
  const items: Array<{ target: string; why: string; tool?: string; args?: Record<string, unknown> }> = [];
  for (const app of selectedApps.slice(0, 3)) {
    items.push({
      target: `${app.project}:${app.name}`,
      why: 'Repo-level CAS is the source of file, idiom, invariant, and test detail before edits.',
      tool: 'get_agent_context',
    });
  }
  for (const link of selectedConnections.slice(0, 1)) {
    items.push({
      target: `${link.source} -> ${link.target}`,
      why: `Source-backed workspace connection (${link.evidence_quality}); inspect evidence before changing contracts.`,
      tool: 'get_workspace_analysis',
    });
  }
  for (const link of candidateConnections.slice(0, 1)) {
    items.push({
      target: `${link.source} -> ${link.target}`,
      why: `Candidate connection (${link.evidence_quality}); verify before relying on it.`,
      tool: 'get_workspace_analysis',
    });
  }
  return items;
}

function compactWorkspaceNextMcpCalls<T extends { tool?: string; args?: Record<string, unknown>; when?: string }>(calls: T[]): T[] {
  const seen = new Set<string>();
  const compacted: T[] = [];
  for (const call of calls) {
    const pathValue = typeof call.args?.path === 'string' ? call.args.path : '';
    const key = `${call.tool || ''}:${pathValue || JSON.stringify(call.args || {})}`;
    if (seen.has(key)) continue;
    seen.add(key);
    compacted.push({
      ...call,
      when: call.when ? conciseText(call.when, 120) : call.when,
    });
    if (compacted.length >= 4) break;
  }
  return compacted;
}

function shouldExposeInWorkspaceOverview(app: SystemApplication, applications: SystemApplication[]): boolean {
  if (app.merged_into) return false;
  if (isExternalRuntimeDependency(app.name, app.kind)) return false;
  if (isRawInfrastructureOrImageSurface(app)) return false;
  if (!app.deployable && app.kind === 'codebase') return false;
  if (app.kind === 'tool') return false;
  if (looksLikeInternalUtilityApplication(app)) return false;
  const siblings = applications.filter(candidate => candidate.codebase_id === app.codebase_id && candidate.id !== app.id);
  if (isSyntheticRootApplication(app, siblings)) return false;
  if (isWeakerDuplicateApplicationSurface(app, siblings)) return false;
  if (isConsumerOnlyLocalCommand(app)) return false;
  if (isInternalRustCrateSurface(app, siblings)) return false;
  if (app.kind === 'package' && !isFirstClassPackageSurface(app)) return false;
  return app.deployable || app.interface_ids.length > 0 || app.runtime_component_ids.length > 0;
}

function looksLikeInternalUtilityApplication(app: SystemApplication): boolean {
  const normalized = `${app.name} ${app.path_hint || ''}`.toLowerCase();
  if (/^(base|app-base|application|shared|core|data|models?|schemas?|contracts?|types?|utils?|helpers?|unprotected)([-_/\s]|$)/.test(normalized)) return true;
  if (/^(build|buildbinaries|check|checkreq|script|migrate|seed|release|releases)([-_/\s]|$)/.test(normalized) && app.ports.length === 0) return true;
  if (/^(127(?:[-_.]0){2}[-_.]1|0[-_.]0[-_.]0[-_.]0|localhost)([-_/\s]|$)/.test(normalized)) return true;
  return false;
}

function isRawInfrastructureOrImageSurface(app: SystemApplication): boolean {
  const normalized = `${app.name} ${app.kind} ${app.path_hint || ''}`.toLowerCase();
  if (/(^|[-_/\s])dockerfile($|[-_/\s])/.test(normalized)) return true;
  if (/^image[:\s]/.test(normalized)) return true;
  if (/^(resource|data|provider|variable|output)\./.test(app.name.toLowerCase())) return true;
  if (/^(postgres|redis|minio|mysql|mariadb|mongodb|database|db|nginx|traefik|caddy)([-_/\s]|$)/.test(normalized)) return true;
  if (app.kind === 'codebase' && /(?:^|[-_/\s])(postgres|redis|minio|mysql|mariadb|mongodb|database|db)(?:$|[-_/\s])/.test(normalized)) return true;
  const aliases = app.service_aliases.map(alias => alias.toLowerCase());
  const terraformOnly = app.ports.length === 0 &&
    app.interface_ids.length === 0 &&
    aliases.length > 0 &&
    aliases.every(alias =>
      alias === 'terraform' ||
      /(?:^|\/)main\.tf$/.test(alias) ||
      /^(?:resource|data|provider|variable|output|module)\./.test(alias));
  if (terraformOnly) return true;
  return false;
}

function isSyntheticRootApplication(app: SystemApplication, siblings: SystemApplication[]): boolean {
  if (siblings.length === 0) return false;
  const rootName = cleanApplicationName(path.basename(app.codebase_path || ''));
  const isRootName = Boolean(rootName && cleanApplicationName(app.name) === rootName);
  if (!isRootName && app.path_hint && app.path_hint !== '.') return false;
  const runtimeOnlyImage = app.runtime_component_ids.length > 0 &&
    app.ports.length === 0 &&
    app.service_aliases.some(alias => /docker image definition|dockerfile/i.test(alias));
  if (app.runtime_component_ids.length > 0 && !runtimeOnlyImage) return false;
  const meaningfulSibling = siblings.some(candidate =>
    !looksLikeInternalUtilityApplication(candidate) &&
    !isExternalRuntimeDependency(candidate.name, candidate.kind) &&
    (candidate.path_hint || candidate.runtime_component_ids.length > 0 || candidate.interface_ids.length > 0)
  );
  if (!meaningfulSibling) return false;
  return isRootName || app.interface_ids.length === 0 || app.kind === 'codebase';
}

function isWeakerDuplicateApplicationSurface(app: SystemApplication, siblings: SystemApplication[]): boolean {
  const canonical = app.name.replace(/[-_]/g, '').toLowerCase();
  const duplicate = siblings.find(candidate =>
    candidate.name.replace(/[-_]/g, '').toLowerCase() === canonical &&
    candidate.id !== app.id
  );
  if (!duplicate) return false;
  const appScore = app.interface_ids.length + app.runtime_component_ids.length * 2 + app.ports.length;
  const duplicateScore = duplicate.interface_ids.length + duplicate.runtime_component_ids.length * 2 + duplicate.ports.length;
  return appScore <= duplicateScore;
}

function isConsumerOnlyLocalCommand(app: SystemApplication): boolean {
  if (!/(?:^|\/)bin\//.test(app.path_hint || '')) return false;
  if (app.runtime_component_ids.length > 0 || app.ports.length > 0) return false;
  if (app.interface_ids.length === 0) return false;
  return !/(api|server|service|worker|agent|client|coordinator|gateway|drop-server|ui|web|mobile)/i.test(app.name);
}

function isFirstClassPackageSurface(app: SystemApplication): boolean {
  const normalized = `${app.name} ${app.path_hint || ''}`.toLowerCase();
  if (/(mobile|desktop|client|ui|app|sdk|library)/.test(normalized)) return true;
  return app.interface_ids.length > 0 || app.runtime_component_ids.length > 0;
}

function isInternalRustCrateSurface(app: SystemApplication, siblings: SystemApplication[]): boolean {
  if (app.kind !== 'package' || !/(?:^|\/)crates\//.test(app.path_hint || '')) return false;
  return siblings.some(candidate =>
    candidate.id !== app.id &&
    candidate.deployable &&
    (candidate.kind === 'service' || candidate.kind === 'app' || candidate.kind === 'cli')
  );
}

function dedupeOverviewConnections(
  connections: WorkspaceLevelOneOverview['connections'],
): WorkspaceLevelOneOverview['connections'] {
  const byKey = new Map<string, WorkspaceLevelOneOverview['connections'][number]>();
  for (const connection of connections) {
    const key = `${connection.source_id}->${connection.target_id}:${connection.kind}:${connection.mode}`;
    const existing = byKey.get(key);
    if (!existing || connection.confidence > existing.confidence) {
      byKey.set(key, connection);
    }
  }
  return [...byKey.values()].sort((left, right) =>
    left.source.localeCompare(right.source) ||
    left.target.localeCompare(right.target) ||
    right.confidence - left.confidence
  );
}

function classifyWorkspaceComposition(
  deployables: SystemApplication[],
  applicationLinks: SystemApplicationLink[],
  insights: SystemInsight[],
  inputs: WorkspaceAnalysisInputRef[] = [],
): WorkspaceCompositionProfile {
  const visibleIds = new Set(deployables.map(app => app.id));
  const visibleLinks = applicationLinks.filter(link => visibleIds.has(link.source_application_id) && visibleIds.has(link.target_application_id));
  const runtimeLinks = visibleLinks.filter(link => link.kind !== 'sdk-install');
  const packageLinks = visibleLinks.filter(link => link.kind === 'sdk-install');
  const appDeployables = deployables.filter(app => app.kind !== 'package');
  const packageDeployables = deployables.filter(app => app.kind === 'package');
  const linkedIds = new Set(visibleLinks.flatMap(link => [link.source_application_id, link.target_application_id]));
  const isolatedDeployableCount = deployables.filter(app => !linkedIds.has(app.id)).length;
  const hasIntermediaryInsight = insights.some(insight =>
    insight.type === 'bidirectional-message-surface' || insight.type === 'intermediary-topology'
  );
  const runtimeWeight = runtimeLinks.length + (hasIntermediaryInsight ? 2 : 0);
  const packageWeight = packageLinks.length + packageDeployables.length;
  const reasons: string[] = [];
  if (runtimeLinks.length) reasons.push(`${runtimeLinks.length} runtime/application link(s) connect deployables through APIs, messages, streams, or shared data.`);
  if (packageLinks.length) reasons.push(`${packageLinks.length} package/library composition link(s) connect code units through SDK or package dependencies.`);
  if (packageDeployables.length) reasons.push(`${packageDeployables.length} package/library deployable(s) are part of the workspace.`);
  if (hasIntermediaryInsight) reasons.push('Workspace evidence identifies a deployable with both incoming and outgoing communication links.');
  if (isolatedDeployableCount) reasons.push(`${isolatedDeployableCount} deployable(s) are isolated and should not be forced into the system graph.`);
  const staleInputCount = inputs.filter(input => input.analysis_trust.status === 'stale').length;
  const missingInputCount = inputs.filter(input => input.analysis_trust.status === 'missing-required-facts').length;
  const warningInputCount = inputs.filter(input => input.analysis_trust.status === 'warn').length;
  const evidenceQuality: WorkspaceCompositionProfile['evidence_quality'] = missingInputCount > 0 ? 'low'
    : warningInputCount > 0 || staleInputCount > 0 ? 'medium'
      : inputs.length > 0 ? 'high'
        : 'unknown';

  if (runtimeWeight >= 2 && packageWeight >= 2) {
    return {
      kind: 'hybrid-system-and-architecture',
      recommended_primary_view: 'both',
      confidence: 0.84,
      evidence_quality: evidenceQuality,
      stale_input_count: staleInputCount,
      runtime_link_count: runtimeLinks.length,
      package_link_count: packageLinks.length,
      isolated_deployable_count: isolatedDeployableCount,
      app_deployable_count: appDeployables.length,
      package_deployable_count: packageDeployables.length,
      reasons,
    };
  }
  if (runtimeWeight >= 2 || (runtimeLinks.length >= 1 && appDeployables.length >= 2)) {
    return {
      kind: 'interconnected-system',
      recommended_primary_view: 'system-map',
      confidence: runtimeWeight >= 3 ? 0.86 : 0.74,
      evidence_quality: evidenceQuality,
      stale_input_count: staleInputCount,
      runtime_link_count: runtimeLinks.length,
      package_link_count: packageLinks.length,
      isolated_deployable_count: isolatedDeployableCount,
      app_deployable_count: appDeployables.length,
      package_deployable_count: packageDeployables.length,
      reasons,
    };
  }
  if (packageLinks.length > 0 && appDeployables.length > 0) {
    return {
      kind: 'composed-application-architecture',
      recommended_primary_view: 'architecture-map',
      confidence: 0.78,
      evidence_quality: evidenceQuality,
      stale_input_count: staleInputCount,
      runtime_link_count: runtimeLinks.length,
      package_link_count: packageLinks.length,
      isolated_deployable_count: isolatedDeployableCount,
      app_deployable_count: appDeployables.length,
      package_deployable_count: packageDeployables.length,
      reasons,
    };
  }
  if (packageDeployables.length > 0 && packageDeployables.length >= appDeployables.length) {
    return {
      kind: 'library-collection',
      recommended_primary_view: 'architecture-map',
      confidence: 0.72,
      evidence_quality: evidenceQuality,
      stale_input_count: staleInputCount,
      runtime_link_count: runtimeLinks.length,
      package_link_count: packageLinks.length,
      isolated_deployable_count: isolatedDeployableCount,
      app_deployable_count: appDeployables.length,
      package_deployable_count: packageDeployables.length,
      reasons,
    };
  }
  return {
    kind: 'disconnected-collection',
    recommended_primary_view: 'inventory',
    confidence: deployables.length <= 1 ? 0.7 : 0.64,
    evidence_quality: evidenceQuality,
    stale_input_count: staleInputCount,
    runtime_link_count: runtimeLinks.length,
    package_link_count: packageLinks.length,
    isolated_deployable_count: isolatedDeployableCount,
    app_deployable_count: appDeployables.length,
    package_deployable_count: packageDeployables.length,
    reasons: reasons.length ? reasons : ['No strong runtime or package composition links were found in the workspace-level CAS input facts.'],
  };
}
function analysisTrust(cas: CASOutput): WorkspaceAnalysisTrust {
  const reasons = [];
  const diagnostics = partitionAnalysisDiagnostics(cas.analysis_errors);
  if (!cas.analysis_id) reasons.push('CAS analysis id is missing.');
  if (!cas.analysis_timestamp) reasons.push('CAS analysis timestamp is missing.');
  if (!cas.cas_version) reasons.push('CAS version is missing.');
  if (!cas.nodes?.length) reasons.push('CAS has no nodes.');
  if (!cas.entry_points?.length && !cas.exit_points?.length) reasons.push('CAS has no entry or exit points.');
  if (diagnostics.errors.length > 0) reasons.push(`${diagnostics.errors.length} analyzer error(s) were reported.`);
  if (diagnostics.warnings.length > 0) reasons.push(`${diagnostics.warnings.length} analyzer warning(s) were reported.`);
  const hasTimestamp = Boolean(cas.analysis_timestamp);
  return {
    status: reasons.some(reason => /no nodes|missing/i.test(reason)) ? 'missing-required-facts' : reasons.length ? 'warn' : 'ready',
    freshness: hasTimestamp ? 'fresh' : 'unknown',
    confidence: Math.max(0.2, 1 - reasons.length * 0.16),
    reasons: reasons.length ? reasons : ['CAS input has required identity, timestamp, graph, and interface facts.'],
  };
}
function unknownOwnership(): WorkspaceOwnership {
  return {
    owner_source: 'unknown',
    owners: [],
    lifecycle: 'unknown',
    tier: 'unknown',
  };
}

function buildWorkspaceOwnership(
  applications: SystemApplication[],
  codebases: SystemCodebase[],
  repositories: CrossCodebaseInput[],
): Record<string, WorkspaceOwnership> {
  const repositoryById = new Map(repositories.map(repository => [codebaseId(repository.path), repository]));
  const codebaseById = new Map(codebases.map(codebase => [codebase.id, codebase]));
  const result: Record<string, WorkspaceOwnership> = {};
  for (const app of applications) {
    const repository = repositoryById.get(app.codebase_id);
    const metadata = (repository?.cas.system?.metadata || {}) as Record<string, any>;
    const owners = normalizeOwnerList(metadata.owners || metadata.owner || metadata.maintainers || metadata.team);
    const inferredTeam = String(metadata.team || metadata.owner_team || '').trim() || undefined;
    const productArea = String(metadata.product_area || metadata.domain || '').trim() || undefined;
    result[app.id] = {
      owner_source: owners.length || inferredTeam ? 'repository-metadata' : 'unknown',
      team: inferredTeam,
      owners,
      product_area: productArea,
      lifecycle: inferLifecycle(app, repository),
      tier: inferTier(app, codebaseById.get(app.codebase_id), repository?.cas),
    };
  }
  return result;
}

function normalizeOwnerList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(item => String(item).trim()).filter(Boolean);
  return String(value || '').split(/[,;]/).map(item => item.trim()).filter(Boolean);
}

function inferLifecycle(app: SystemApplication, repository: CrossCodebaseInput | undefined): WorkspaceOwnership['lifecycle'] {
  const text = `${app.name} ${app.path_hint || ''} ${repository?.path || ''}`.toLowerCase();
  if (/archive|legacy|old|deprecated/.test(text)) return 'archived';
  if (/prod|production/.test(text)) return 'production';
  if (/stage|staging/.test(text)) return 'staging';
  if (/demo|poc|prototype|dev|local/.test(text)) return 'development';
  return app.deployable ? 'production' : 'unknown';
}

function inferTier(app: SystemApplication, codebase: SystemCodebase | undefined, cas: CASOutput | undefined): WorkspaceOwnership['tier'] {
  const text = `${app.name} ${codebase?.system_type || ''}`.toLowerCase();
  if (/auth|payment|billing|admin-api|user-api|mcp-api|gateway|coordinator|drop-server|api/.test(text)) return 'critical';
  if ((cas?.change_risks || []).some(risk => risk.risk_level === 'critical' || risk.risk_level === 'high')) return 'important';
  if (/demo|poc|test|fixture/.test(text)) return 'experimental';
  return app.deployable ? 'important' : 'supporting';
}

function buildWorkspaceActivity(repositories: CrossCodebaseInput[], applications: SystemApplication[]): WorkspaceActivitySummary {
  const appByNode = new Map<string, SystemApplication>();
  for (const repository of repositories) {
    const id = codebaseId(repository.path);
    const apps = applications.filter(app => app.codebase_id === id);
    for (const node of repository.cas.nodes || []) {
      const app = applicationForFile(id, node.source?.file, apps) || apps.find(candidate => candidate.codebase_id === id);
      if (app) appByNode.set(`${id}:${node.id}`, app);
    }
  }
  const stability = repositories.flatMap(repository =>
    (repository.cas.temporal_stability || []).map(item => ({ repository, item }))
  );
  const commits30 = stability.reduce((sum, entry) => sum + (entry.item.churn_metrics?.commits_30d || 0), 0);
  const commits90 = stability.reduce((sum, entry) => sum + (entry.item.churn_metrics?.commits_90d || 0), 0);
  const authors30 = stability.reduce((sum, entry) => sum + (entry.item.churn_metrics?.unique_authors_30d || 0), 0);
  const lines30 = stability.reduce((sum, entry) => sum + (entry.item.churn_metrics?.lines_changed_30d || 0), 0);
  const hotspots = stability
    .filter(entry => ['volatile', 'fragile'].includes(entry.item.stability_class) || (entry.item.churn_metrics?.commits_30d || 0) > 0)
    .sort((left, right) => activityScore(right.item) - activityScore(left.item))
    .slice(0, 20)
    .map(entry => {
      const id = codebaseId(entry.repository.path);
      const app = appByNode.get(`${id}:${entry.item.node_id}`);
      return {
        project_id: id,
        deployable_id: app?.id,
        node_id: entry.item.node_id,
        label: entry.item.node_id,
        reason: `${entry.item.stability_class} stability, ${entry.item.churn_metrics?.commits_30d || 0} commits/30d, ${entry.item.churn_metrics?.lines_changed_30d || 0} lines changed/30d`,
        score: activityScore(entry.item),
      };
    });
  const contributors = repositories.flatMap(repository => {
    const metadata = (repository.cas.system?.metadata || {}) as Record<string, any>;
    return normalizeOwnerList(metadata.contributors || metadata.owners || metadata.maintainers).map(name => ({
      name,
      projects: [codebaseId(repository.path)],
      source: 'cas' as const,
    }));
  });
  return {
    status: stability.length ? commits30 > 0 ? 'active' : 'quiet' : 'unknown',
    change_rate: commits30 >= 30 || lines30 >= 5000 ? 'high' : commits30 >= 8 || lines30 >= 1000 ? 'medium' : stability.length ? 'low' : 'unknown',
    commits_30d: commits30,
    commits_90d: commits90,
    unique_authors_30d: authors30,
    lines_changed_30d: lines30,
    hotspots,
    contributors: dedupeContributors(contributors),
  };
}

function activityScore(item: CASTemporalStability): number {
  return (item.churn_metrics?.commits_30d || 0) * 4 +
    (item.churn_metrics?.unique_authors_30d || 0) * 2 +
    Math.ceil((item.churn_metrics?.lines_changed_30d || 0) / 100) +
    (item.stability_class === 'fragile' ? 25 : item.stability_class === 'volatile' ? 15 : 0);
}

function dedupeContributors(contributors: WorkspaceActivitySummary['contributors']): WorkspaceActivitySummary['contributors'] {
  const byName = new Map<string, WorkspaceActivitySummary['contributors'][number]>();
  for (const contributor of contributors) {
    const existing = byName.get(contributor.name);
    byName.set(contributor.name, existing ? {
      ...existing,
      projects: mergeStrings(existing.projects, contributor.projects).sort(),
    } : contributor);
  }
  return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name)).slice(0, 40);
}

function buildWorkspaceTelemetry(repositories: CrossCodebaseInput[], applications: SystemApplication[]): WorkspaceTelemetrySummary {
  const appByStaticId = new Map<string, SystemApplication>();
  for (const repository of repositories) {
    const id = codebaseId(repository.path);
    const apps = applications.filter(app => app.codebase_id === id);
    for (const node of repository.cas.nodes || []) {
      const app = applicationForFile(id, node.source?.file, apps);
      if (app) appByStaticId.set(`${id}:${node.id}`, app);
    }
  }
  const links = repositories.flatMap(repository =>
    (repository.cas.runtime_static_links || []).map(link => ({ repository, link }))
  );
  const observed = links.filter(item => item.link.telemetry_status === 'observed');
  const instrumentable = links.filter(item => item.link.telemetry_status === 'instrumentable');
  const notInstrumented = links.filter(item => item.link.telemetry_status === 'not-instrumented');
  const hotSignals = links
    .filter(item => item.link.telemetry_status === 'observed' || item.link.telemetry_status === 'instrumentable')
    .slice(0, 20)
    .map(item => {
      const projectId = codebaseId(item.repository.path);
      const app = appByStaticId.get(`${projectId}:${item.link.static_id}`);
      return {
        project_id: projectId,
        deployable_id: app?.id,
        static_id: item.link.static_id,
        signal: item.link.runtime_signal,
        source: 'cas-runtime-link' as const,
      };
    });
  const status: WorkspaceTelemetrySummary['status'] = observed.length ? 'observed'
    : instrumentable.length ? 'instrumentable'
      : notInstrumented.length ? 'not-instrumented'
        : 'not-configured';
  return {
    status,
    observed_links: observed.length,
    instrumentable_links: instrumentable.length,
    not_instrumented_links: notInstrumented.length,
    hot_signals: hotSignals,
    guidance: status === 'observed'
      ? ['Use runtime observations and operational priorities before selecting production bug work.']
      : status === 'instrumentable'
        ? ['Runtime hooks are instrumentable but not observed yet; add SDK ingestion before claiming production impact.']
        : ['No production telemetry is available at workspace level yet; rely on static CAS evidence and mark runtime impact unknown.'],
  };
}

function buildWorkspaceDomains(
  repositories: CrossCodebaseInput[],
  codebases: SystemCodebase[],
  workspaceName: string,
): WorkspaceDomain[] {
  const terminalProfiles = buildWorkspaceTerminalProfiles(repositories);
  const infrastructureProjectIds = new Set(repositories
    .filter(repository => repository.cas.enhanced_system_purpose?.artifact_type === 'infrastructure')
    .map(repository => codebaseId(repository.path)));
  const domains = new Map<string, { project_ids: string[]; evidence: string[]; score: number; terminal_score: number; terminal_evidence: string[] }>();
  const productNames = workspaceProductNameSet(codebases, workspaceName);
  const add = (name: string | undefined, projectId: string, evidence: string, score = 1, terminalScore = 0, terminalEvidence: string[] = []) => {
    const normalized = titleizeDomain(name);
    if (!normalized || isWeakWorkspaceDomain(normalized)) return;
    const existing = domains.get(normalized) || { project_ids: [], evidence: [], score: 0, terminal_score: 0, terminal_evidence: [] };
    existing.project_ids = mergeStrings(existing.project_ids, [projectId]);
    existing.evidence = mergeStrings(existing.evidence, [evidence]).slice(0, 8);
    existing.score += score;
    existing.terminal_score += terminalScore;
    existing.terminal_evidence = mergeStrings(existing.terminal_evidence, terminalEvidence).slice(0, 8);
    domains.set(normalized, existing);
  };
	  for (const repository of repositories) {
	    const projectId = codebaseId(repository.path);
	    const terminalProfile = terminalProfiles.get(projectId) || emptyTerminalSemanticProfile(projectId);
    const enhanced = repository.cas.enhanced_system_purpose as any;
    if (enhanced?.primary_domain) {
      add(enhanced.primary_domain, projectId, `primary_domain:${enhanced.primary_domain}`, 4, 4, [`primary_domain:${enhanced.primary_domain}`]);
    }

    if (infrastructureProjectIds.has(projectId)) continue;
    for (const concept of enhanced?.core_concepts || []) {
      add(concept, projectId, `core_concept:${concept}`, 2, 0, []);
    }
    for (const concept of repository.cas.domain_concepts || []) {
      const signal = terminalSignalForName(terminalProfile, concept.name);

      if (!isEvidenceGroundedWorkspaceDomainConcept(concept as any, directTerminalNameScore(terminalProfile, concept.name))) continue;
      add(concept.name, projectId, `domain_concept:${concept.id || concept.name}`, concept.classification === 'core' ? 4 : 3, signal.score, signal.evidence);
    }
    for (const capability of repository.cas.capabilities || []) {
      const signal = terminalSignalForCapability(terminalProfile, capability as any);
      for (const domain of capability.related_domains || []) add(domain, projectId, `capability:${capability.name}`, 2, Math.min(8, signal.score / 2), signal.evidence);
    }
	    for (const entity of repository.cas.entities || []) {
	      const signal = terminalSignalForName(terminalProfile, entity.name);
	      add((entity as any).domain || entity.name, projectId, `entity:${entity.name}`, 1, signal.score, signal.evidence);
	    }
	  }
  const entityNames = workspaceEntityNameSet(repositories);
  return collapseOverlappingWorkspaceDomains([...domains.entries()], productNames)

    .filter(([name]) => !productNames.has(normalizeAiItemName(name)))

    .filter(([, value]) => hasWorkspaceDomainEvidence(value))

    .filter(([name, value]) => !isUncorroboratedEntityNameDomain(name, value, entityNames))
    .filter(([name]) => !isVerbPhraseDomainLabel(name))
    .sort((left, right) =>
      workspaceDomainSortScore(right[0], right[1], productNames) -
        workspaceDomainSortScore(left[0], left[1], productNames) ||
      left[0].localeCompare(right[0])
    )

    .slice(0, 16)
    .map(([name, value]) => ({
      name,

      description: '',
      project_ids: value.project_ids,
      evidence: value.evidence,
      semantic_role: value.project_ids.length > 0 && value.project_ids.every(projectId => infrastructureProjectIds.has(projectId))
        ? 'infrastructure'
        : value.terminal_score >= 8 ? semanticRoleFromTerminalScore(value.terminal_score, 'core') : undefined,
      terminal_score: roundTerminalScore(value.terminal_score),
      terminal_evidence: value.terminal_evidence,
      confidence: Math.min(0.92, 0.45 + value.score * 0.08),
      description_source: 'ai-required-degraded' as const,
      ai_required: true as const,
      generation_pass: 'default-summary' as const,
      degraded_reason: 'Whole-workspace domain descriptions require default interpretation from deterministic workspace-level CAS facts.',
    }));
}

function isEvidenceGroundedWorkspaceDomainConcept(
  concept: { appears_in?: { entry_points?: string[]; entities?: string[]; nodes?: string[] } },
  terminalScore: number,
): boolean {
  const appearsIn = concept?.appears_in;
  if (!appearsIn) return true;
  if ((appearsIn.entities || []).length > 0) return true;
  if ((appearsIn.entry_points || []).some(id => !isFileBasenameEntryPointId(id))) return true;
  return terminalScore >= 8;
}

function isFileBasenameEntryPointId(id: unknown): boolean {
  return /^entry_file_/.test(String(id || ''));
}

function hasWorkspaceDomainEvidence(value: { evidence?: string[]; terminal_score?: number }): boolean {
  const evidence = value.evidence || [];
  if (evidence.some(item => /^(primary_domain|project_domain|crypto_anchor|capability|capability_domain|deployable):/.test(item))) return true;
  const terminalScore = value.terminal_score || 0;
  if (terminalScore <= 0) return false;
  return evidence.some(item => item.startsWith('entity:') || item.startsWith('core_concept:'));
}

function workspaceEntityNameSet(repositories: CrossCodebaseInput[]): Set<string> {
  const names = new Set<string>();
  for (const repository of repositories) {
    for (const entity of repository.cas.entities || []) {
      const normalized = normalizeAiItemName(String((entity as any).name || ''));
      if (normalized) names.add(normalized);
    }
  }
  return names;
}

function singularizeDomainKey(value: string): string {
  if (/[a-z]ies$/.test(value)) return `${value.slice(0, -3)}y`;

  if (/(ches|shes|sses|xes|zes)$/.test(value)) return value.slice(0, -2);
  return value.endsWith('s') && !value.endsWith('ss') ? value.slice(0, -1) : value;
}

function isSelfEchoCapabilityForDomain(capabilityName: string, domainNormalized: string): boolean {
  const stripped = normalizeAiItemName(capabilityName)
    .replace(/^(?:manage|manages|managing|surface|surfaces|track|tracks|monitor|monitors|handle|handles|create|creates|provide|provides|analyze|analyzes|configure|configures|list|lists|get|gets|update|updates|store|stores|process|processes|generate|generates|expose|exposes|maintain|maintains)\s+/, '')
    .trim();
  const capKey = singularizeDomainKey(stripped.replace(/\s+/g, ''));
  const domKey = singularizeDomainKey(domainNormalized.replace(/\s+/g, ''));
  return capKey.length > 0 && capKey === domKey;
}

export function isUncorroboratedEntityNameDomain(
  name: string,
  value: { evidence?: string[] },
  entityNames: Set<string>,
): boolean {
  const normalized = normalizeAiItemName(name);
  if (!normalized) return false;

  const collapsed = normalized.replace(/\s+/g, '');
  const nameKeys = new Set([
    normalized,
    collapsed,
    singularizeDomainKey(normalized),
    singularizeDomainKey(collapsed),
  ]);
  const matchesEntityName = [...nameKeys].some(key => entityNames.has(key));
  const looksLikeClassIdentifier = /[a-z][A-Z]/.test(String(name || '').replace(/\s+/g, ''));
  if (!matchesEntityName && !(looksLikeClassIdentifier && normalized.split(/\s+/).length === 1)) return false;

  const evidence = value.evidence || [];
  const corroborated =
    evidence.some(item => /^(primary_domain|project_domain|crypto_anchor|core_concept):/.test(item)) ||
    evidence.some(item => {
      const match = item.match(/^(?:capability|capability_domain):(.*)$/);
      return Boolean(match) && !isSelfEchoCapabilityForDomain(match![1], normalized);
    });
  return !corroborated;
}

export function isVerbPhraseDomainLabel(name: string): boolean {
  const tokens = normalizeAiItemName(name).split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return false;
  const leading = tokens[0];

  if (/^(?:send|sends|list|lists|get|gets|view|views|access|accesses|create|creates|delete|deletes|manage|manages|handle|handles|fetch|fetches|build|builds|run|runs|execute|executes|process|processes|load|loads|save|saves|read|reads|write|writes|add|adds|remove|removes|check|checks|validate|validates|parse|parses|render|renders|receive|receives|start|starts|stop|stops|sync|syncs|track|tracks|monitor|monitors|generate|generates|compute|computes|calculate|calculates|provide|provides|expose|exposes|register|registers|configure|configures|update|updates|surface|surfaces|analyze|analyzes|analyse|analyses|transcribe|transcribes|approve|approves|spawn|spawns|search|searches|ingest|ingests|transform|transforms|index|indexes|map|maps|define|defines|coordinate|coordinates|deploy|deploys|install|installs|connect|connects|collect|collects|record|records|enforce|enforces|integrate|integrates|audit|audits|examine|examines|identify|identifies|assess|assesses|detect|detects|discover|discovers|retrieve|retrieves|import|imports|export|exports|route|routes|dispatch|dispatches|orchestrate|orchestrates|describe|describes|poll|polls|secures|alter|alters|notify|notifies|publish|publishes|subscribe|subscribes|resolve|resolves|aggregate|aggregates|submit|submits|upload|uploads|download|downloads|emit|emits|broadcast|broadcasts|replicate|replicates|migrate|migrates|encrypt|encrypts|decrypt|decrypts|persist|persists|verify|verifies)$/.test(leading)) {
    return true;
  }

  if (leading.length >= 4 && /es$/.test(leading) && !/(?:ss|ies)$/.test(leading) && !PLURAL_ES_NOUN_DOMAIN_HEADS.has(leading)) {
    return true;
  }
  return false;
}

const PLURAL_ES_NOUN_DOMAIN_HEADS = new Set([
  'devices', 'services', 'databases', 'instances', 'resources', 'interfaces',
  'namespaces', 'workspaces', 'pipelines', 'invoices', 'notes', 'roles', 'types',
  'templates', 'routes', 'sources', 'images', 'packages', 'releases', 'features',
  'issues', 'queues', 'caches', 'nodes', 'edges', 'files', 'stages', 'phases',
  'preferences', 'appliances', 'balances', 'licenses', 'warehouses', 'purchases',
]);

function collapseOverlappingWorkspaceDomains(
  entries: Array<[string, { project_ids: string[]; evidence: string[]; score: number; terminal_score: number; terminal_evidence: string[] }]>,
  productNames: Set<string>,
): Array<[string, { project_ids: string[]; evidence: string[]; score: number; terminal_score: number; terminal_evidence: string[] }]> {
  const byName = new Map(entries.map(([name, value]) => [name, { ...value }]));
  const ordered = [...entries].sort((left, right) =>
    workspaceDomainSortScore(right[0], right[1], productNames) -
      workspaceDomainSortScore(left[0], left[1], productNames)
  );
  for (const [name] of ordered) {
    const value = byName.get(name);
    if (!value) continue;
    const target = ordered
      .filter(([candidateName]) => candidateName !== name && byName.has(candidateName))
      .find(([candidateName]) =>
        shouldCollapseWorkspaceDomainInto(name, value, candidateName, byName.get(candidateName)!)
      );
    if (!target) continue;
    const targetValue = byName.get(target[0]);
    if (!targetValue) continue;
    targetValue.project_ids = mergeStrings(targetValue.project_ids, value.project_ids);
    targetValue.evidence = mergeStrings(targetValue.evidence, value.evidence).slice(0, 12);
    targetValue.score += Math.max(0, value.score * 0.25);
    targetValue.terminal_score = Math.max(targetValue.terminal_score || 0, value.terminal_score || 0);
    targetValue.terminal_evidence = mergeStrings(targetValue.terminal_evidence, value.terminal_evidence).slice(0, 10);
    byName.delete(name);
  }
  return [...byName.entries()]
    .filter(([name, value]) => !(isGenericWorkspaceDomainBucket(name) && (value.terminal_score || 0) < 16));
}

function shouldCollapseWorkspaceDomainInto(
  name: string,
  value: { score: number; terminal_score?: number; evidence?: string[] },
  candidateName: string,
  candidateValue: { score: number; terminal_score?: number; evidence?: string[] },
): boolean {
  const tokens = workspaceDomainTokens(name);
  const candidateTokens = workspaceDomainTokens(candidateName);
  if (tokens.size === 0) return false;
  const sameSemanticName = tokens.size === candidateTokens.size && [...tokens].every(token => candidateTokens.has(token));
  if (sameSemanticName) {
    const sourceIsPrimary = (value.evidence || []).some(item => item.startsWith('primary_domain:'));
    const candidateIsPrimary = (candidateValue.evidence || []).some(item => item.startsWith('primary_domain:'));
    if (sourceIsPrimary !== candidateIsPrimary) return candidateIsPrimary;
    return candidateValue.score >= value.score || (candidateValue.terminal_score || 0) >= (value.terminal_score || 0) || candidateName.length >= name.length;
  }
  const sourceIsPrimary = (value.evidence || []).some(item => item.startsWith('primary_domain:'));
  if (sourceIsPrimary) return false;
  if (isVerbPhraseDomainLabel(candidateName)) return false;
  if (candidateTokens.size <= tokens.size) return false;
  const isSubset = [...tokens].every(token => candidateTokens.has(token));
  if (!isSubset) return false;
  const candidateIsStrong = (candidateValue.terminal_score || 0) >= (value.terminal_score || 0) ||
    candidateValue.score >= value.score ||
    (candidateValue.evidence || []).some(item => item.startsWith('primary_domain:') || item.startsWith('project_domain:'));
  return candidateIsStrong || tokens.size === 1;
}

function workspaceDomainTokens(name: string): Set<string> {
  const stop = new Set(['application', 'domain', 'enterprise', 'management', 'platform', 'service', 'services', 'system', 'workspace']);
  return new Set(normalizeAiItemName(String(name || '').replace(/([a-z0-9])([A-Z])/g, '$1 $2'))
    .split(/\s+/)
    .map(token => token.replace(/^(?:application|enterprise|platform|service|system|workspace)(?=.{4,})/, ''))
    .map(token => token.endsWith('s') && !token.endsWith('ss') ? token.slice(0, -1) : token)
    .filter(token => token.length >= 4 && !stop.has(token)));
}

function isGenericWorkspaceDomainBucket(name: string): boolean {
  return /^(analyzer|analyzers|application|applications|enterprise|platform|package|packages|dependency|dependencies|library|libraries|module|modules|project|projects|app|apps|service|services|system|systems|data|config|configuration)$/i.test(name.trim());
}

function workspaceProductNameSet(codebases: SystemCodebase[], workspaceName: string): Set<string> {
  const names = [workspaceName, ...codebases.map(codebase => codebase.name), ...codebases.map(codebase => path.basename(codebase.path || ''))]
    .map(name => normalizeAiItemName(name))
    .filter(Boolean);
  const tokenCounts = new Map<string, number>();
  for (const codebase of codebases) {
    for (const token of String(codebase.name || '').split(/[^a-zA-Z0-9]+/).filter(Boolean)) {
      const normalized = normalizeAiItemName(token);
      if (normalized.length < 4) continue;
      tokenCounts.set(normalized, (tokenCounts.get(normalized) || 0) + 1);
    }
    for (const packageName of codebase.packages || []) {
      const packageScope = String(packageName || '').replace(/^@/, '').split('/')[0];
      const normalizedScope = normalizeAiItemName(packageScope);
      if (normalizedScope.length >= 4) names.push(normalizedScope);
      for (const token of normalizeAiItemName(packageName).split(/\s+/)) {
        if (token.length >= 4) tokenCounts.set(token, (tokenCounts.get(token) || 0) + 1);
      }
    }
  }
  for (const [token, count] of tokenCounts.entries()) {
    if (count >= Math.max(2, Math.ceil(codebases.length * 0.2))) names.push(token);
  }
  return new Set(names);
}

function workspaceDomainSortScore(
  _name: string,
  value: { score: number; evidence?: string[]; terminal_score?: number; terminal_evidence?: string[] },
  _productNames: Set<string>,
): number {
  const evidence = value.evidence || [];
  const authoredPurpose = evidence.some(item => item.startsWith('primary_domain:') || item.startsWith('project_domain:'));
  const structuralEvidence = evidence.filter(item => /^(entity|capability|domain_concept):/.test(item)).length;
  return value.score + Math.max(0, value.terminal_score || 0) * 2 + Number(authoredPurpose) * 30 + Math.min(18, structuralEvidence * 3);
}

function isWeakWorkspaceDomain(name: string): boolean {
  const normalized = name.toLowerCase().trim();
  if (!normalized) return true;
  if (/[<>]/.test(name) || /&lt;|&gt;/.test(normalized)) return true;

  if (/[\[\](){}|]/.test(name)) return true;
  if (/^(command|commands|event|events|route|routes|handler|handlers)\b/.test(normalized)) return true;
  if (/^(url|uri|id|uuid|data|info|item|items|value|values|type|types|status|state|config|configuration|generate|create|read|update|delete|list|find|get|set|sync|process|execute|handle|manage|service|api|app|system|days|password|port|server|issue|issues|result|results|snapshot|snapshots)$/.test(normalized)) return true;

  if (/^(auto|automated|page|pages|preview|view|views|collect|draft|untitled|sample|demo|example|default|index|main|util|utils|helper|helpers|mock|mocks|misc|temp|todo|linq|alert|summary|summaries)$/.test(normalized)) return true;
  if (/^(enterprise|platform|application|typescript|javascript|node|nodejs|python|java|kotlin|scala|dotnet|\.net|csharp|rust|golang|go|php|ruby|dart|flutter|swift|objective c|cpp|c\+\+|terraform|docker|kubernetes|react|angular|vue|svelte|express|fastapi|django|flask|laravel|spring|nestjs|aspnet|framework|frameworks)$/.test(normalized)) return true;
  if (normalized.split(/\s+/).length === 1 && normalized.length < 4) return true;
  return false;
}

function buildWorkspaceCapabilities(
  repositories: CrossCodebaseInput[],
  applications: SystemApplication[],
  lookupIndexes: Map<CASOutput, CrossCodebaseLookupIndex>,
  childTerminalityByCodebase: Map<string, CASTerminality['nodes'][number]>,
  childrenByCodebase: Map<string, CASOutput>,
): WorkspaceCapability[] {
  const terminalProfiles = buildWorkspaceTerminalProfiles(repositories);
  const appByEntry = new Map<string, SystemApplication>();
  for (const repository of repositories) {
    const id = codebaseId(repository.path);
    const apps = applications.filter(app => app.codebase_id === id);
    const appByProjectId = new Map(apps.map(app => [app.id, app]));
    const lookupIndex = lookupIndexes.get(repository.cas)!;
    for (const entry of repository.cas.entry_points || []) {
      const refs = entryRefs(lookupIndex, entry);
      const app = refs.map(ref => applicationForFileFromIndex(id, ref.file, appByProjectId)).find(Boolean) ||
        (apps.length === 1 ? apps[0] : undefined);
      if (app) appByEntry.set(`${id}:${entry.id}`, app);
    }
  }
  const capabilities: WorkspaceCapability[] = [];
  for (const repository of repositories) {
    const projectId = codebaseId(repository.path);
    const infrastructureArtifact = repository.cas.enhanced_system_purpose?.artifact_type === 'infrastructure';
    const terminalProfile = terminalProfiles.get(projectId) || emptyTerminalSemanticProfile(projectId);
    const compositionMember = childTerminalityByCodebase.get(projectId);
    if (!compositionMember) continue;
    const sourceChild = childrenByCodebase.get(projectId);
    const entryPointsById = new Map((repository.cas.entry_points || []).map(entry => [entry.id, entry]));
    for (const capability of repository.cas.capabilities || []) {
      const apps = capability.operations
        .map(operation => appByEntry.get(`${projectId}:${operation.entry_point_id}`))
        .filter(Boolean) as SystemApplication[];
      const terminalSignal = terminalSignalForCapability(terminalProfile, capability as any);
      const capabilityCategory = String((capability as any).category || (capability as any).classification || '').toLowerCase();
      const fallbackRole: WorkspaceSemanticRole = capabilityCategory === 'core' || capabilityCategory === 'primary'
        ? 'core'
        : capabilityCategory === 'infrastructure'
          ? 'infrastructure'
          : 'supporting';
      const evidence = [
        ...(capability.related_domains || []).map(domain => `domain:${domain}`),
        ...(capability.related_entities || []).map(entity => `entity:${entity}`),
        ...(capability.operations || []).map(operation => `${operation.action}:${operation.path_or_command || operation.entry_point_id}`),
      ].slice(0, 10);
      const infrastructureOnly = infrastructureArtifact || capability.evidence_kind === 'infrastructure' || capability.category === 'internal';
      const semanticRole = infrastructureOnly || !compositionMember.terminal
        ? 'infrastructure'
        : semanticRoleFromTerminalScore(terminalSignal.score, fallbackRole);
      const deployableIds = [...new Set(apps.map(app => app.id))];
      const repoAiDescriptionReady = (capability as any).description_source === 'ai' &&
        isGroundedAiWorkspaceItemDescription({
          id: `${projectId}:capability:${slugify(capability.id || capability.name)}`,
          name: capability.name,
          description: capability.description,
          description_source: 'ai',
          ai_required: true,
          generation_pass: 'default-summary',
          semantic_role: semanticRole,
          terminal_score: roundTerminalScore(infrastructureOnly || !compositionMember.terminal ? Math.min(0, terminalSignal.score) : terminalSignal.score),
          terminal_evidence: infrastructureOnly ? mergeStrings(terminalSignal.evidence, ['infrastructure-only-evidence']).slice(0, 10) : terminalSignal.evidence,
          project_ids: [projectId],
          deployable_ids: deployableIds,
          criticality: capability.criticality,
          evidence,
        }, capability.description, 'capability');
      const workspaceCapabilityId = `${projectId}:capability:${slugify(capability.id || capability.name)}`;
      const compositionProvenance = buildWorkspaceCapabilityProvenance(repository.cas, sourceChild!, capability, compositionMember, entryPointsById);
      capabilities.push({
        id: workspaceCapabilityId,
        name: capability.name,
        description: capability.description,
        description_source: repoAiDescriptionReady ? 'ai' : 'ai-required-degraded',
        ai_required: true,
        generation_pass: 'default-summary',
        degraded_reason: repoAiDescriptionReady ? undefined :
          'Whole-workspace capability descriptions require grounded interpretation from deterministic workspace-level CAS facts.',
        semantic_role: semanticRole,
        terminal_score: roundTerminalScore(infrastructureOnly || !compositionMember.terminal ? Math.min(0, terminalSignal.score) : terminalSignal.score),
        terminal_evidence: infrastructureOnly ? mergeStrings(terminalSignal.evidence, ['infrastructure-only-evidence']).slice(0, 10) : terminalSignal.evidence,
        project_ids: [projectId],
        deployable_ids: deployableIds,
        criticality: capability.criticality,
        evidence,
        source_capability_ids: [workspaceCapabilityId],
        composition_provenance: compositionProvenance,
      });
    }
  }
  return dedupeWorkspaceCapabilities(capabilities).slice(0, 30);
}

function dedupeWorkspaceCapabilities(capabilities: WorkspaceCapability[]): WorkspaceCapability[] {
  const byName = new Map<string, WorkspaceCapability>();
  for (const capability of capabilities) {
    const key = capability.name.toLowerCase();
    const existing = byName.get(key);
    byName.set(key, existing ? {
      ...existing,
      project_ids: mergeStrings(existing.project_ids, capability.project_ids),
      deployable_ids: mergeStrings(existing.deployable_ids, capability.deployable_ids),
      evidence: mergeStrings(existing.evidence, capability.evidence).slice(0, 12),
	  source_capability_ids: mergeStrings(existing.source_capability_ids || [existing.id], capability.source_capability_ids || [capability.id]),
      composition_provenance: mergeWorkspaceCapabilityProvenance(existing.composition_provenance, capability.composition_provenance),
	    criticality: criticalityRank(capability.criticality) > criticalityRank(existing.criticality) ? capability.criticality : existing.criticality,
	      semantic_role: strongerSemanticRole(existing.semantic_role, capability.semantic_role),
	      terminal_score: Math.max(existing.terminal_score || 0, capability.terminal_score || 0),
	      terminal_evidence: mergeStrings(existing.terminal_evidence || [], capability.terminal_evidence || []).slice(0, 8),
	    } : capability);
	  }
	  return [...byName.values()]
      .sort((left, right) => workspaceCapabilityRank(right) - workspaceCapabilityRank(left) || left.name.localeCompare(right.name));
	}

function workspaceCapabilityRank(capability: WorkspaceCapability): number {
  let score = criticalityRank(capability.criticality) * 24;
  score += Math.min(18, capability.deployable_ids.length * 4);
  score += Math.min(14, capability.project_ids.length * 2);
	  score += capability.evidence.some(item => item.startsWith('entity:')) ? 10 : 0;
	  score += Math.min(34, Math.max(0, capability.terminal_score || 0) * 2);
	  if (capability.semantic_role === 'core') score += 22;
	  if (capability.semantic_role === 'infrastructure') score -= 18;
  if (capability.description_source === 'ai') score += 14;
  return score;
}

function buildWorkspaceEntities(
  repositories: CrossCodebaseInput[],
  applications: SystemApplication[],
  capabilities: WorkspaceCapability[],
  workflows: WorkspaceWorkflow[],
  dataFlowPaths: SystemDataFlowPath[],
): { entities: WorkspaceEntity[]; paths: WorkspaceEntityPath[] } {
  const terminalProfiles = buildWorkspaceTerminalProfiles(repositories);
  const appByNode = new Map<string, SystemApplication>();
  const appById = new Map(applications.map(app => [app.id, app]));
  const nodeFileById = new Map<string, string | undefined>();
  for (const repository of repositories) {
    const projectId = codebaseId(repository.path);
    const apps = applications.filter(app => app.codebase_id === projectId);
    for (const node of repository.cas.nodes || []) {
      nodeFileById.set(`${projectId}:${node.id}`, node.source?.file);
      const app = applicationForFile(projectId, node.source?.file, apps);
      if (app) appByNode.set(`${projectId}:${node.id}`, app);
    }
  }

  const entities = new Map<string, WorkspaceEntity>();
  const paths: any[] = [];
  const ensure = (entityName: string): WorkspaceEntity => {
    const key = slugify(entityName);
    const existing = entities.get(key);
    if (existing) return existing;
    const entity: WorkspaceEntity = {
      id: `workspace-entity:${key}`,
      name: entityName,
      project_ids: [],
      entity_refs: [],
      related_capability_ids: [],
      related_workflow_ids: [],
      related_data_flow_path_ids: [],
      sensitive_fields: [],
      lifecycle: {
        created_by: 0,
        read_by: 0,
        updated_by: 0,
        deleted_by: 0,
        external_recipients: 0,
        boundaries_crossed: 0,
      },
      evidence: [],
      confidence: 0.55,
    };
    entities.set(key, entity);
    return entity;
  };

  for (const repository of repositories) {
    const projectId = codebaseId(repository.path);
    const terminalProfile = terminalProfiles.get(projectId) || emptyTerminalSemanticProfile(projectId);
    for (const entity of repository.cas.entities || []) {
      const workspaceEntity = ensure(entity.name);
      const terminalSignal = terminalSignalForName(terminalProfile, entity.name);
      workspaceEntity.project_ids = mergeStrings(workspaceEntity.project_ids, [projectId]);
      workspaceEntity.entity_refs.push({ project_id: projectId, entity_id: entity.id, entity_name: entity.name });
      workspaceEntity.sensitive_fields = mergeStrings(workspaceEntity.sensitive_fields, (entity.fields || []).filter(field => field.is_sensitive).map(field => field.name));
      workspaceEntity.lifecycle.created_by += entity.lifecycle?.created_by?.length || 0;
      workspaceEntity.lifecycle.read_by += entity.lifecycle?.read_by?.length || 0;
      workspaceEntity.lifecycle.updated_by += entity.lifecycle?.updated_by?.length || 0;
      workspaceEntity.lifecycle.deleted_by += entity.lifecycle?.deleted_by?.length || 0;
      workspaceEntity.description = workspaceEntity.description || entity.description;
      workspaceEntity.description_source = workspaceEntity.description_source || entity.description_source as WorkspaceDescriptionSource | undefined;
      workspaceEntity.evidence = mergeStrings(workspaceEntity.evidence, [`${projectId}:entity:${entity.id}`, entity.schema_source || '']).filter(Boolean).slice(0, 12);
      workspaceEntity.semantic_role = strongerSemanticRole(workspaceEntity.semantic_role, semanticRoleFromTerminalScore(terminalSignal.score));
      workspaceEntity.terminal_score = Math.max(workspaceEntity.terminal_score || 0, roundTerminalScore(terminalSignal.score) || 0);
      workspaceEntity.terminal_evidence = mergeStrings(workspaceEntity.terminal_evidence || [], terminalSignal.evidence).slice(0, 8);
      workspaceEntity.confidence = Math.max(workspaceEntity.confidence, entity.schema_source ? 0.82 : 0.68);
    }

    for (const lineage of repository.cas.data_lineage || []) {
      const workspaceEntity = ensure(lineage.entity_name);
      workspaceEntity.project_ids = mergeStrings(workspaceEntity.project_ids, [projectId]);
      workspaceEntity.sensitive_fields = mergeStrings(workspaceEntity.sensitive_fields, lineage.sensitive_fields || []);
      workspaceEntity.lifecycle.external_recipients += lineage.external_recipients?.length || 0;
      workspaceEntity.lifecycle.boundaries_crossed += lineage.boundaries_crossed?.length || 0;
      workspaceEntity.evidence = mergeStrings(workspaceEntity.evidence, [`${projectId}:lineage:${lineage.entity_id}`]).slice(0, 12);
      workspaceEntity.confidence = Math.max(workspaceEntity.confidence, 0.84);
      const via = [
        ...(lineage.writers || []).slice(0, 8).map(accessor => entityPathStep(projectId, accessor.node_id, accessor.file, accessor.via, 'writer', appByNode, nodeFileById)),
        ...(lineage.readers || []).slice(0, 8).map(accessor => entityPathStep(projectId, accessor.node_id, accessor.file, accessor.via, 'reader', appByNode, nodeFileById)),
        ...(lineage.external_recipients || []).slice(0, 6).map(recipient => entityPathStep(projectId, recipient.via_node, undefined, recipient.service, 'external-recipient', appByNode, nodeFileById)),
        ...(lineage.boundaries_crossed || []).slice(0, 6).map(boundary => ({ project_id: projectId, role: 'boundary' as const, label: `${boundary.boundary}:${boundary.guarded ? 'guarded' : 'unguarded'}` })),
      ].filter(step => step.label);
      if (via.length > 0) {
        paths.push({
          id: `workspace-entity-path:${slugify(projectId)}:${slugify(lineage.entity_id)}`,
          entity_name: lineage.entity_name,
          project_ids: [projectId],
          path_type: 'lineage',
          via,
          external_services: (lineage.external_recipients || []).map(recipient => recipient.service),
          boundaries: (lineage.boundaries_crossed || []).map(boundary => ({ boundary: boundary.boundary, guarded: boundary.guarded })),
          sensitive: Boolean(lineage.exposure?.sensitive || lineage.sensitive_fields?.length),
          evidence: [`${projectId}:data_lineage:${lineage.entity_id}`],
          next_mcp_calls: [{ tool: 'get_data_lineage', args: { path: repository.path, entity_id: lineage.entity_id } }],
        });
      }
    }
  }

  addConceptualWorkspaceEntities(entities);

  for (const capability of capabilities) {
    const relatedNames = inferRelatedWorkspaceEntityNames(capability.name, capability.description, capability.evidence, entities);
    for (const entityName of relatedNames) {
      const entity = ensure(entityName);
      entity.related_capability_ids = mergeStrings(entity.related_capability_ids, [capability.id]);
      entity.project_ids = mergeStrings(entity.project_ids, capability.project_ids);
      paths.push({
        id: `workspace-entity-path:${slugify(entityName)}:${slugify(capability.id)}`,
        entity_name: entityName,
        project_ids: capability.project_ids,
        path_type: 'capability',
        via: workspaceEntityCapabilitySteps(capability, appById),
        external_services: [],
        boundaries: [],
        sensitive: entity.sensitive_fields.length > 0,
        evidence: capability.evidence.slice(0, 8),
        next_mcp_calls: [{ tool: 'get_workspace_capability_map', args: { analysis_id_or_name: '<workspace>', target: capability.name } }],
      });
    }
  }

  for (const workflow of workflows) {
    const relatedNames = inferRelatedWorkspaceEntityNames(workflow.name, workflow.description, workflow.evidence, entities);
    for (const entityName of relatedNames) {
      const entity = ensure(entityName);
      entity.related_workflow_ids = mergeStrings(entity.related_workflow_ids, [workflow.id]);
      entity.project_ids = mergeStrings(entity.project_ids, workflow.project_ids);
      paths.push({
        id: `workspace-entity-path:${slugify(entityName)}:${slugify(workflow.id)}`,
        entity_name: entityName,
        project_ids: workflow.project_ids,
        path_type: 'workflow',
        via: workspaceEntityWorkflowSteps(workflow, appById),
        external_services: [],
        boundaries: [],
        sensitive: entity.sensitive_fields.length > 0,
        evidence: workflow.evidence.slice(0, 8),
        next_mcp_calls: [{ tool: 'get_workspace_workflow', args: { analysis_id_or_name: '<workspace>', workflow_id_or_name: workflow.name } }],
      });
    }
  }

  for (const dataFlow of dataFlowPaths) {
    const entityNames = [...entities.values()].filter(entity =>
      dataFlow.description.toLowerCase().includes(entity.name.toLowerCase())
    );
    for (const entity of entityNames) {
      entity.related_data_flow_path_ids = mergeStrings(entity.related_data_flow_path_ids, [dataFlow.id]);
      paths.push({
        id: `workspace-entity-path:${slugify(entity.name)}:${slugify(dataFlow.id)}`,
        entity_name: entity.name,
        project_ids: [dataFlow.source_codebase_id, dataFlow.target_codebase_id],
        path_type: 'cross-repo-flow',
        via: [
          { project_id: dataFlow.source_codebase_id, deployable_id: dataFlow.source_application_id, role: 'interface-flow' as const, label: dataFlow.via[0] || dataFlow.source_interface_id },
          { project_id: dataFlow.target_codebase_id, deployable_id: dataFlow.target_application_id, role: 'interface-flow' as const, label: dataFlow.via[1] || dataFlow.target_interface_id },
        ],
        external_services: [],
        boundaries: [],
        sensitive: entity.sensitive_fields.length > 0,
        evidence: [dataFlow.id, ...dataFlow.evidence].slice(0, 8),
        next_mcp_calls: [{ tool: 'get_workspace_analysis', args: { analysis_id_or_name: '<workspace>', detail_level: 'evidence' } }],
      });
    }
  }

  const dedupedPaths = dedupeEntityPaths(paths.map(pathItem => enrichWorkspaceEntityPath(pathItem))).slice(0, 160);
  const pathsByEntity = new Map<string, WorkspaceEntityPath[]>();
  for (const pathItem of dedupedPaths) {
    const key = slugify(pathItem.entity_name);
    pathsByEntity.set(key, [...(pathsByEntity.get(key) || []), pathItem]);
  }

  for (const [key, entity] of entities) {
    const rawIdMatch = /^entity[_:-](.+)$/i.exec(entity.name);
    if (!rawIdMatch) continue;
    const canonical = entities.get(slugify(rawIdMatch[1]));
    if (canonical && canonical !== entity) {
      canonical.project_ids = mergeStrings(canonical.project_ids, entity.project_ids);
      canonical.related_capability_ids = mergeStrings(canonical.related_capability_ids, entity.related_capability_ids);
      canonical.related_workflow_ids = mergeStrings(canonical.related_workflow_ids, entity.related_workflow_ids);
      entities.delete(key);
    }
  }

  return {
    entities: [...entities.values()]
      .map(entity => ({
        ...entity,
        entity_refs: dedupeEntityRefs(entity.entity_refs),
        project_ids: entity.project_ids.sort(),
        description: entity.description || describeWorkspaceEntity(entity),
        description_source: entity.description_source || 'ai-required-degraded',
        path_count: pathsByEntity.get(slugify(entity.name))?.length || 0,
        path_types: [...new Set((pathsByEntity.get(slugify(entity.name)) || []).map(pathItem => pathItem.path_type))],
        next_mcp_calls: compactWorkspaceNextMcpCalls([
          { tool: 'get_workspace_entity_map', args: { analysis_id_or_name: '<workspace>', target: entity.name, limit: 12 } },
          ...(pathsByEntity.get(slugify(entity.name)) || []).flatMap(pathItem => pathItem.next_mcp_calls || []),
        ]),
        confidence: Math.min(0.94, entity.confidence + Math.min(0.1, entity.related_workflow_ids.length * 0.02 + entity.related_capability_ids.length * 0.02)),
      }))
      .sort((left, right) => workspaceEntityRank(right) - workspaceEntityRank(left) || left.name.localeCompare(right.name))
      .slice(0, 80),
    paths: dedupedPaths,
	  };
	}

interface WorkspaceTerminalSemanticProfile {
  project_id: string;
  names: Map<string, { score: number; evidence: string[] }>;
  capability_ids: Map<string, { score: number; evidence: string[] }>;
  infrastructure_capability_ids: Set<string>;
}

function buildWorkspaceTerminalProfiles(repositories: CrossCodebaseInput[]): Map<string, WorkspaceTerminalSemanticProfile> {
  const profiles = new Map<string, WorkspaceTerminalSemanticProfile>();
  for (const repository of repositories) {
    const projectId = codebaseId(repository.path);
    profiles.set(projectId, buildTerminalSemanticProfile(projectId, repository.cas as any));
  }
  return profiles;
}

function emptyTerminalSemanticProfile(projectId: string): WorkspaceTerminalSemanticProfile {
  return { project_id: projectId, names: new Map(), capability_ids: new Map(), infrastructure_capability_ids: new Set() };
}

function buildTerminalSemanticProfile(projectId: string, cas: any): WorkspaceTerminalSemanticProfile {
  const profile = emptyTerminalSemanticProfile(projectId);
  const terminalNameSeeds: Array<{ name: string; score: number; evidence: string }> = [];
  const terminalCapabilitySeeds: Array<{ id: string; score: number; evidence: string }> = [];
  const addName = (name: unknown, score: number, evidence: string) => {
    const normalized = normalizeAiItemName(String(name || ''));
    if (!normalized || normalized.length < 3 || isWeakWorkspaceDomain(normalized)) return;
    const existing = profile.names.get(normalized) || { score: 0, evidence: [] };
    existing.score += score;
    existing.evidence = mergeStrings(existing.evidence, [evidence]).slice(0, 10);
    profile.names.set(normalized, existing);
  };
  const addTerminalNameSeed = (name: unknown, score: number, evidence: string) => {
    const normalized = normalizeAiItemName(String(name || ''));
    if (!normalized || normalized.length < 3 || isWeakWorkspaceDomain(normalized)) return;
    terminalNameSeeds.push({ name: normalized, score, evidence });
    addName(normalized, score, evidence);
  };
  const addCapability = (id: unknown, score: number, evidence: string) => {
    const normalized = normalizeAiItemName(String(id || ''));
    if (!normalized) return;
    const existing = profile.capability_ids.get(normalized) || { score: 0, evidence: [] };
    existing.score += score;
    existing.evidence = mergeStrings(existing.evidence, [evidence]).slice(0, 10);
    profile.capability_ids.set(normalized, existing);
  };
  const addTerminalCapabilitySeed = (id: unknown, score: number, evidence: string) => {
    const normalized = normalizeAiItemName(String(id || ''));
    if (!normalized) return;
    terminalCapabilitySeeds.push({ id: normalized, score, evidence });
    addCapability(normalized, score, evidence);
  };

  const purpose = cas.enhanced_system_purpose || {};
  addName(purpose.primary_domain, 5, `primary_domain:${purpose.primary_domain}`);
  for (const concept of purpose.core_concepts || []) addName(concept, 4, `core_concept:${concept}`);
  if (purpose.primary_workflow_id) addCapability(purpose.primary_workflow_id, 6, `primary_workflow:${purpose.primary_workflow_id}`);

  const flow = cas.flow_graph || {};
  for (const id of flow.topology?.leaf_capabilities || []) {
    if (!isWeakTerminalCapabilitySignal(id)) addTerminalCapabilitySeed(id, 12, `leaf_capability:${id}`);
  }
  if (flow.primary_flow?.core_capability_id && !isWeakTerminalCapabilitySignal(flow.primary_flow.core_capability_id)) {
    addTerminalCapabilitySeed(flow.primary_flow.core_capability_id, 18, `primary_flow_core:${flow.primary_flow.core_capability_id}`);
  }
  for (const id of flow.primary_flow?.value_chain || []) {
    if (!isWeakTerminalCapabilitySignal(id)) addTerminalCapabilitySeed(id, 10, `primary_flow_value_chain:${id}`);
  }
  for (const id of flow.primary_flow?.supporting_capabilities || []) addCapability(id, 3, `primary_flow_supporting:${id}`);
  for (const id of flow.primary_flow?.infrastructure_capabilities || []) {
    profile.infrastructure_capability_ids.add(normalizeAiItemName(String(id || '')));
    addCapability(id, -12, `primary_flow_infrastructure:${id}`);
  }
  for (const capability of flow.capabilities || []) {
    const id = capability.id || capability.name;
    if (isWeakTerminalCapabilitySignal(id) || isWeakTerminalCapabilitySignal(capability.name)) continue;
    const score = capability.classification === 'primary' ? 8 : capability.classification === 'supporting' ? 2 : capability.classification === 'infrastructure' ? -8 : 0;
    addCapability(id, score, `flow_capability:${capability.classification || 'unknown'}:${id}`);
    for (const entity of capability.entities_touched || []) addName(entity, score > 0 ? Math.max(3, score / 2) : score, `flow_capability_entity:${id}:${entity}`);
  }

  for (const entryPointFlow of projectEntryPointFlowsFromCas(cas).entryPointFlows) {
    const entryPointFlowWeight = entryPointFlow.criticality === 'critical' ? 4 : entryPointFlow.criticality === 'high' ? 3 : entryPointFlow.flow_kind === 'user-facing' ? 2 : 1;

    const externalCommandNames = entryPointFlowExternalCommandNames(entryPointFlow);
    const isExternalCommand = (name: unknown) => matchesExternalCommandName(externalCommandNames, name);
    for (const entity of entryPointFlow.terminal_entities || []) {
      if (isExternalCommand(entity.name)) continue;
      const writeWeight = entity.access === 'created' || entity.access === 'updated' || entity.access === 'deleted' ? 14 : 6;
      addTerminalNameSeed(entity.name, writeWeight + entryPointFlowWeight, `terminal_entity:${entryPointFlow.name || entryPointFlow.id}:${entity.name}:${entity.access}`);
    }
    for (const entity of entryPointFlow.terminal_effects?.entities_written || []) {
      if (isExternalCommand(entity)) continue;
      addTerminalNameSeed(entity, 14 + entryPointFlowWeight, `terminal_write:${entryPointFlow.name || entryPointFlow.id}:${entity}`);
    }
    for (const entity of entryPointFlow.terminal_effects?.entities_read || []) {
      if (isExternalCommand(entity)) continue;
      addTerminalNameSeed(entity, 5 + entryPointFlowWeight, `terminal_read:${entryPointFlow.name || entryPointFlow.id}:${entity}`);
    }
    for (const message of entryPointFlow.terminal_effects?.messages_emitted || []) addName(message, 8 + entryPointFlowWeight, `terminal_message:${entryPointFlow.name || entryPointFlow.id}:${message}`);
    for (const service of entryPointFlow.terminal_effects?.external_services || []) {

      if (isExternalCommandService(service)) continue;
      addName(service, 4 + entryPointFlowWeight, `terminal_external:${entryPointFlow.name || entryPointFlow.id}:${service}`);
    }
  }

  propagateNearTerminalEntitySignals(cas, terminalNameSeeds, addName);
  propagateNearTerminalCapabilitySignals(cas, terminalCapabilitySeeds, addCapability);

  return profile;
}

function entryPointFlowExternalCommandNames(entryPointFlow: any): Set<string> {
  const names = new Set<string>();
  for (const service of entryPointFlow?.terminal_effects?.external_services || []) {
    const match = String(service || '').match(/^\s*external command:\s*(.+)$/i);
    if (!match) continue;
    const normalized = normalizeAiItemName(match[1]);
    if (normalized) names.add(normalized);
  }
  return names;
}

function matchesExternalCommandName(commandNames: Set<string>, name: unknown): boolean {
  if (commandNames.size === 0) return false;
  const normalized = normalizeAiItemName(String(name || ''));
  if (!normalized) return false;
  if (commandNames.has(normalized)) return true;

  const stripS = (value: string) => value.endsWith('s') && !value.endsWith('ss') ? value.slice(0, -1) : value;
  const stripped = stripS(normalized);
  for (const command of commandNames) {
    if (stripS(command) === stripped) return true;
  }
  return false;
}

function isExternalCommandService(service: unknown): boolean {
  return /^\s*external command:/i.test(String(service || ''));
}

function isWeakTerminalCapabilitySignal(value: unknown): boolean {
  const normalized = normalizeAiItemName(String(value || '')).replace(/\bcapability\b/g, '').trim();
  if (!normalized) return true;
  if (/^(test|tests|testing|health|debug|diagnostic|diagnostics|fixture|fixtures|seed|seeding|config|configuration|status|ping|hello|example|sample|demo)$/.test(normalized)) return true;
  if (/^(test|health|debug|diagnostic|fixture|seed|config|example|sample)[a-z0-9 ]*/.test(normalized)) return true;
  if (/^(list|get|set|create|update|delete|read|write|find|handle|process|execute|run|sync|manage)$/.test(normalized)) return true;
  return false;
}

function propagateNearTerminalEntitySignals(
  cas: any,
  seeds: Array<{ name: string; score: number; evidence: string }>,
  addName: (name: unknown, score: number, evidence: string) => void
): void {
  if (seeds.length === 0) return;
  const relatedByName = new Map<string, Array<{ name: string; evidence: string }>>();
  const addRelation = (left: unknown, right: unknown, evidence: string) => {
    const source = normalizeAiItemName(String(left || ''));
    const target = normalizeAiItemName(String(right || ''));
    if (!source || !target || source === target) return;
    relatedByName.set(source, [...(relatedByName.get(source) || []), { name: target, evidence }]);
    relatedByName.set(target, [...(relatedByName.get(target) || []), { name: source, evidence }]);
  };

  for (const entity of cas.database_schema?.entities || []) {
    for (const relationship of entity.relationships || []) {
      addRelation(entity.name, relationship.target, `near_terminal_schema_relation:${entity.name}->${relationship.target}:${relationship.type || 'relationship'}`);
    }
  }

  for (const entity of cas.entities || []) {
    for (const transformation of entity.transformations || []) {
      if (transformation.transformation_type) {
        addName(entity.name, 1.5, `near_terminal_transformation:${entity.name}:${transformation.transformation_type}`);
      }
    }
  }

  const visited = new Set<string>();
  const queue = seeds.map(seed => ({ name: seed.name, score: seed.score, depth: 0, evidence: seed.evidence }));
  while (queue.length > 0) {
    const current = queue.shift()!;
    const key = `${current.name}:${current.depth}`;
    if (visited.has(key) || current.depth >= 2) continue;
    visited.add(key);
    const nextDepth = current.depth + 1;
    const decay = nextDepth === 1 ? 0.42 : 0.2;
    for (const related of relatedByName.get(current.name) || []) {
      const score = Math.max(1, current.score * decay);
      addName(related.name, score, `near_terminal_entity:${current.name}->${related.name}:depth${nextDepth}`);
      queue.push({ name: related.name, score, depth: nextDepth, evidence: related.evidence });
    }
  }
}

function propagateNearTerminalCapabilitySignals(
  cas: any,
  seeds: Array<{ id: string; score: number; evidence: string }>,
  addCapability: (id: unknown, score: number, evidence: string) => void
): void {
  if (seeds.length === 0) return;
  const incomingByCapability = new Map<string, Array<{ id: string; evidence: string }>>();
  for (const dependency of cas.flow_graph?.dependencies || []) {
    const from = normalizeAiItemName(String(dependency.from_capability || ''));
    const to = normalizeAiItemName(String(dependency.to_capability || ''));
    if (!from || !to || from === to) continue;
    const relation = dependency.dependency_type || dependency.strength || 'dependency';
    incomingByCapability.set(to, [...(incomingByCapability.get(to) || []), { id: from, evidence: `near_terminal_capability:${from}->${to}:${relation}` }]);
  }

  const visited = new Set<string>();
  const queue = seeds.map(seed => ({ id: seed.id, score: seed.score, depth: 0, evidence: seed.evidence }));
  while (queue.length > 0) {
    const current = queue.shift()!;
    const key = `${current.id}:${current.depth}`;
    if (visited.has(key) || current.depth >= 2) continue;
    visited.add(key);
    const nextDepth = current.depth + 1;
    const decay = nextDepth === 1 ? 0.5 : 0.25;
    for (const upstream of incomingByCapability.get(current.id) || []) {
      const score = Math.max(1, current.score * decay);
      addCapability(upstream.id, score, `${upstream.evidence}:depth${nextDepth}`);
      queue.push({ id: upstream.id, score, depth: nextDepth, evidence: upstream.evidence });
    }
  }
}

function directTerminalNameScore(profile: WorkspaceTerminalSemanticProfile, name: unknown): number {
  const normalized = normalizeAiItemName(String(name || ''));
  if (!normalized) return 0;
  const direct = profile.names.get(normalized);
  return direct ? capTerminalSignalScore(normalized, direct.score) : 0;
}

function terminalSignalForName(profile: WorkspaceTerminalSemanticProfile, name: unknown): { score: number; evidence: string[] } {
  const normalized = normalizeAiItemName(String(name || ''));
  if (!normalized) return { score: 0, evidence: [] };
  const direct = profile.names.get(normalized);
  if (direct) return { score: capTerminalSignalScore(normalized, direct.score), evidence: direct.evidence };
  const tokens = [...terminalSemanticTokens([name])];
  let score = 0;
  const evidence: string[] = [];
  for (const [key, value] of profile.names.entries()) {
    if (key === normalized || key.includes(normalized) || normalized.includes(key) || tokens.some(token => new RegExp(`\\b${escapeRegExp(token)}\\b`).test(key))) {
      score += Math.min(capTerminalSignalScore(key, value.score), 8);
      evidence.push(...value.evidence.slice(0, 2));
    }
  }
  return { score: capTerminalSignalScore(normalized, score), evidence: mergeStrings([], evidence).slice(0, 8) };
}

function terminalSignalForCapability(profile: WorkspaceTerminalSemanticProfile, capability: any): { score: number; evidence: string[] } {
  const ids = [capability.id, capability.name].map(value => normalizeAiItemName(String(value || ''))).filter(Boolean);
  let score = 0;
  const evidence: string[] = [];
  const capabilityTokens = terminalSemanticTokens([capability.name, capability.id]);
  for (const id of ids) {
    const direct = profile.capability_ids.get(id);
    if (direct) {
      score += direct.score;
      evidence.push(...direct.evidence);
    }
    for (const [key, value] of profile.capability_ids.entries()) {
      if (key !== id && (key.includes(id) || id.includes(key))) {
        score += Math.min(value.score, 8);
        evidence.push(...value.evidence.slice(0, 2));
      }
    }
  }
  for (const entity of capability.related_entities || capability.entities_touched || []) {
    if (!terminalEntitySupportsCapability(entity, capabilityTokens)) continue;
    const signal = terminalSignalForName(profile, entity);
    score += Math.min(8, signal.score);
    evidence.push(...signal.evidence.map(item => `entity_aligned:${item}`));
  }
  for (const domain of capability.related_domains || []) {
    const signal = terminalSignalForName(profile, domain);
    score += Math.min(6, signal.score);
    evidence.push(...signal.evidence);
  }
  return { score, evidence: mergeStrings([], evidence).slice(0, 10) };
}

function terminalEntitySupportsCapability(entity: unknown, capabilityTokens: Set<string>): boolean {
  if (capabilityTokens.size === 0) return false;
  const entityTokens = terminalSemanticTokens([entity]);
  for (const token of entityTokens) {
    if (capabilityTokens.has(token)) return true;
    for (const capabilityToken of capabilityTokens) {
      if (token.length >= 5 && capabilityToken.length >= 5 && (token.includes(capabilityToken) || capabilityToken.includes(token))) {
        return true;
      }
    }
  }
  return false;
}

function terminalSemanticTokens(values: unknown[]): Set<string> {
  const stop = new Set([
    'capability',
    'management',
    'manager',
    'service',
    'services',
    'system',
    'platform',
    'context',
    'control',
    'handler',
    'handlers',
    'controller',
    'controllers',
    'repository',
    'repositories',
    'model',
    'models',
  ]);
  const tokens = new Set<string>();
  for (const value of values) {
    const camelSplit = String(value || '').replace(/([a-z0-9])([A-Z])/g, '$1 $2');
    for (const token of normalizeAiItemName(camelSplit).split(/\s+/)) {
      if (token.length < 4 || stop.has(token)) continue;
      tokens.add(token.replace(/s$/, ''));
    }
  }
  return tokens;
}

function semanticRoleFromTerminalScore(score: number, fallback: WorkspaceSemanticRole = 'supporting'): WorkspaceSemanticRole {
  if (score <= 0 && fallback === 'core') return 'supporting';
  return score >= 8 ? 'core' : score <= -6 ? 'infrastructure' : fallback;
}

function effectiveWorkspaceTerminalScore(_name: unknown, score: number): number {
  if (!Number.isFinite(score) || score <= 0) return 0;
  return score;
}

function capTerminalSignalScore(_normalized: string, score: number): number {
  if (!Number.isFinite(score)) return 0;
  return Number(Math.max(-24, Math.min(48, score)).toFixed(1));
}

function strongerSemanticRole(left?: WorkspaceSemanticRole, right?: WorkspaceSemanticRole): WorkspaceSemanticRole | undefined {
  const rank: Record<WorkspaceSemanticRole, number> = { core: 3, supporting: 2, infrastructure: 1 };
  if (!left) return right;
  if (!right) return left;
  return rank[right] > rank[left] ? right : left;
}

function roundTerminalScore(score: number | undefined): number | undefined {
  if (score === undefined || score === null || !Number.isFinite(score)) return undefined;
  return Number(score.toFixed(1));
}

function workspaceEntityCapabilitySteps(
  capability: WorkspaceCapability,
  appById: Map<string, SystemApplication>,
): WorkspaceEntityPath['via'] {
  const deployableSteps = capability.deployable_ids.slice(0, 8).map(deployableId => ({
    project_id: appById.get(deployableId)?.codebase_id || deployableId.split(':app:')[0] || capability.project_ids[0],
    deployable_id: deployableId,
    role: 'capability' as const,
    label: capability.name,
  }));
  if (deployableSteps.length > 0) return deployableSteps;
  return capability.project_ids.slice(0, 8).map(projectId => ({
    project_id: projectId,
    role: 'capability' as const,
    label: capability.name,
  }));
}

function workspaceEntityWorkflowSteps(
  workflow: WorkspaceWorkflow,
  appById: Map<string, SystemApplication>,
): WorkspaceEntityPath['via'] {
  const deployableSteps = workflow.deployable_ids.slice(0, 8).map((deployableId, index) => ({
    project_id: appById.get(deployableId)?.codebase_id || workflow.project_ids[index] || workflow.project_ids[0],
    deployable_id: deployableId,
    role: 'workflow' as const,
    label: workflow.name,
  }));
  if (deployableSteps.length > 0) return deployableSteps;
  return workflow.project_ids.slice(0, 8).map(projectId => ({
    project_id: projectId,
    role: 'workflow' as const,
    label: workflow.name,
  }));
}

function workspaceEntityRank(entity: WorkspaceEntity): number {
  let score = 0;
  score += entity.project_ids.length * 10;
  score += Math.min(20, entity.lifecycle.external_recipients);
  score += Math.min(20, entity.lifecycle.boundaries_crossed);
  score += Math.min(16, entity.lifecycle.read_by / 3);
  score += Math.min(12, entity.lifecycle.created_by * 2);
  score += entity.sensitive_fields.length > 0 ? 8 : 0;
  score += entity.related_data_flow_path_ids.length > 0 ? 6 : 0;
  score += Math.min(36, effectiveWorkspaceTerminalScore(entity.name, entity.terminal_score || 0) * 2);
  if (entity.semantic_role === 'core') score += 24;
  if (entity.semantic_role === 'infrastructure') score -= 18;
  return score;
}

function describeWorkspaceEntity(entity: WorkspaceEntity): string {
  const lifecycle: string[] = [];
  if (entity.lifecycle.created_by > 0) lifecycle.push(`${entity.lifecycle.created_by} writer(s)`);
  if (entity.lifecycle.read_by > 0) lifecycle.push(`${entity.lifecycle.read_by} reader(s)`);
  if (entity.lifecycle.updated_by > 0) lifecycle.push(`${entity.lifecycle.updated_by} updater(s)`);
  if (entity.lifecycle.deleted_by > 0) lifecycle.push(`${entity.lifecycle.deleted_by} deleter(s)`);
  if (entity.lifecycle.external_recipients > 0) lifecycle.push(`${entity.lifecycle.external_recipients} external recipient(s)`);
  if (entity.lifecycle.boundaries_crossed > 0) lifecycle.push(`${entity.lifecycle.boundaries_crossed} boundary crossing(s)`);
  const scope = entity.project_ids.length === 1
    ? `in ${entity.project_ids[0]}`
    : `across ${entity.project_ids.length} project(s)`;
  const sensitivity = entity.sensitive_fields.length > 0
    ? ` Sensitive fields include ${entity.sensitive_fields.slice(0, 4).join(', ')}.`
    : '';
  const lifecycleText = lifecycle.length ? ` It has ${lifecycle.slice(0, 4).join(', ')} in repo-level CAS lineage.` : '';
  return `${entity.name} is a workspace-level entity concept observed ${scope}.${lifecycleText}${sensitivity} Use get_workspace_entity_map and repo-level get_data_lineage for source-backed detail.`;
}

function entityPathStep(
  projectId: string,
  nodeId: string | undefined,
  file: string | undefined,
  label: string,
  role: WorkspaceEntityPath['via'][number]['role'],
  appByNode: Map<string, SystemApplication>,
  nodeFileById: Map<string, string | undefined>,
): WorkspaceEntityPath['via'][number] {
  const app = nodeId ? appByNode.get(`${projectId}:${nodeId}`) : undefined;
  return {
    project_id: projectId,
    deployable_id: app?.id,
    role,
    node_id: nodeId,
    file: file || (nodeId ? nodeFileById.get(`${projectId}:${nodeId}`) : undefined),
    label: label || nodeId || role,
  };
}

function enrichWorkspaceEntityPath(pathItem: WorkspaceEntityPath): WorkspaceEntityPath {
  const via = (pathItem.via || []).filter(step => step && step.project_id && step.label);
  const evidenceQuality = workspaceEntityPathEvidenceQuality(pathItem);
  const steps = via.map((step, index) => ({
    project_id: step.project_id,
    deployable_id: step.deployable_id,
    role: step.role,
    node_id: step.node_id,
    file: step.file,
    label: step.label,
    sequence: index + 1,
    edge_type: pathItem.path_type,
    evidence_quality: evidenceQuality,
  }));
  const source = workspaceEntityPathEndpoint(steps[0], pathItem, 'source');
  const target = workspaceEntityPathEndpoint(steps[steps.length - 1] || steps[0], pathItem, 'target');
  const projectCount = new Set(pathItem.project_ids || steps.map(step => step.project_id)).size;
  const name = pathItem.name || `${pathItem.entity_name} ${pathItem.path_type.replace(/-/g, ' ')} path`;
  return {
    ...pathItem,
    name,
    description: pathItem.description || describeWorkspaceEntityPath(pathItem, source, target, projectCount, evidenceQuality),
    project_ids: pathItem.project_ids || steps.map(step => step.project_id),
    via,
    source,
    target,
    steps,
    step_count: steps.length,
    confidence: pathItem.confidence ?? workspaceEntityPathConfidence(pathItem, evidenceQuality, steps.length, projectCount),
    evidence_quality: evidenceQuality,
  };
}

function workspaceEntityPathEndpoint(
  step: WorkspaceEntityPathStep | undefined,
  pathItem: WorkspaceEntityPath,
  fallbackRole: 'source' | 'target',
): WorkspaceEntityPathEndpoint {
  if (step) {
    return {
      project_id: step.project_id,
      deployable_id: step.deployable_id,
      role: step.role,
      node_id: step.node_id,
      file: step.file,
      label: step.label,
    };
  }
  const projectId = pathItem.project_ids?.[fallbackRole === 'source' ? 0 : Math.max(0, pathItem.project_ids.length - 1)] || 'unknown';
  return {
    project_id: projectId,
    role: pathItem.path_type === 'capability' ? 'capability' : pathItem.path_type === 'workflow' ? 'workflow' : 'interface-flow',
    label: `${pathItem.entity_name} ${fallbackRole}`,
  };
}

function workspaceEntityPathEvidenceQuality(pathItem: WorkspaceEntityPath): WorkspaceLinkEvidenceQuality {
  if (pathItem.evidence?.some(item => /evidence_quality:source-backed|source-backed|data_lineage|lineage:/i.test(item))) return 'source-backed';
  if (pathItem.path_type === 'lineage') return 'source-backed';
  if (pathItem.path_type === 'cross-repo-flow') {
    const text = `${pathItem.evidence?.join(' ')} ${pathItem.via?.map(step => step.label).join(' ')}`;
    if (/source-backed/i.test(text)) return 'source-backed';
    if (/topology-backed/i.test(text)) return 'topology-backed';
    if (/route-shape/i.test(text)) return 'route-shape-inferred';
  }
  if (pathItem.path_type === 'workflow') {
    const text = `${pathItem.evidence?.join(' ')} ${pathItem.via?.map(step => step.label).join(' ')}`;
    if (/evidence_quality:source-backed|source-backed/i.test(text)) return 'source-backed';
    if (/evidence_quality:package-declared|package-declared/i.test(text)) return 'package-declared';
    if (/evidence_quality:topology-backed|topology-backed/i.test(text)) return 'topology-backed';
    if (/evidence_quality:route-shape-inferred|route-shape/i.test(text)) return 'route-shape-inferred';
    return 'name-inferred';
  }
  if (pathItem.path_type === 'capability') return 'name-inferred';
  return 'name-inferred';
}

function workspaceEntityPathConfidence(
  pathItem: WorkspaceEntityPath,
  evidenceQuality: WorkspaceLinkEvidenceQuality,
  stepCount: number,
  projectCount: number,
): number {
  let score = evidenceQuality === 'source-backed' ? 0.84
    : evidenceQuality === 'package-declared' ? 0.78
      : evidenceQuality === 'topology-backed' ? 0.68
        : evidenceQuality === 'route-shape-inferred' ? 0.62
          : 0.52;
  if (pathItem.sensitive) score += 0.04;
  if (stepCount >= 2) score += 0.04;
  if (projectCount > 1) score += 0.04;
  if (pathItem.path_type === 'capability') score -= 0.08;
  return Number(Math.max(0.35, Math.min(0.96, score)).toFixed(2));
}

function describeWorkspaceEntityPath(
  pathItem: WorkspaceEntityPath,
  source: WorkspaceEntityPathEndpoint,
  target: WorkspaceEntityPathEndpoint,
  projectCount: number,
  evidenceQuality: WorkspaceLinkEvidenceQuality,
): string {
  const type = pathItem.path_type.replace(/-/g, ' ');
  const sameDeployable = source.deployable_id && target.deployable_id && source.deployable_id === target.deployable_id;
  const sourceLabel = sameDeployable
    ? source.file || source.label || source.deployable_id || source.project_id
    : source.deployable_id || source.file || source.label || source.project_id;
  const targetLabel = sameDeployable
    ? target.file || target.label || target.deployable_id || target.project_id
    : target.deployable_id || target.file || target.label || target.project_id;
  const trust = evidenceQuality === 'source-backed'
    ? 'source-backed evidence'
    : evidenceQuality === 'topology-backed'
      ? 'deployment/topology evidence'
      : evidenceQuality === 'route-shape-inferred'
        ? 'route-shape inference'
        : 'name/capability inference';
  if (sameDeployable && sourceLabel !== targetLabel) {
    return `${pathItem.entity_name} has a ${type} path inside ${source.deployable_id}, from ${sourceLabel} to ${targetLabel}, based on ${trust}. Drill into the listed steps before changing producers, consumers, or schema.`;
  }
  return `${pathItem.entity_name} has a ${type} path from ${sourceLabel} to ${targetLabel} across ${projectCount} project(s), based on ${trust}. Drill into the listed steps before changing producers, consumers, or schema.`;
}

function dedupeEntityRefs(refs: WorkspaceEntity['entity_refs']): WorkspaceEntity['entity_refs'] {
  const seen = new Set<string>();
  return refs.filter(ref => {
    const key = `${ref.project_id}:${ref.entity_id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dedupeEntityPaths(paths: WorkspaceEntityPath[]): WorkspaceEntityPath[] {
  const byId = new Map<string, WorkspaceEntityPath>();
  for (const pathItem of paths) {
    if (!byId.has(pathItem.id)) byId.set(pathItem.id, pathItem);
  }
  return [...byId.values()].sort((left, right) =>
    workspaceEntityPathRank(right) - workspaceEntityPathRank(left) ||
    left.entity_name.localeCompare(right.entity_name)
  );
}

function workspaceEntityPathRank(pathItem: WorkspaceEntityPath): number {
  const qualityRank = linkQualityRank({
    evidence_quality: pathItem.evidence_quality,
    confidence: pathItem.confidence,
  });
  let score = qualityRank * 100;
  score += Math.round((pathItem.confidence || 0) * 20);
  score += Number(pathItem.sensitive) * 12;
  score += Math.min(20, pathItem.project_ids.length * 2);
  score += Math.min(12, pathItem.steps.length * 2);
  if (pathItem.path_type === 'lineage') score += 18;
  if (pathItem.path_type === 'cross-repo-flow') score += 14;
  if (pathItem.path_type === 'workflow') score += 8;
  if (pathItem.path_type === 'capability') score -= 22;
  return score;
}

function buildWorkspaceWorkflows(
  repositories: CrossCodebaseInput[],
  applications: SystemApplication[],
  interfaces: SystemInterface[],
  applicationLinks: SystemApplicationLink[],
  lookupIndexes: Map<CASOutput, CrossCodebaseLookupIndex>,
): WorkspaceWorkflow[] {
  const terminalProfiles = buildWorkspaceTerminalProfiles(repositories);
  const appById = new Map(applications.map(app => [app.id, app]));
  const appByInterface = new Map(interfaces.map(item => [item.id, appById.get(item.application_id)]));
  const interfaceOrder = new Map(interfaces.map((item, index) => [item.id, index]));
  const interfaceIdsByEvidence = new Map<string, string[]>();
  for (const item of interfaces) {
    for (const evidence of item.evidence) {
      const key = `${item.codebase_id}:${evidence.id}`;
      interfaceIdsByEvidence.set(key, [...(interfaceIdsByEvidence.get(key) || []), item.id]);
    }
  }
  const workflows: WorkspaceWorkflow[] = [];
  for (const link of dedupeWorkflowApplicationLinks(applicationLinks).slice(0, 40)) {
    const source = appByInterface.get(link.source_interface_id || '') || appById.get(link.source_application_id);
    const target = appByInterface.get(link.target_interface_id || '') || appById.get(link.target_application_id);
    if (!source || !target) continue;
    workflows.push({
      id: `workflow:${slugify(link.id)}`,
      name: workspaceWorkflowNameFromLink(source, target, link),
      description: describeWorkspaceWorkflowFromLink(source, target, link),
      project_ids: [...new Set([source.codebase_id, target.codebase_id])],
      deployable_ids: [source.id, target.id],
      interface_ids: [link.source_interface_id, link.target_interface_id].filter(Boolean) as string[],
      mode: link.mode,
      criticality: link.evidence_quality === 'source-backed' && link.confidence >= 0.9 ? 'high' : 'medium',
      confidence: link.confidence,
      evidence_quality: link.evidence_quality,
      evidence: [`evidence_quality:${link.evidence_quality}`, ...link.evidence].slice(0, 9),
    });
  }
  for (const repository of repositories) {
    const projectId = codebaseId(repository.path);
    const terminalProfile = terminalProfiles.get(projectId) || emptyTerminalSemanticProfile(projectId);
    const apps = applications.filter(app => app.codebase_id === projectId);
    const appByProjectId = new Map(apps.map(app => [app.id, app]));
    const lookupIndex = lookupIndexes.get(repository.cas)!;

    for (const entryPointFlow of projectEntryPointFlowsFromCas(repository.cas).entryPointFlows) {
      const workflow = {
        id: entryPointFlow.id,
        name: entryPointFlow.name,
        classification: (entryPointFlow.flow_kind === 'user-facing' ? 'primary' : 'supporting') as 'primary' | 'supporting' | 'internal',
        criticality: entryPointFlow.criticality,
        entry_points: entryPointFlow.entry_point_id ? [entryPointFlow.entry_point_id] : [],
        exit_points: entryPointFlow.exit_point_ids || [],
        entities_touched: [
          ...(entryPointFlow.terminal_effects?.entities_written || []),
          ...(entryPointFlow.terminal_effects?.entities_read || []),
        ],
      };
      if (isRuntimeEndpointSemanticName(workflow.name || workflow.id || '')) continue;
      const deployableIds = new Set<string>();
      const entries = (workflow.entry_points || [])
        .map(entryId => lookupEntryPoint(lookupIndex, entryId))
        .filter(Boolean) as any[];
      for (const entry of entries) {
        const app = entryRefs(lookupIndex, entry).map(ref => applicationForFileFromIndex(projectId, ref.file, appByProjectId)).find(Boolean);
        if (app) deployableIds.add(app.id);
      }
      const exits = (workflow.exit_points || [])
        .map(exitId => lookupExitPoint(lookupIndex, exitId))
        .filter(Boolean) as any[];
      const interfaceIds = [...new Set([
        ...(workflow.entry_points || []).flatMap(entryId => interfaceIdsByEvidence.get(`${projectId}:${entryId}`) || []),
        ...(workflow.exit_points || []).flatMap(exitId => interfaceIdsByEvidence.get(`${projectId}:${exitId}`) || []),
      ])].sort((left, right) => (interfaceOrder.get(left) || 0) - (interfaceOrder.get(right) || 0));
      const criticality = workspaceWorkflowCriticality(workflow, entries, exits, [...deployableIds], interfaceIds);
      const terminalSignal = terminalSignalForCapability(terminalProfile, {
        id: workflow.id,
        name: workflow.name,
        related_entities: workflow.entities_touched || [],
      });
      workflows.push({
        id: `${projectId}:workflow:${slugify(workflow.id || workflow.name)}`,
        name: workflow.name,
        description: describeWorkspaceWorkflowFromCas(workflow, entries, exits, [...deployableIds], projectId),
        project_ids: [projectId],
        deployable_ids: [...deployableIds],
        interface_ids: interfaceIds,
        mode: 'mixed',
        criticality,
        semantic_role: semanticRoleFromTerminalScore(terminalSignal.score, workflow.classification === 'primary' ? 'core' : workflow.classification === 'internal' ? 'infrastructure' : 'supporting'),
        terminal_score: roundTerminalScore(terminalSignal.score),
        terminal_evidence: terminalSignal.evidence,
        confidence: workflow.classification === 'primary' ? 0.78 : 0.66,
        evidence_quality: entries.length || exits.length ? 'source-backed' : 'name-inferred',
        evidence: [
          `evidence_quality:${entries.length || exits.length ? 'source-backed' : 'name-inferred'}`,
          ...(workflow.entry_points || []).map(id => `entry:${id}`),
          ...(workflow.exit_points || []).map(id => `exit:${id}`),
          ...(workflow.entities_touched || []).map(entity => `entity:${entity}`),
        ].slice(0, 12),
      });
    }
  }

  return dedupeWorkspaceWorkflows(workflows.map(normalizeWorkspaceWorkflowSemantics))
    .sort((left, right) => workspaceWorkflowRank(right) - workspaceWorkflowRank(left) || left.name.localeCompare(right.name));
}

export const WORKSPACE_WORKFLOWS_MAX = 40;

function workspaceWorkflowNameFromLink(source: SystemApplication, target: SystemApplication, link: SystemApplicationLink): string {
  const kind = link.kind === 'http-call' ? 'HTTP'
    : link.kind === 'sdk-install' ? 'SDK'
      : link.kind === 'message-flow' ? 'Message'
        : link.kind === 'shared-data' ? 'Shared Data'
          : titleizeHumanPhrase(link.kind);
  const mode = link.mode === 'async' ? 'async' : link.mode === 'passive' ? 'passive' : link.mode === 'stream' ? 'stream' : 'sync';
  return `${source.name} ${mode} ${kind} to ${target.name}`;
}

function inferRelatedWorkspaceEntityNames(
  name: string,
  description: string | undefined,
  evidence: string[],
  entities: Map<string, WorkspaceEntity>,
): string[] {

  const resolveExplicitRef = (raw: string): string | undefined => {
    for (const candidate of [raw, raw.replace(/^entity[_:-]/i, '')]) {
      const hit = entities.get(slugify(candidate));
      if (hit) return hit.name;
    }
    return /^entity[_:-]/i.test(raw) ? undefined : raw;
  };
  const explicit = evidence
    .filter(item => item.startsWith('entity:'))
    .map(item => item.replace(/^entity:/, ''))
    .filter(Boolean)
    .map(resolveExplicitRef)
    .filter((value): value is string => Boolean(value));
  const haystack = normalizeAiItemName([name, description, evidence.join(' ')].join(' '));
  const fuzzy = [...entities.values()]
    .filter(entity => {
      const normalized = normalizeAiItemName(entity.name);
      if (!normalized || normalized.length < 4) return false;
      return new RegExp(`\\b${escapeRegExp(normalized).replace(/\\s+/g, '\\s+')}\\b`).test(haystack);
    })
    .map(entity => entity.name);
  return mergeStrings(explicit, fuzzy).slice(0, 12);
}

function dedupeWorkflowApplicationLinks(links: SystemApplicationLink[]): SystemApplicationLink[] {
  const byKey = new Map<string, SystemApplicationLink>();
  for (const link of links) {
    const key = `${link.source_application_id}->${link.target_application_id}:${link.kind}:${link.mode}`;
    const existing = byKey.get(key);
    if (!existing || linkQualityRank(link) > linkQualityRank(existing) || link.confidence > existing.confidence || link.evidence.length > existing.evidence.length) {
      byKey.set(key, link);
    }
  }
  return [...byKey.values()].sort((left, right) => linkQualityRank(right) - linkQualityRank(left) || right.confidence - left.confidence || left.id.localeCompare(right.id));
}

function dedupeWorkspaceWorkflows(workflows: WorkspaceWorkflow[]): WorkspaceWorkflow[] {
  const byKey = new Map<string, WorkspaceWorkflow>();
  for (const workflow of workflows) {
    const key = workflow.mode !== 'mixed' && workflow.deployable_ids.length >= 2
      ? `${workflow.deployable_ids.join('->')}:${workflow.mode}`
      : `${workflow.project_ids.join(',')}:${normalizeAiItemName(workflow.name)}`;
    const existing = byKey.get(key);
    byKey.set(key, existing ? {
      ...existing,
      project_ids: mergeStrings(existing.project_ids, workflow.project_ids),
      deployable_ids: mergeStrings(existing.deployable_ids, workflow.deployable_ids),
      interface_ids: mergeStrings(existing.interface_ids, workflow.interface_ids),
      evidence: mergeStrings(existing.evidence, workflow.evidence).slice(0, 12),
	      criticality: criticalityRank(workflow.criticality) > criticalityRank(existing.criticality) ? workflow.criticality : existing.criticality,
	      semantic_role: strongerSemanticRole(existing.semantic_role, workflow.semantic_role),
	      terminal_score: Math.max(existing.terminal_score || 0, workflow.terminal_score || 0),
	      terminal_evidence: mergeStrings(existing.terminal_evidence || [], workflow.terminal_evidence || []).slice(0, 8),
	      confidence: Math.max(existing.confidence || 0, workflow.confidence || 0),
      evidence_quality: linkQualityRank(workflow) > linkQualityRank(existing) ? workflow.evidence_quality : existing.evidence_quality,
      description: existing.description.length >= workflow.description.length ? existing.description : workflow.description,
    } : workflow);
  }
  return [...byKey.values()].map(normalizeWorkspaceWorkflowSemantics);
}

function workspaceWorkflowRank(workflow: WorkspaceWorkflow): number {
  let score = criticalityRank(workflow.criticality) * 20;
  score += Math.min(18, workflow.deployable_ids.length * 6);
  score += Math.min(12, workflow.interface_ids.length * 3);
  score += Math.min(8, workflow.project_ids.length * 4);
	  if (workflow.project_ids.length > 1) score += 40;
		  if (workflow.deployable_ids.length >= 2) score += 18;
		  score += Math.min(30, effectiveWorkspaceTerminalScore(workflow.name, workflow.terminal_score || 0) * 2);
		  if (workflow.semantic_role === 'core') score += 18;
		  if (workflow.semantic_role === 'infrastructure') score -= 18;
		  score += linkQualityRank(workflow) * 6;
	  if (isRuntimeEndpointSemanticName(workflow.name)) score -= 72;
	  if (workflow.evidence.some(item => /^evidence_quality:(?:topology-backed|name-inferred|route-shape-inferred)$/.test(item))) score -= 8;
	  return score;
	}

function normalizeWorkspaceWorkflowSemantics(workflow: WorkspaceWorkflow): WorkspaceWorkflow {
  if (isRuntimeEndpointSemanticName(workflow.name)) {
    return {
      ...workflow,
      semantic_role: 'infrastructure',
      terminal_score: 0,
      criticality: 'low',
      evidence: mergeStrings(workflow.evidence, ['workspace_semantic_role:runtime-or-infrastructure']).slice(0, 12),
    };
  }
  return workflow;
}

function workspaceWorkflowCriticality(
  workflow: any,
  entries: any[],
  exits: any[],
  deployableIds: string[],
  interfaceIds: string[],
): WorkspaceWorkflow['criticality'] {
  if (isRuntimeEndpointSemanticName(workflow.name || '')) return 'low';
  if (workflow.classification === 'internal') return criticalityRank(workflow.criticality) >= 4 ? 'medium' : 'low';
  if (deployableIds.length >= 2 || interfaceIds.length >= 2 || exits.length > 0) {
    return criticalityRank(workflow.criticality) >= 4 ? 'high' : workflow.criticality || 'medium';
  }
  if (workflow.classification === 'primary') return criticalityRank(workflow.criticality) >= 4 ? 'high' : workflow.criticality || 'medium';
  if (workflow.classification === 'supporting') return criticalityRank(workflow.criticality) >= 3 ? 'medium' : workflow.criticality || 'low';
  return criticalityRank(workflow.criticality) >= 4 ? 'medium' : (workflow.criticality || 'medium');
}

function describeWorkspaceWorkflowFromLink(source: SystemApplication, target: SystemApplication, link: SystemApplicationLink): string {
  const modeLabel = link.mode === 'sync'
    ? 'synchronous'
    : link.mode === 'async'
      ? 'asynchronous'
      : link.mode === 'passive'
        ? 'passive/shared-data'
        : link.mode;
  const kindLabel = link.kind.replace(/[-_]+/g, ' ');
  const evidence = link.evidence[0] ? ` Evidence includes ${truncateText(link.evidence[0].replace(/^(source-backed|package-declared|topology-backed|route-shape-inferred|name-inferred):/, ''), 110)}.` : '';
  const evidenceQuality = link.evidence_quality || 'route-shape-inferred';
  const proof = evidenceQuality === 'source-backed'
    ? 'source-backed'
    : evidenceQuality === 'package-declared'
      ? 'package-declared'
      : evidenceQuality === 'topology-backed'
        ? 'topology-backed'
        : evidenceQuality === 'name-inferred'
          ? 'name-inferred'
          : 'route-shape inferred';
  const relation = link.kind === 'sdk-install'
    ? `${source.name} depends on ${target.name} as a package or library surface`
    : `${source.name} communicates with ${target.name}`;
  const trust = evidenceQuality === 'source-backed'
    ? 'The caller/provider relationship is backed by source-level evidence.'
    : evidenceQuality === 'package-declared'
      ? 'The dependency is declared by package metadata; inspect usage before changing behavior.'
      : evidenceQuality === 'topology-backed'
        ? 'The relationship is deployment/topology evidence, not source-level product usage.'
        : evidenceQuality === 'route-shape-inferred'
          ? 'This is inferred from route shape or endpoint compatibility; verify caller and provider code before relying on it.'
          : 'This is a name/role pairing hint, not proof of runtime usage.';
  return `${relation} through ${modeLabel} ${kindLabel} evidence (${proof}). ${trust} Treat this as a workspace-level flow between ${source.codebase_id} and ${target.codebase_id}, then drill into the repo-level CAS before changing either side.${evidence}`;
}

function describeWorkspaceWorkflowFromCas(
  workflow: any,
  entries: any[],
  exits: any[],
  deployableIds: string[],
  projectId: string,
): string {
  const actions = [...new Set(entries.map(entry => entry?.trigger?.method || entry?.type || '').filter(Boolean))];
  const routes = entries.map(entry => entry?.trigger?.path || entry?.name || '').filter(Boolean);
  const entities = Array.isArray(workflow.entities_touched) ? workflow.entities_touched.filter(Boolean) : [];
  const externalExits = exits.filter(exit => /http|api|webhook|queue|message|sdk|email|service/i.test(`${exit.type} ${exit.name} ${exit.target || ''}`));
  const dataExits = exits.filter(exit => /db|database|repository|orm|sql|entity/i.test(`${exit.type} ${exit.name} ${exit.target || ''}`));
  const readableName = titleizeHumanPhrase(workflow.name || 'Workflow');
  const surface = deployableIds.length > 1
    ? ` exposed on related provider surface(s) ${deployableIds.slice(0, 3).map(shortDeployableName).join(', ')}`
    : deployableIds.length === 1
      ? ` exposed by ${shortDeployableName(deployableIds[0])}`
      : ` in ${projectId}`;
  const sourceBackedCaveat = deployableIds.length > 1
    ? ' This groups similar repo-level routes; it does not prove those deployables call each other without a source-backed workspace link.'
    : '';
  const behavior = routes.length
    ? `It is reached by ${actions.length ? actions.slice(0, 4).join('/') : 'entry-point'} route(s) such as ${routes.slice(0, 3).join(', ')}`
    : `It groups related ${actions.length ? actions.slice(0, 4).join('/') : 'entry-point'} behavior`;
  const data = entities.length
    ? ` and touches ${entities.slice(0, 4).join(', ')}`
    : dataExits.length
      ? ` and uses ${dataExits.length} data operation(s)`
      : '';
  const external = externalExits.length
    ? ` It also crosses ${externalExits.length} external/service boundary point(s).`
    : '';
  return `${readableName} is a workspace-visible flow${surface}. ${behavior}${data}.${sourceBackedCaveat}${external}`;
}

function shortDeployableName(value: string): string {
  return String(value || '').split(':app:').pop()?.replace(/[-_]+/g, ' ') || value;
}

function titleizeHumanPhrase(value: string): string {
  const text = String(value || '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  return text.replace(/\b\w/g, char => char.toUpperCase());
}

function buildWorkspaceEnvironments(
  runtimeComponents: SystemRuntimeComponent[],
  applications: SystemApplication[],
  repositories: CrossCodebaseInput[] = []
): WorkspaceEnvironment[] {
  const appById = new Map(applications.map(app => [app.id, app]));
  const appsByCodebase = new Map<string, SystemApplication[]>();
  for (const app of applications) {
    const existing = appsByCodebase.get(app.codebase_id) || [];
    existing.push(app);
    appsByCodebase.set(app.codebase_id, existing);
  }
  const groups = new Map<string, WorkspaceEnvironment>();
  for (const component of runtimeComponents) {
    const name = component.environment || 'unknown';
    const existing = groups.get(name) || {
      name,
      component_ids: [],
      deployable_ids: [],
      runtime_surfaces: [],
      infrastructure_kinds: [],
    };
    existing.component_ids.push(component.id);
    if (appById.has(component.application_id)) existing.deployable_ids = mergeStrings(existing.deployable_ids, [component.application_id]);
    existing.runtime_surfaces = mergeStrings(existing.runtime_surfaces, [component.topology_surface]);
    existing.infrastructure_kinds = mergeStrings(existing.infrastructure_kinds, [component.kind]);
    groups.set(name, existing);
  }
  for (const repository of repositories) {
    const repositoryId = codebaseId(repository.path);
    for (const node of repository.cas.nodes || []) {
      if (!isRuntimeOrInfrastructureNode(node)) continue;
      const environment = nodeEnvironment(node);
      if (!environment) continue;
      const existing = groups.get(environment) || {
        name: environment,
        component_ids: [],
        deployable_ids: [],
        runtime_surfaces: [],
        infrastructure_kinds: [],
      };
      existing.deployable_ids = mergeStrings(
        existing.deployable_ids,
        (appsByCodebase.get(repositoryId) || []).map(app => app.id),
      );
      existing.runtime_surfaces = mergeStrings(existing.runtime_surfaces, [topologySurface(node.metadata) || 'configuration']);
      existing.infrastructure_kinds = mergeStrings(existing.infrastructure_kinds, [node.type]);
      existing.provider = existing.provider || environmentProvider(existing.runtime_surfaces, existing.infrastructure_kinds);
      existing.type = existing.type || environmentType(environment, existing.runtime_surfaces);
      groups.set(environment, existing);
    }
  }
  for (const environment of groups.values()) {
    environment.provider = environment.provider || environmentProvider(environment.runtime_surfaces, environment.infrastructure_kinds);
    environment.type = environment.type || environmentType(environment.name, environment.runtime_surfaces);
    if (environment.component_ids.length > 0) {
      environment.resolution_status = 'runtime-mapped';
      environment.resolution_note = 'Runtime components are mapped to this environment.';
    } else if (environment.deployable_ids.length > 0) {
      environment.resolution_status = 'infra-only';
      environment.resolution_note = 'Infrastructure or configuration references this environment, but no runtime component was mapped to a concrete deployed application.';
    } else if (environment.runtime_surfaces.includes('configuration')) {
      environment.resolution_status = 'configuration-only';
      environment.resolution_note = 'Only configuration evidence was found for this environment.';
    } else {
      environment.resolution_status = 'unknown';
      environment.resolution_note = 'Klauro has not resolved deployables or runtime components for this environment yet.';
    }
  }
  return [...groups.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function isRuntimeOrInfrastructureNode(node: CASNode): boolean {
  const type = String(node.type || '').toLowerCase();
  const surface = topologySurface(node.metadata);
  return Boolean(surface) || /^(?:infrastructure|container|compose|docker|kubernetes|terraform|cloudformation|runtime)[_-]/.test(type) || /^(?:infrastructure|container|compose|docker|kubernetes|terraform|cloudformation|runtime)$/.test(type);
}

function environmentProvider(runtimeSurfaces: string[], infrastructureKinds: string[]): string | undefined {
  const text = `${runtimeSurfaces.join(' ')} ${infrastructureKinds.join(' ')}`.toLowerCase();
  if (/aws|terraform/.test(text)) return 'aws';
  if (/gcp|google/.test(text)) return 'gcp';
  if (/azure/.test(text)) return 'azure';
  if (/kubernetes|docker|compose/.test(text)) return 'local-or-orchestrated';
  return undefined;
}

function environmentType(name: string, runtimeSurfaces: string[]): WorkspaceEnvironment['type'] {
  const normalized = String(name || '').toLowerCase();
  if (/local|docker/.test(normalized) || runtimeSurfaces.some(surface => /compose|docker/.test(surface))) return 'local';
  if (/production|staging|demo|internal/.test(normalized) || runtimeSurfaces.some(surface => /terraform|cloudformation|kubernetes/.test(surface))) return 'cloud';
  if (runtimeSurfaces.includes('configuration')) return 'configuration';
  return 'unknown';
}

function buildWorkspaceInfrastructureOverlay(
  runtimeComponents: SystemRuntimeComponent[],
  runtimeLinks: SystemRuntimeLink[],
  applications: SystemApplication[],
): WorkspaceInfrastructureOverlay {
  const appById = new Map(applications.map(app => [app.id, app]));
  const runtimeLinksByComponent = new Map<string, SystemRuntimeLink[]>();
  for (const link of runtimeLinks) {
    runtimeLinksByComponent.set(link.source_component_id, [...(runtimeLinksByComponent.get(link.source_component_id) || []), link]);
    runtimeLinksByComponent.set(link.target_component_id, [...(runtimeLinksByComponent.get(link.target_component_id) || []), link]);
  }
  const infrastructure = runtimeComponents.filter(component =>
    isExternalRuntimeDependency(component.name, component.kind) ||
    /terraform|infrastructure|cloudformation|kubernetes|compose|docker/i.test(`${component.topology_surface} ${component.kind}`)
  );
  if (infrastructure.length === 0) {
    return {
      status: 'not-available',
      summary: 'No runtime or infrastructure topology was present in the repo-level CAS inputs.',
      environments: [],
      app_mappings: [],
      shared_resources: [],
      gaps: ['Repo-level CAS did not provide Docker, Compose, Terraform, Kubernetes, CI, or runtime topology facts.'],
    };
  }

  const deployableMappings = new Map<string, WorkspaceInfrastructureOverlay['app_mappings'][number]>();
  const addMapping = (deployableId: string, component: SystemRuntimeComponent, evidence: string) => {
    const app = appById.get(deployableId);
    if (!app || isExternalRuntimeDependency(app.name, app.kind)) return;
    const existing = deployableMappings.get(deployableId) || {
      deployable_id: deployableId,
      deployable_name: app.name,
      environment: component.environment,
      resource_ids: [],
      resource_names: [],
      evidence: [],
    };
    existing.resource_ids = mergeStrings(existing.resource_ids, [component.id]).slice(0, 40);
    existing.resource_names = mergeStrings(existing.resource_names, [component.name]).slice(0, 20);
    existing.evidence = mergeStrings(existing.evidence, [evidence]).slice(0, 12);
    existing.environment = existing.environment || component.environment;
    deployableMappings.set(deployableId, existing);
  };

  for (const component of infrastructure) {
    if (appById.has(component.application_id)) addMapping(component.application_id, component, `${component.topology_surface}:${component.name}`);
    for (const app of applications) {
      if (componentImpliesDeployable(component, app)) {
        addMapping(app.id, component, `name-match:${component.name}`);
      }
    }
  }

  const envs = new Map<string, WorkspaceInfrastructureOverlay['environments'][number]>();
  for (const component of infrastructure) {
    const env = component.environment || 'unknown';
    const existing = envs.get(env) || { name: env, deployable_ids: [], resource_count: 0, resource_kinds: [], key_resources: [] };
    existing.resource_count += 1;
    existing.resource_kinds = mergeStrings(existing.resource_kinds, [component.kind]).slice(0, 16);
    existing.key_resources = mergeStrings(existing.key_resources, [component.name]).slice(0, 16);
    const mappedApps = [...deployableMappings.values()]
      .filter(mapping => mapping.resource_ids.includes(component.id))
      .map(mapping => mapping.deployable_id);
    existing.deployable_ids = mergeStrings(existing.deployable_ids, mappedApps).slice(0, 30);
    envs.set(env, existing);
  }

  const sharedResources = infrastructure
    .filter(component => isExternalRuntimeDependency(component.name, component.kind))
    .map(component => {
      const links = runtimeLinksByComponent.get(component.id) || [];
      return {
        name: component.name,
        kind: component.kind,
        usage: runtimeComponentUsage(component, runtimeLinks),
        environment: component.environment,
        connected_deployable_ids: mergeStrings(
          [component.application_id].filter(id => appById.has(id)),
          links.flatMap(link => [link.source_component_id, link.target_component_id])
            .map(componentId => runtimeComponents.find(candidate => candidate.id === componentId)?.application_id)
            .filter((id): id is string => Boolean(id && appById.has(id)))
        ).slice(0, 12),
        evidence: [
          component.refs[0]?.file || component.topology_surface,
          ...links.flatMap(link => link.evidence).slice(0, 5),
        ].filter(Boolean),
      };
    })
    .sort((left, right) => usageRank(right.usage) - usageRank(left.usage) || left.name.localeCompare(right.name))
    .slice(0, 40);

  const appMappings = [...deployableMappings.values()].sort((left, right) => right.resource_ids.length - left.resource_ids.length || left.deployable_name.localeCompare(right.deployable_name));
  const mappedResourceIds = new Set(appMappings.flatMap(mapping => mapping.resource_ids));
  const unmappedInfraCount = infrastructure.filter(component => !mappedResourceIds.has(component.id)).length;
  const status: WorkspaceInfrastructureOverlay['status'] = appMappings.length === 0 ? 'inventory-only'
    : unmappedInfraCount > infrastructure.length * 0.5 ? 'partial'
      : 'mapped';
  const cloudKinds = [...new Set(infrastructure.map(component => component.kind).filter(kind => /aws|terraform|infrastructure|compose|docker|kubernetes|ecs|ec2|rds|alb|nlb|s3|iam|route53/i.test(kind)))].slice(0, 8);
  return {
    status,
    summary: `${infrastructure.length} runtime/infrastructure component(s) were lifted from CAS; ${appMappings.length} deployable mapping(s), ${sharedResources.length} shared/runtime dependency item(s), ${envs.size} environment(s). Key surfaces include ${cloudKinds.join(', ') || 'runtime topology'}.`,
    environments: [...envs.values()].sort((left, right) => left.name.localeCompare(right.name)),
    app_mappings: appMappings.slice(0, 60),
    shared_resources: sharedResources,
    gaps: [
      unmappedInfraCount > 0 ? `${unmappedInfraCount} infrastructure component(s) are inventory-only and not yet mapped to a deployable.` : '',
      sharedResources.some(resource => resource.usage !== 'source-backed' && /redis|queue|broker|cache/i.test(resource.name)) ? 'Some declared cache/broker resources have topology evidence but no source-backed usage.' : '',
    ].filter(Boolean),
  };
}

function componentImpliesDeployable(component: SystemRuntimeComponent, app: SystemApplication): boolean {
  const names = deployableInfrastructureNames(app);
  if (names.length === 0) return false;
  const componentText = [
    component.name,
    component.id,
    component.refs?.map(ref => ref.file).join(' '),
  ].join(' ').toLowerCase().replace(/\\/g, '/');
  return names.some(name => delimitedInfrastructureMatch(componentText, name));
}

function deployableInfrastructureNames(app: SystemApplication): string[] {
  const names = new Set<string>();
  const add = (value: string | undefined) => {
    const normalized = normalizeInfrastructureName(value);
    if (!normalized) return;
    names.add(normalized);
  };
  add(app.name);
  add(path.basename(app.path_hint || ''));
  const dockerAliasPattern = /(?:docker image definition:\s*)?(?:.*\/)?([^/\s]+?)(?:\.dockerfile)?$/i;
  for (const alias of app.service_aliases || []) {
    const normalizedAlias = normalizeInfrastructureName(alias);
    if (!normalizedAlias) continue;
    if (normalizedAlias === normalizeInfrastructureName(app.name)) add(alias);
    const match = String(alias || '').match(dockerAliasPattern);
    if (match?.[1] && normalizeInfrastructureName(match[1]) === normalizeInfrastructureName(app.name)) add(match[1]);
  }
  return [...names].filter(name => name.length >= 3);
}

function delimitedInfrastructureMatch(text: string, normalizedName: string): boolean {
  if (!text || !normalizedName) return false;
  const pattern = new RegExp(`(^|[^a-z0-9])${escapeRegExp(normalizedName).replace(/-/g, '[-_ .:/]*')}([^a-z0-9]|$)`, 'i');
  return pattern.test(text);
}

function normalizeInfrastructureName(value: string | undefined): string {
  return String(value || '')
    .toLowerCase()
    .replace(/^compose service:\s*/i, '')
    .replace(/^docker image definition:\s*/i, '')
    .replace(/\.dockerfile$/i, '')
    .replace(/^image:\s*/i, '')
    .replace(/^.*\//, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function buildWorkspaceRiskAreas(
  repositories: CrossCodebaseInput[],
  applications: SystemApplication[],
  interfaces: SystemInterface[],
  applicationLinks: SystemApplicationLink[],
  insights: SystemInsight[],
  unmatchedInterfaces: UnmatchedSystemInterface[],
  activity: WorkspaceActivitySummary,
  telemetry: WorkspaceTelemetrySummary,
  ownership: Record<string, WorkspaceOwnership>,
  lookupIndexes: Map<CASOutput, CrossCodebaseLookupIndex>,
): WorkspaceRiskArea[] {
  const risks: WorkspaceRiskArea[] = [];
  const localChangeRiskBuckets = new Map<string, {
    severity: WorkspaceRiskArea['severity'];
    project_id: string;
    deployable_id?: string;
    deployable_name: string;
    project_path: string;
    node_names: string[];
    files: string[];
    recommendations: string[];
    count: number;
  }>();
  const appById = new Map(applications.map(app => [app.id, app]));
  const interfaceById = new Map(interfaces.map(item => [item.id, item]));
  for (const repository of repositories) {
    const projectId = codebaseId(repository.path);
    const apps = applications.filter(app => app.codebase_id === projectId);
    const appByProjectId = new Map(apps.map(app => [app.id, app]));
    const lookupIndex = lookupIndexes.get(repository.cas)!;
    for (const risk of repository.cas.change_risks || []) {
	      if (!['critical', 'high'].includes(risk.risk_level)) continue;
	      const node = lookupNode(lookupIndex, risk.node_id);
	      if (isLegacyReferenceSource(node?.source?.file)) continue;
	      const app = applicationForFileFromIndex(projectId, node?.source?.file, appByProjectId);
      const bucketId = app?.id || projectId;
      const bucket = localChangeRiskBuckets.get(bucketId) || {
        severity: risk.risk_level,
        project_id: projectId,
        deployable_id: app?.id,
        deployable_name: app?.name || repository.name || repository.cas.system?.name || projectId,
        project_path: repository.path,
        node_names: [],
        files: [],
        recommendations: [],
        count: 0,
      };
      bucket.severity = severityRank(risk.risk_level) > severityRank(bucket.severity) ? risk.risk_level : bucket.severity;
      bucket.count += 1;
      bucket.node_names = mergeStrings(bucket.node_names, [node?.name || risk.node_id]).slice(0, 8);
      bucket.files = mergeStrings(bucket.files, [node?.source?.file || '']).filter(Boolean).slice(0, 8);
      bucket.recommendations = mergeStrings(bucket.recommendations, risk.recommendations || []).slice(0, 6);
      localChangeRiskBuckets.set(bucketId, bucket);
    }
  }
  for (const [bucketId, bucket] of localChangeRiskBuckets) {
    risks.push({
      id: `${bucket.project_id}:risk-surface:${slugify(bucketId)}`,
      severity: bucket.severity,
      title: `${bucket.deployable_name} concentrates ${bucket.count} high-risk change point(s)`,
      reason: `CAS marked ${bucket.count} local node(s) as high-risk under this workspace surface. Representative nodes: ${bucket.node_names.slice(0, 4).join(', ')}.`,
      project_ids: [bucket.project_id],
      deployable_ids: bucket.deployable_id ? [bucket.deployable_id] : [],
      interface_ids: [],
      confidence: Math.min(0.9, 0.7 + Math.min(0.16, bucket.count * 0.02)),
      evidence: [...bucket.files.slice(0, 4), ...bucket.recommendations.slice(0, 2)].filter(Boolean).slice(0, 8),
      next_mcp_calls: [{ tool: 'get_agent_context', args: { path: bucket.project_path, task: { target: bucket.deployable_name, task_type: 'modify' } } }],
    });
  }
  for (const hotspot of activity.hotspots.slice(0, 8)) {
    risks.push({
      id: `${hotspot.project_id}:activity:${slugify(hotspot.node_id || hotspot.label)}`,
      severity: hotspot.score >= 35 ? 'high' : 'medium',
      title: `${hotspot.label} is an activity hotspot`,
      reason: hotspot.reason,
      project_ids: [hotspot.project_id],
      deployable_ids: hotspot.deployable_id ? [hotspot.deployable_id] : [],
      interface_ids: [],
      confidence: 0.72,
      evidence: [hotspot.reason],
      next_mcp_calls: [{ tool: 'get_hot_spots', args: { path: appById.get(hotspot.deployable_id || '')?.codebase_path || '<project path>', limit: 20 } }],
    });
  }
  for (const insight of insights.filter(item => item.type === 'declared-unused-infrastructure')) {
    risks.push({
      id: `${insight.id}:risk`,
      severity: 'medium',
      title: insight.title,
      reason: insight.description,
      project_ids: insight.codebase_ids,
      deployable_ids: insight.application_ids,
      interface_ids: [],
      confidence: insight.confidence,
      evidence: insight.evidence,
      next_mcp_calls: [{ tool: 'get_workspace_analysis', args: { analysis_id_or_name: '<workspace>', detail_level: 'evidence' } }],
    });
  }
  for (const item of unmatchedInterfaces.filter(item => item.role === 'consumer').slice(0, 10)) {
    const app = interfaceById.get(item.interface_id);
    risks.push({
      id: `${item.interface_id}:unmatched-risk`,
      severity: 'low',
      title: `${item.name} is unmatched`,
      reason: item.reason,
      project_ids: [item.codebase_id],
      deployable_ids: app?.application_id ? [app.application_id] : [],
      interface_ids: [item.interface_id],
      confidence: 0.6,
      evidence: [item.key],
      next_mcp_calls: [{ tool: 'get_workspace_analysis', args: { analysis_id_or_name: '<workspace>', detail_level: 'evidence' } }],
    });
  }
  if (telemetry.status === 'not-configured' || telemetry.status === 'not-instrumented') {
    const criticalApps = applications.filter(app => ownership[app.id]?.tier === 'critical').slice(0, 8);
    if (criticalApps.length) {
      risks.push({
        id: 'workspace:risk:telemetry-gap',
        severity: 'medium',
        title: 'Critical surfaces lack observed telemetry',
        reason: telemetry.guidance.join(' '),
        project_ids: [...new Set(criticalApps.map(app => app.codebase_id))],
        deployable_ids: criticalApps.map(app => app.id),
        interface_ids: [],
        confidence: 0.7,
        evidence: criticalApps.map(app => app.name),
        next_mcp_calls: [{ tool: 'get_runtime_instrumentation_plan', args: { path: '<critical project path>' } }],
      });
    }
  }
  return risks
    .sort((left, right) => severityRank(right.severity) - severityRank(left.severity) || right.confidence - left.confidence)
    .slice(0, 40);
}

function isLegacyReferenceSource(file: string | undefined): boolean {
  const normalized = String(file || '').replace(/\\/g, '/').toLowerCase();
  return normalized.startsWith('legacy/') || normalized.includes('/legacy/');
}

function buildWorkspaceHealth(
  repositories: CrossCodebaseInput[],
  risks: WorkspaceRiskArea[],
  telemetry: WorkspaceTelemetrySummary,
): WorkspaceHealth {
  const trusts = repositories.map(repository => analysisTrust(repository.cas));
  const critical = risks.filter(risk => risk.severity === 'critical').length;
  const high = risks.filter(risk => risk.severity === 'high').length;
  const medium = risks.filter(risk => risk.severity === 'medium').length;
  const trustPenalty = trusts.filter(trust => trust.status === 'missing-required-facts').length * 18
    + trusts.filter(trust => trust.status === 'stale').length * 10
    + trusts.filter(trust => trust.status === 'warn').length * 4;
  const riskPenalty = Math.min(55, critical * 10 + high * 6 + medium * 2);
  const score = Math.max(10, 100 - riskPenalty - trustPenalty);
  const status: WorkspaceHealth['status'] = score >= 85 ? 'healthy' : score >= 65 ? 'watch' : score >= 35 ? 'at-risk' : 'unknown';
  return {
    status,
    score,
    summary: `${risks.length} workspace risk area(s), ${trusts.filter(trust => trust.status === 'ready').length}/${trusts.length} CAS inputs ready, telemetry ${telemetry.status}.`,
    risk_area_count: risks.length,
    critical_risk_count: critical,
    high_risk_count: high,
    telemetry_status: telemetry.status,
    analysis_trust: {
      ready_inputs: trusts.filter(trust => trust.status === 'ready').length,
      warning_inputs: trusts.filter(trust => trust.status === 'warn').length,
      stale_inputs: trusts.filter(trust => trust.status === 'stale').length,
      missing_required_fact_inputs: trusts.filter(trust => trust.status === 'missing-required-facts').length,
    },
  };
}

function buildWorkspaceQualityFlags(
  narrative: WorkspaceNarrative,
  capabilities: WorkspaceCapability[],
  domains: WorkspaceDomain[],
  entities: WorkspaceEntity[],
  codebases: SystemCodebase[],
  interfaces: SystemInterface[],
  applicationLinks: SystemApplicationLink[],
  unmatchedInterfaces: UnmatchedSystemInterface[],
): WorkspaceQualityFlag[] {
  const flags: WorkspaceQualityFlag[] = [];
  const defaultCapabilities = capabilities.slice(0, 8);
  const defaultDomains = domains.slice(0, 6);
  const degradedCapabilities = defaultCapabilities.filter(item => !isRequiredWorkspaceSemanticDescriptionReady(item.name, item.description, item.description_source, 'capability'));
  const degradedDomains = defaultDomains.filter(item => !isRequiredWorkspaceSemanticDescriptionReady(item.name, item.description, item.description_source, 'domain'));
  const lazyCapabilityDescriptions = capabilities.slice(8).filter(item => item.description_source !== 'ai');
  const lazyDomainDescriptions = domains.slice(6).filter(item => item.description_source !== 'ai');
  const degradedEntities = entities.filter(item => item.description_source !== 'ai');
  const prototypeProjects = codebases.filter(project => project.project_role === 'prototype' || project.project_role === 'demo');
  if (narrative.source !== 'ai') {
    flags.push({
      severity: 'warn',
      code: 'workspace-narrative-ai-degraded',
      message: 'The default workspace description is degraded because interpretation did not complete.',
      evidence: [narrative.degraded_reason || narrative.source],
    });
  }
  if (degradedCapabilities.length > 0) {
    flags.push({
      severity: 'warn',
      code: 'capability-descriptions-degraded',
      message: `${degradedCapabilities.length}/${defaultCapabilities.length} default primary workspace capability descriptions are degraded and should be refreshed before customer-facing use.`,
      evidence: degradedCapabilities.slice(0, 6).map(item => item.name),
    });
  }
  if (lazyCapabilityDescriptions.length > 0) {
    flags.push({
      severity: 'info',
      code: 'lazy-capability-descriptions-degraded',
      message: `${lazyCapabilityDescriptions.length}/${Math.max(0, capabilities.length - defaultCapabilities.length)} non-primary workspace capability descriptions remain deterministic and can be generated lazily.`,
      evidence: lazyCapabilityDescriptions.slice(0, 6).map(item => item.name),
    });
  }
  if (degradedDomains.length > 0) {
    flags.push({
      severity: 'warn',
      code: 'domain-descriptions-degraded',
      message: `${degradedDomains.length}/${defaultDomains.length} default workspace domain descriptions are degraded.`,
      evidence: degradedDomains.slice(0, 6).map(item => item.name),
    });
  }
  if (lazyDomainDescriptions.length > 0) {
    flags.push({
      severity: 'info',
      code: 'lazy-domain-descriptions-degraded',
      message: `${lazyDomainDescriptions.length}/${Math.max(0, domains.length - defaultDomains.length)} non-primary workspace domain descriptions remain deterministic and can be generated lazily.`,
      evidence: lazyDomainDescriptions.slice(0, 6).map(item => item.name),
    });
  }
  if (degradedEntities.length > Math.max(4, Math.ceil(entities.length * 0.5))) {
    flags.push({
      severity: 'info',
      code: 'entity-descriptions-degraded',
      message: `${degradedEntities.length}/${entities.length} workspace entity descriptions are deterministic lineage summaries; use get_workspace_entity_map and repo-level data lineage for details.`,
      evidence: degradedEntities.slice(0, 8).map(item => item.name),
    });
  }
  if (prototypeProjects.length > 0) {
    flags.push({
      severity: 'info',
      code: 'prototype-or-demo-projects-present',
      message: `${prototypeProjects.length} prototype/demo project(s) are included; agents should avoid treating them as production truth without corroborating evidence.`,
      evidence: prototypeProjects.slice(0, 8).map(project => project.name),
    });
  }
  const unmatchedByMode = countBy(unmatchedInterfaces, item => item.mode);
  const linkedModes = new Set(applicationLinks.map(link => link.mode));
  const unresolvedModes = Object.entries(unmatchedByMode)
    .filter(([mode, count]) => Number(count) > 0 && !linkedModes.has(mode as SystemInterfaceMode))
    .map(([mode, count]) => `${mode}:${count}`);
  const candidateLinks = applicationLinks.filter(link => !isTrustedWorkspaceApplicationLink(link)).length;
  const providerConsumerInterfaces = interfaces.filter(item => ['provider', 'consumer', 'publisher', 'listener'].includes(item.role)).length;
  if (unresolvedModes.length > 0 || candidateLinks > Math.max(3, Math.ceil(providerConsumerInterfaces * 0.08))) {
    flags.push({
      severity: 'warn',
      code: 'workspace-links-need-evidence-review',
      message: 'Some workspace communication surfaces are unresolved or candidate-only; agents must verify source evidence before changing cross-project behavior.',
      evidence: [
        unresolvedModes.length ? `unresolved_modes=${unresolvedModes.join(',')}` : '',
        candidateLinks ? `candidate_links=${candidateLinks}` : '',
      ].filter(Boolean),
    });
  }
  return flags;
}

function criticalityRank(value: WorkspaceCapability['criticality']): number {
  return value === 'critical' ? 4 : value === 'high' ? 3 : value === 'medium' ? 2 : 1;
}

function severityRank(value: WorkspaceRiskArea['severity']): number {
  return value === 'critical' ? 4 : value === 'high' ? 3 : value === 'medium' ? 2 : 1;
}

function titleizeDomain(value: string | undefined): string {
  if (/[<>]/.test(String(value || ''))) return '';
  const normalized = String(value || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/[<>]/g, ' ')
    .replace(/[-_]+/g, ' ')
    .replace(/\b(api|service|controller|entity|model|dto|schema|table|repo|repository|manager)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized || normalized.length < 3) return '';
  return normalized.split(' ')

    .map(part => part.replace(/^[^a-z0-9]+|[^a-z0-9]+$/gi, ''))
    .filter(Boolean)
    .slice(0, 4)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function isFixtureOrTestCasNode(node: any): boolean {
  if (node?.metadata?.is_test || node?.metadata?.is_generated) return true;
  const file = String(node?.source?.file || node?.name || '').replace(/\\/g, '/').toLowerCase();
  if (!file) return false;
  if (/(^|\/)(node_modules|dist|build|coverage|vendor|vendors|generated|fixtures?|__fixtures__|__mocks__)(\/|$)/.test(file)) return true;
  if (/(^|\/)(__tests__|tests?|spec|e2e|cypress|playwright)(\/|$)/.test(file)) return true;
  if (/\.(test|spec|stories|story)\.[a-z0-9]+$/.test(file)) return true;
  return false;
}

export function productFrameworksFromCas(cas: any): string[] {

  const declared = ((cas?.system?.technologies?.frameworks || []) as Array<{ name?: string }>)
    .map(framework => String(framework?.name || '').trim())
    .filter(Boolean);
  if (declared.length === 0) return [];
  const productFrameworks = new Set<string>();
  const fixtureFrameworks = new Set<string>();
  for (const node of (cas?.nodes || []) as any[]) {
    const framework = String(node?.metadata?.framework || '').trim().toLowerCase();
    if (!framework) continue;
    if (isFixtureOrTestCasNode(node)) fixtureFrameworks.add(framework);
    else productFrameworks.add(framework);
  }
  return declared.filter(name => {
    const normalized = name.toLowerCase();

    if (fixtureFrameworks.has(normalized) && !productFrameworks.has(normalized)) return false;
    return true;
  });
}

function toSystemCodebase(repository: CrossCodebaseInput): SystemCodebase {
  const cas = repository.cas;
  const packages = directPackages(cas).map(pkg => pkg.name).sort();
  const sdkPackageNames = sdkPackageCandidates(repository);
  return {
    id: codebaseId(repository.path),

    name: sanitizeDeployableName(repository.name || cas.system?.name || path.basename(repository.path), repository),
    path: repository.path,
    project_role: inferProjectRole(repository),
    system_type: String(cas.enhanced_system_purpose?.artifact_type || cas.system?.type || 'application'),
    primary_domain: String((cas as any).enhanced_system_purpose?.primary_domain || '').trim() || undefined,
    description: String((cas as any).enhanced_system_purpose?.inferred_description || '').trim() || undefined,
    languages: (cas.system?.technologies?.languages || []).map(language => language.name).filter(Boolean),

    frameworks: productFrameworksFromCas(cas),
    packages,
    sdk_package_names: sdkPackageNames,
    graph: {
      nodes: cas.nodes?.length || 0,
      edges: cas.edges?.length || 0,
      entry_points: cas.entry_points?.length || 0,
      exit_points: cas.exit_points?.length || 0,
    },
  };
}

function inferProjectRole(repository: CrossCodebaseInput): SystemCodebase['project_role'] {
  const name = `${repository.name || ''} ${path.basename(repository.path || '')} ${repository.cas.system?.name || ''}`.toLowerCase();
  const systemType = String(repository.cas.system?.type || '').toLowerCase();
  if (/(^|[-_\s])(demo|example|sample)([-_\s]|$)/.test(name)) return 'demo';
  if (/(^|[-_\s])(poc|prototype|spike|experiment|old|archive|archived)([-_\s]|$)/.test(name)) return 'prototype';
  if (/(infra|infrastructure|terraform|pulumi|cloudformation|kubernetes|helm|ops)/.test(name) || systemType === 'infrastructure') return 'infrastructure';
  if (/(ci|jenkins|build|release|deploy|pipeline)/.test(name)) return 'tooling';
  if (systemType === 'library' || systemType === 'package' || /(sdk|library|package|shared)/.test(name)) return 'library';
  if (/(api|ui|app|service|mobile|backend|frontend|server|worker|client)/.test(name) || systemType === 'application' || systemType === 'service') return 'production';
  return 'unknown';
}

function extractInterfaces(repository: CrossCodebaseInput, id: string, lookupIndex: CrossCodebaseLookupIndex): SystemInterface[] {
  const interfaces: SystemInterface[] = [];
  const providerHttpKeys = new Set<string>();
  const cas = repository.cas;
  const base = {
    codebase_id: id,
    codebase_path: repository.path,
  };

  for (const entryPoint of cas.entry_points || []) {
    const httpProvider = isHttpProvider(entryPoint);
    const messageListener = isMessageListener(entryPoint);
    const refs = httpProvider || messageListener ? entryRefs(lookupIndex, entryPoint) : [];
    if (httpProvider) {
      const endpoint = entryPoint.trigger?.path || entryPoint.name;
      const method = normalizeHttpMethod(entryPoint.trigger?.method) || 'ALL';
      const key = httpKey(method, endpoint);
      interfaces.push({
        ...base,
        application_id: applicationId(id, inferApplicationName(repository, refs, entryServiceAliases(entryPoint), endpoint)),
        id: interfaceId(id, 'provider-http', entryPoint.id),
        kind: 'http-api',
        role: 'provider',
        mode: isStreamEntry(entryPoint) ? 'stream' : 'sync',
        name: `${method} ${endpoint}`,
        key,
        protocol: isStreamEntry(entryPoint) ? 'websocket' : 'http',
        method,
        endpoint,
        service_aliases: entryServiceAliases(entryPoint),
        topology_surface: topologySurface(entryPoint.metadata),
        refs,
        evidence: [{ kind: 'entry_point', id: entryPoint.id, confidence: 0.9 }],
      });
      providerHttpKeys.add(key);
    }

    if (messageListener) {
      const topic = normalizeTopic(entryPoint.trigger?.event || entryPoint.name);
      interfaces.push({
        ...base,
        application_id: applicationId(id, inferApplicationName(repository, refs, [], entryPoint.name)),
        id: interfaceId(id, 'listener-message', entryPoint.id),
        kind: isStreamEntry(entryPoint) ? 'stream' : 'message',
        role: 'listener',
        mode: isStreamEntry(entryPoint) ? 'stream' : 'async',
        name: entryPoint.name,
        key: topic,
        topic,
        schema: entryPoint.input?.schema || entryPoint.input?.type,
        refs,
        evidence: [{ kind: 'entry_point', id: entryPoint.id, confidence: 0.9 }],
      });
    }
  }

  for (const route of cas.route_table || []) {
    const endpoint = route.path;
    const method = normalizeHttpMethod(route.method) || 'ALL';
    const key = httpKey(method, endpoint);
    if (providerHttpKeys.has(key)) continue;
      const routeId = `${method}:${endpoint}:${route.controller}.${route.handler}`;
      const refs = route.source_node ? nodeRefs(lookupIndex, [route.source_node]) : [];
    interfaces.push({
      ...base,
      application_id: applicationId(id, inferApplicationName(repository, refs, routeServiceAliases(route, refs), endpoint)),
      id: interfaceId(id, 'provider-route', routeId),
      kind: 'http-api',
      role: 'provider',
      mode: 'sync',
      name: `${method} ${endpoint}`,
      key,
      protocol: 'http',
      method,
      endpoint,
      service_aliases: routeServiceAliases(route, refs),
      topology_surface: topologySurface((route as any).metadata),
      refs,
      evidence: [{ kind: 'entry_point', id: routeId, confidence: 0.75 }],
    });
    providerHttpKeys.add(key);
  }

  for (const exitPoint of cas.exit_points || []) {
    const refs = exitRefs(lookupIndex, exitPoint);
    const sourceAliases = sourceNodeServiceAliases(lookupIndex, exitPoint.source_node);
    if (isHttpConsumer(exitPoint)) {
      const endpoint = exitPoint.target?.endpoint || exitPoint.target?.resource || exitPoint.name;
      if (!isConcreteHttpConsumerEndpoint(endpoint, exitPoint)) continue;
      const method = normalizeHttpMethod(exitPoint.operation?.method || exitPoint.operation?.action) || 'FETCH';
      interfaces.push({
        ...base,

        application_id: applicationId(id, inferApplicationName(repository, refs, sourceAliases, '')),
        id: interfaceId(id, 'consumer-http', exitPoint.id),
        kind: 'http-api',
        role: 'consumer',
        mode: exitPoint.operation?.async ? 'async' : 'sync',
        name: `${method} ${endpoint}`,
        key: httpKey(method, endpoint),
        protocol: 'http',
        method,
        endpoint,
        service_aliases: exitServiceAliases(exitPoint),
        topology_surface: topologySurface(exitPoint.metadata),
        refs,
        evidence: [{ kind: 'exit_point', id: exitPoint.id, confidence: 0.85 }],
      });
    }

    if (exitPoint.type === 'sdk') {
      const packageName = normalizePackageName(exitPoint.target?.sdk || exitPoint.target?.resource || exitPoint.name);
      if (packageName && isSystemPackageConsumer(packageName) && !looksLikePlatformPackage(packageName)) {
        interfaces.push({
          ...base,
          application_id: applicationId(id, inferApplicationName(repository, refs, sourceAliases, packageName)),
          id: interfaceId(id, 'consumer-sdk', exitPoint.id),
          kind: 'sdk',
          role: 'consumer',
          mode: 'sync',
          name: packageName,
          key: packageName,
          package_name: packageName,
          refs,
          evidence: [{ kind: 'exit_point', id: exitPoint.id, confidence: 0.82 }],
        });
      }
    }

    if (isMessagePublisher(exitPoint)) {
      const topic = normalizeTopic(exitPoint.target?.resource || exitPoint.name);
      interfaces.push({
        ...base,
        application_id: applicationId(id, inferApplicationName(repository, refs, sourceAliases, topic)),
        id: interfaceId(id, 'publisher-message', exitPoint.id),
        kind: isStreamExit(exitPoint) ? 'stream' : 'message',
        role: 'publisher',
        mode: isStreamExit(exitPoint) ? 'stream' : 'async',
        name: exitPoint.name,
        key: topic,
        topic,
        schema: exitPoint.data?.output_type,
        refs,
        evidence: [{ kind: 'exit_point', id: exitPoint.id, confidence: 0.9 }],
      });
    }

    if (exitPoint.type === 'database') {
      const resource = normalizeResource(exitPoint.target?.resource || exitPoint.name);
      if (!isSpecificSharedResource(resource)) continue;
      const role = passiveDataOperationRole(exitPoint.operation?.action || exitPoint.operation?.method);
      interfaces.push({
        ...base,
        application_id: applicationId(id, inferApplicationName(repository, refs, sourceAliases, resource)),
        id: interfaceId(id, 'passive-data-exit', exitPoint.id),
        kind: 'passive-data',
        role,
        mode: 'passive',
        name: exitPoint.name,
        key: resource,
        resource,
        refs,
        evidence: [{ kind: 'exit_point', id: exitPoint.id, confidence: 0.78 }],
      });
    }
  }

  for (const service of cas.external_services || []) {
    const packageName = normalizePackageName(service.name || service.id);
    const refs = nodeRefs(lookupIndex, service.connected_nodes || []);
    if (!service.endpoint && isWorkspaceRelevantExternalDependency(packageName)) {
      interfaces.push({
        ...base,
        application_id: applicationId(id, inferApplicationName(repository, refs, [], service.name || packageName)),
        id: interfaceId(id, 'consumer-service-sdk', service.id || packageName),
        kind: 'sdk',
        role: 'consumer',
        mode: 'sync',
        name: displayExternalDependencyName(packageName),
        key: packageName,
        package_name: packageName,
        refs,
        evidence: [{ kind: 'external_service', id: service.id || packageName, confidence: 0.82 }],
      });
      continue;
    }
    if (!service.endpoint) continue;
    const endpoint = service.endpoint;
    if (!isConcreteHttpConsumerEndpoint(endpoint)) continue;
    interfaces.push({
      ...base,
      application_id: applicationId(id, inferApplicationName(repository, refs, serviceAliasesFromEndpoint(endpoint), endpoint)),
      id: interfaceId(id, 'consumer-service', service.id),
      kind: service.type?.toLowerCase().includes('websocket') ? 'stream' : 'http-api',
      role: 'consumer',
      mode: service.type?.toLowerCase().includes('websocket') ? 'stream' : 'sync',
      name: service.name || endpoint,
      key: httpKey('FETCH', endpoint),
      protocol: service.type || 'http',
      method: 'FETCH',
      endpoint,
      service_aliases: serviceAliasesFromEndpoint(endpoint),
      refs,
      evidence: [{ kind: 'external_service', id: service.id, confidence: 0.75 }],
    });
  }

  for (const pkg of directPackages(cas)) {
    const packageName = normalizePackageName(pkg.name);
    if (!packageName) continue;
    if (isWorkspaceRelevantExternalDependency(packageName)) {
      interfaces.push({
        ...base,
        application_id: applicationId(id, inferApplicationName(repository, [], [], packageName)),
        id: interfaceId(id, 'consumer-external-package', packageName),
        kind: 'sdk',
        role: 'consumer',
        mode: 'sync',
        name: displayExternalDependencyName(packageName),
        key: packageName,
        package_name: packageName,
        refs: [],
        evidence: [{ kind: 'dependency', id: packageName, confidence: 0.7 }],
      });
      continue;
    }
    if (looksLikePlatformPackage(packageName)) continue;
    if (!isSystemPackageConsumer(packageName)) continue;
    interfaces.push({
      ...base,
      application_id: applicationId(id, inferApplicationName(repository, [], [], packageName)),
      id: interfaceId(id, 'consumer-package', packageName),
      kind: 'sdk',
      role: 'consumer',
      mode: 'sync',
      name: packageName,
      key: packageName,
      package_name: packageName,
      refs: [],
      evidence: [{ kind: 'dependency', id: packageName, confidence: 0.7 }],
    });
  }

  for (const packageName of sdkPackageCandidates(repository)) {
    const refs = providerSdkRefs(lookupIndex);
    interfaces.push({
      ...base,
      application_id: applicationId(id, inferApplicationName(repository, refs, [], packageName)),
      id: interfaceId(id, 'provider-sdk', packageName),
      kind: 'sdk',
      role: 'provider',
      mode: 'sync',
      name: packageName,
      key: packageName,
      package_name: packageName,
      refs,
      evidence: [{ kind: 'schema', id: packageName, confidence: 0.72 }],
    });
  }

  for (const dataEntity of cas.entities || []) {
    const resource = normalizeResource(dataEntity.name);
    if (!isSpecificSharedResource(resource)) continue;
    const writers = [
      ...(dataEntity.lifecycle?.created_by || []),
      ...(dataEntity.lifecycle?.updated_by || []),
      ...(dataEntity.lifecycle?.deleted_by || []),
    ];
    const readers = dataEntity.lifecycle?.read_by || [];
    const role = passiveDataLifecycleRole(writers, readers);
    const nodeIds = role === 'publisher' ? writers : role === 'listener' ? readers : [...writers, ...readers];
    const refs = nodeRefs(lookupIndex, nodeIds);
    interfaces.push({
      ...base,
      application_id: applicationId(id, inferApplicationName(repository, refs, [], dataEntity.name)),
      id: interfaceId(id, 'passive-data-entity', dataEntity.id || dataEntity.name),
      kind: 'passive-data',
      role,
      mode: 'passive',
      name: dataEntity.name,
      key: resource,
      resource,
      refs,
      evidence: [{ kind: 'schema', id: dataEntity.id || dataEntity.name, confidence: 0.68 }],
    });
  }

  return dedupeInterfaces(interfaces);
}

function extractRuntimeComponents(repository: CrossCodebaseInput, id: string): SystemRuntimeComponent[] {
  return (repository.cas.nodes || [])
    .filter(node => topologySurface(node.metadata))
    .filter(node => topologySurface(node.metadata) !== 'distribution-artifacts')
    .map(node => {
      const metadata = (node.metadata || {}) as Record<string, any>;
      const attributes = (metadata.attributes || {}) as Record<string, any>;
      const aliases = normalizeAliases(
        metadata.service_aliases,
        metadata.deployment_service_name,
        attributes.service_aliases,
        attributes.deployment_service_name,
        node.name.replace(/^Compose service:\s*/i, ''),
      );
      return {
        id: runtimeComponentId(id, node.id),
        codebase_id: id,
        application_id: applicationId(id, runtimeComponentApplicationName(repository, node, aliases)),
        codebase_path: repository.path,
        name: runtimeComponentName(node),
        kind: node.type,
        topology_surface: topologySurface(node.metadata) || 'runtime-topology',
        environment: runtimeEnvironment(node),
        service_aliases: aliases,
        ports: runtimeComponentPorts(node),
        refs: [nodeRef(node)],
      };
    });
}

function buildLinks(interfaces: SystemInterface[], appById: Map<string, SystemApplication>): SystemLink[] {
  const links: SystemLink[] = [];
  const providers = interfaces.filter(item => item.kind !== 'passive-data' && (item.role === 'provider' || item.role === 'listener' || item.role === 'shared'));
  const consumers = interfaces.filter(item => item.kind !== 'passive-data' && (item.role === 'consumer' || item.role === 'publisher' || item.role === 'shared'));
  const interfaceById = new Map(interfaces.map(item => [item.id, item]));

  for (const consumer of consumers) {
    const consumerLinks: SystemLink[] = [];
    for (const provider of providers) {
      if (consumer.codebase_id === provider.codebase_id && !canLinkWithinSameCodebase(consumer, provider)) continue;
      const match = matchInterfaces(consumer, provider, appById);
      if (!match) continue;
      if (match.kind === 'shared-data' && consumer.id.localeCompare(provider.id) > 0) continue;
      const evidenceQuality = linkEvidenceQuality(consumer, provider, match.kind);
      consumerLinks.push({
        id: linkId(match.kind, consumer.id, provider.id),
        kind: match.kind,
        mode: match.mode,
        source_interface_id: consumer.id,
        target_interface_id: provider.id,
        source_codebase_id: consumer.codebase_id,
        target_codebase_id: provider.codebase_id,
        source_application_id: consumer.application_id,
        target_application_id: provider.application_id,
        confidence: adjustLinkConfidence(match.confidence, evidenceQuality),
        evidence_quality: evidenceQuality,
        evidence: [
          `${evidenceQuality}:${consumer.codebase_id}:${consumer.name}`,
          `${evidenceQuality}:${provider.codebase_id}:${provider.name}`,
          ...consumer.refs.slice(0, 2).map(ref => `consumer:${ref.file || ref.name || ref.id}`),
          ...provider.refs.slice(0, 2).map(ref => `provider:${ref.file || ref.name || ref.id}`),
        ],
      });
    }
    links.push(...bestLinksForConsumer(consumerLinks, interfaceById));
  }

  links.push(...buildPassiveDataLinks(
    interfaces,
    canLinkWithinSameCodebase,
    (source, target) => linkEvidenceQuality(source, target, 'shared-data'),
    quality => adjustLinkConfidence(0.76, quality),
  ));

  return dedupeLinks(links);
}

function linkEvidenceQuality(
  source: SystemInterface,
  target: SystemInterface,
  kind: SystemLink['kind'],
): WorkspaceLinkEvidenceQuality {
  if (kind === 'sdk-install') return 'package-declared';
  if (source.topology_surface || target.topology_surface) return 'topology-backed';
  if (kind === 'message-flow' || kind === 'stream-flow' || kind === 'shared-data') return 'source-backed';
  const sourceHasSourceFile = source.refs.some(ref => Boolean(ref.file));
  const targetHasSourceFile = target.refs.some(ref => Boolean(ref.file));
  if (kind === 'http-call') {
    const sourceHost = concreteEndpointHost(source.endpoint);
    const targetHost = target.endpoint ? concreteEndpointHost(target.endpoint) : undefined;
    if (sourceHasSourceFile && targetHasSourceFile && sourceHost && interfaceMatchesHost(target, sourceHost)) return 'source-backed';
    if (
      source.codebase_id === target.codebase_id &&
      sourceHasSourceFile &&
      targetHasSourceFile &&
      !sourceHost &&
      source.endpoint &&
      target.endpoint
    ) return 'source-backed';
    if (sourceHost || targetHost || httpCompatible(source, target)) return 'route-shape-inferred';
  }
  return sourceHasSourceFile || targetHasSourceFile ? 'route-shape-inferred' : 'name-inferred';
}

function adjustLinkConfidence(confidence: number, quality: WorkspaceLinkEvidenceQuality): number {
  const capByQuality: Record<WorkspaceLinkEvidenceQuality, number> = {
    'source-backed': 0.96,
    'package-declared': 0.9,
    'topology-backed': 0.78,
    'route-shape-inferred': 0.72,
    'name-inferred': 0.62,
  };
  const floorByQuality: Record<WorkspaceLinkEvidenceQuality, number> = {
    'source-backed': 0.74,
    'package-declared': 0.74,
    'topology-backed': 0.62,
    'route-shape-inferred': 0.5,
    'name-inferred': 0.42,
  };
  return Math.max(floorByQuality[quality], Math.min(capByQuality[quality], confidence));
}

function buildRuntimeLinks(
  components: SystemRuntimeComponent[],
  interfaces: SystemInterface[],
  links: SystemLink[],
  repositories: CrossCodebaseInput[],
): SystemRuntimeLink[] {
  const componentByRef = new Map<string, SystemRuntimeComponent>();
  const componentByAlias = new Map<string, SystemRuntimeComponent[]>();
  for (const component of components) {
    for (const ref of component.refs) componentByRef.set(`${component.codebase_id}:${ref.id}`, component);
    for (const alias of component.service_aliases) {
      const key = `${component.codebase_id}:${alias}`;
      componentByAlias.set(key, [...(componentByAlias.get(key) || []), component]);
    }
  }
  const interfaceById = new Map(interfaces.map(item => [item.id, item]));
  const runtimeLinks: SystemRuntimeLink[] = [];

  for (const link of links) {
    if (link.source_codebase_id !== link.target_codebase_id) continue;
    const source = interfaceById.get(link.source_interface_id);
    const target = interfaceById.get(link.target_interface_id);
    if (!source?.topology_surface || !target?.topology_surface) continue;
    const sourceComponent = runtimeComponentForInterface(source, componentByRef, componentByAlias);
    const targetComponent = runtimeComponentForInterface(target, componentByRef, componentByAlias);
    if (!sourceComponent || !targetComponent || sourceComponent.id === targetComponent.id) continue;
    runtimeLinks.push({
      id: `runtime:${link.id}`,
      codebase_id: source.codebase_id,
      source_component_id: sourceComponent.id,
      target_component_id: targetComponent.id,
      kind: link.kind,
      mode: link.mode,
      confidence: link.confidence,
      evidence: link.evidence,
    });
  }

  runtimeLinks.push(...buildComposeDependencyRuntimeLinks(repositories, components));
  runtimeLinks.push(...buildTopologyRuntimeLinks(components, interfaces));

  return dedupeRuntimeLinks(runtimeLinks);
}

function buildComposeDependencyRuntimeLinks(
  repositories: CrossCodebaseInput[],
  components: SystemRuntimeComponent[],
): SystemRuntimeLink[] {
  const componentByNodeId = new Map<string, SystemRuntimeComponent>();
  for (const component of components) {
    for (const ref of component.refs) componentByNodeId.set(`${component.codebase_id}:${ref.id}`, component);
  }
  const links: SystemRuntimeLink[] = [];
  for (const repository of repositories) {
    const id = codebaseId(repository.path);
    for (const edge of repository.cas.edges || []) {
      if (!isComposeDependencyEdge(edge)) continue;
      const sourceComponent = componentByNodeId.get(`${id}:${edge.source}`);
      const targetComponent = componentByNodeId.get(`${id}:${edge.target}`);
      if (!sourceComponent || !targetComponent || sourceComponent.id === targetComponent.id) continue;
      links.push({
        id: `runtime:compose-dependency:${slugify(edge.id || `${edge.source}:${edge.target}`)}`,
        codebase_id: id,
        source_component_id: sourceComponent.id,
        target_component_id: targetComponent.id,
        kind: 'http-call',
        mode: 'sync',
        confidence: adjustLinkConfidence(0.82, 'topology-backed'),
        evidence: [
          `compose-dependency:${sourceComponent.name} depends_on ${targetComponent.name}`,
          `topology-backed:${id}:${edge.id || edge.source}`,
        ],
      });
    }
  }
  return links;
}

function isComposeDependencyEdge(edge: CASOutput['edges'][number]): boolean {
  const type = String((edge as any).type || (edge as any).relationship_type || '').toLowerCase();
  if (type !== 'depends_on') return false;
  const metadata = ((edge as any).metadata || {}) as Record<string, unknown>;
  return metadata.dependency_kind === 'compose-service' || metadata.topology_surface === 'docker-compose';
}

function buildTopologyRuntimeLinks(
  components: SystemRuntimeComponent[],
  interfaces: SystemInterface[],
): SystemRuntimeLink[] {
  const componentByAlias = new Map<string, SystemRuntimeComponent[]>();
  const componentByApplication = new Map<string, SystemRuntimeComponent[]>();
  for (const component of components) {
    for (const alias of normalizeAliases(component.service_aliases)) {
      const key = `${component.codebase_id}:${alias}`;
      componentByAlias.set(key, [...(componentByAlias.get(key) || []), component]);
    }
    const appKey = `${component.codebase_id}:${component.application_id}`;
    componentByApplication.set(appKey, [...(componentByApplication.get(appKey) || []), component]);
  }

  const links: SystemRuntimeLink[] = [];
  const seen = new Set<string>();
  for (const item of interfaces) {
    if (item.role !== 'consumer' && item.role !== 'publisher') continue;
    const targetAliases = normalizeAliases(item.service_aliases, serviceAliasesFromEndpoint(item.endpoint))
      .filter(alias => isUsefulApplicationAlias(alias) && !isIpAddressToken(alias));
    if (!targetAliases.length) continue;

    const targetComponents = new Map<string, SystemRuntimeComponent>();
    for (const alias of targetAliases) {
      for (const component of componentByAlias.get(`${item.codebase_id}:${alias}`) || []) {
        targetComponents.set(component.id, component);
      }
    }
    if (!targetComponents.size) continue;

    let sourceComponents = componentByApplication.get(`${item.codebase_id}:${item.application_id}`) || [];
    if (!sourceComponents.length) {

      const callerAliases = callerAliasesFromRefs(item.refs);
      const candidates = new Map<string, SystemRuntimeComponent>();
      for (const alias of callerAliases) {
        for (const component of componentByAlias.get(`${item.codebase_id}:${alias}`) || []) {
          candidates.set(component.id, component);
        }
      }
      sourceComponents = [...candidates.values()];
    }
    if (!sourceComponents.length) continue;
    const port = concreteEndpointPort(item.endpoint);

    for (const sourceComponent of sourceComponents) {
      for (const targetComponent of targetComponents.values()) {
        if (sourceComponent.id === targetComponent.id) continue;
        if (port && targetComponent.ports.length && !targetComponent.ports.includes(port)) continue;
        const key = `${sourceComponent.id}->${targetComponent.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        links.push({
          id: `runtime:topology:${slugify(item.id)}:${slugify(targetComponent.id)}`,
          codebase_id: item.codebase_id,
          source_component_id: sourceComponent.id,
          target_component_id: targetComponent.id,
          kind: item.kind === 'message' ? 'message-flow' : item.kind === 'stream' ? 'stream-flow' : 'http-call',
          mode: item.mode,
          confidence: adjustLinkConfidence(0.78, 'topology-backed'),
          evidence: [
            `topology-backed:${item.codebase_id}:${item.name}`,
            `compose-service:${targetComponent.name}`,
            ...item.refs.slice(0, 2).map(ref => `consumer:${ref.file || ref.name || ref.id}`),
          ],
        });
      }
    }
  }
  return links;
}

function isIpAddressToken(value: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(value);
}

function callerAliasesFromRefs(refs: CrossCodebaseRef[]): string[] {
  const aliases = new Set<string>();
  for (const ref of refs) {
    const file = String(ref.file || '').replace(/\\/g, '/').replace(/^\.\//, '');
    const segment = file.split('/')[0];
    if (segment) aliases.add(segment.toLowerCase());
  }
  return [...aliases];
}

function concreteEndpointPort(endpoint: string | undefined): string | undefined {
  const value = String(endpoint || '').trim();
  if (!value || value.includes('${')) return undefined;
  try {
    const url = /^https?:\/\//i.test(value) ? new URL(value) : new URL(`http://${value}`);
    return url.port || undefined;
  } catch {
    const match = value.match(/:(\d+)/);
    return match ? match[1] : undefined;
  }
}

function buildApplicationLinks(
  links: SystemLink[],
  runtimeLinks: SystemRuntimeLink[],
  interfaces: SystemInterface[],
  runtimeComponents: SystemRuntimeComponent[],
  applications: SystemApplication[],
  codebases: SystemCodebase[],
  repositories: CrossCodebaseInput[],
): SystemApplicationLink[] {
  const interfaceById = new Map(interfaces.map(item => [item.id, item]));
  const componentById = new Map(runtimeComponents.map(item => [item.id, item]));
  const applicationLinks: SystemApplicationLink[] = [];
  for (const link of links) {
    if (link.source_application_id === link.target_application_id) continue;
    applicationLinks.push({
      id: `application:${link.id}`,
      kind: link.kind,
      mode: link.mode,
      source_application_id: link.source_application_id,
      target_application_id: link.target_application_id,
      source_codebase_id: link.source_codebase_id,
      target_codebase_id: link.target_codebase_id,
      source_interface_id: link.source_interface_id,
      target_interface_id: link.target_interface_id,
      confidence: link.confidence,
      evidence_quality: link.evidence_quality,
      evidence: link.evidence,
    });
  }
  for (const link of runtimeLinks) {
    const source = componentById.get(link.source_component_id);
    const target = componentById.get(link.target_component_id);
    if (!source || !target || source.application_id === target.application_id) continue;
    applicationLinks.push({
      id: `application:${link.id}`,
      kind: link.kind,
      mode: link.mode,
      source_application_id: source.application_id,
      target_application_id: target.application_id,
      source_codebase_id: source.codebase_id,
      target_codebase_id: target.codebase_id,
      source_runtime_component_id: source.id,
      target_runtime_component_id: target.id,
      confidence: adjustLinkConfidence(link.confidence, 'topology-backed'),
      evidence_quality: 'topology-backed',
      evidence: link.evidence,
    });
  }
  for (const link of links) {
    const source = interfaceById.get(link.source_interface_id);
    const target = interfaceById.get(link.target_interface_id);
    if (!source || !target) continue;
  }
  applicationLinks.push(...inferPackageDeclaredApplicationLinks(applications, codebases));
  applicationLinks.push(...inferInternalDependencyLinks(repositories, applications));
  return enrichApplicationLinks(
    dedupeApplicationLinks(applicationLinks).filter(link => shouldRetainWorkspaceApplicationLink(link, applications)),
    applications,
  );
}

function enrichApplicationLinks(links: SystemApplicationLink[], applications: SystemApplication[]): SystemApplicationLink[] {
  const appById = new Map(applications.map(app => [app.id, app]));
  return links.map(link => ({
    ...link,
    source_application_name: appById.get(link.source_application_id)?.name,
    target_application_name: appById.get(link.target_application_id)?.name,
    trust_guidance: link.trust_guidance || workspaceLinkTrustGuidance(link.evidence_quality),
  }));
}

function shouldRetainWorkspaceApplicationLink(link: SystemApplicationLink, applications: SystemApplication[]): boolean {
  const appById = new Map(applications.map(app => [app.id, app]));
  const source = appById.get(link.source_application_id);
  const target = appById.get(link.target_application_id);
  if (!source || !target) return false;
  if (looksLikeInternalUtilityApplication(source) || looksLikeInternalUtilityApplication(target)) return false;
  if (isRawInfrastructureOrImageSurface(source) || isRawInfrastructureOrImageSurface(target)) return false;
  if (source.kind === 'tool' || target.kind === 'tool') return false;
  if (!source.deployable && source.kind === 'codebase') return false;
  if (!target.deployable && target.kind === 'codebase') return false;
  return true;
}

function inferInternalDependencyLinks(repositories: CrossCodebaseInput[], applications: SystemApplication[]): SystemApplicationLink[] {
  const links: SystemApplicationLink[] = [];
  const appsByCodebase = new Map<string, SystemApplication[]>();
  for (const app of applications) {
    if (!app.deployable && app.kind === 'codebase') continue;
    appsByCodebase.set(app.codebase_id, [...(appsByCodebase.get(app.codebase_id) || []), app]);
  }
  for (const repository of repositories) {
    const id = codebaseId(repository.path);
    const apps = appsByCodebase.get(id) || [];
    if (apps.length < 2) continue;
    links.push(...inferInternalImportDependencyLinks(repository, id, apps));
    const nodeById = new Map((repository.cas.nodes || []).map(node => [node.id, node]));
    for (const edge of repository.cas.edges || []) {
      if (!isStructuralApplicationDependencyEdge(edge)) continue;
      const sourceNode = nodeById.get(edge.source);
      const targetNode = nodeById.get(edge.target);
      const sourceApp = sourceNode ? applicationForFile(id, sourceNode.source?.file, apps) : undefined;
      const targetApp = targetNode ? applicationForFile(id, targetNode.source?.file, apps) : undefined;
      if (!sourceApp || !targetApp || sourceApp.id === targetApp.id) continue;
      if (!isMajorApplicationBoundary(sourceApp) || !isMajorApplicationBoundary(targetApp)) continue;
      links.push({
        id: `application:internal:${slugify(edge.id || `${sourceApp.id}:${targetApp.id}`)}`,
        kind: 'sdk-install',
        mode: 'sync',
        source_application_id: sourceApp.id,
        target_application_id: targetApp.id,
        source_codebase_id: sourceApp.codebase_id,
        target_codebase_id: targetApp.codebase_id,
        confidence: adjustLinkConfidence(0.74, 'source-backed'),
        evidence_quality: 'source-backed',
        evidence: [
          `source-backed:${edge.type || 'edge'} ${sourceNode?.source?.file || sourceNode?.name || edge.source} -> ${targetNode?.source?.file || targetNode?.name || edge.target}`,
        ],
      });
    }
  }
  return links;
}

function inferInternalImportDependencyLinks(repository: CrossCodebaseInput, codebaseIdValue: string, applications: SystemApplication[]): SystemApplicationLink[] {
  const links: SystemApplicationLink[] = [];
  for (const node of repository.cas.nodes || []) {
    if (String(node.type || '').toLowerCase() !== 'import') continue;
    const sourceFile = node.source?.file;
    const importSource = String((node.metadata as Record<string, unknown> | undefined)?.source || '');
    const sourceApp = applicationForFile(codebaseIdValue, sourceFile, applications);
    const targetApp = applicationForImportSource(codebaseIdValue, sourceFile, importSource, applications);
    if (!sourceApp || !targetApp || sourceApp.id === targetApp.id) continue;
    if (!isMajorApplicationBoundary(sourceApp) || !isMajorApplicationBoundary(targetApp)) continue;
    links.push({
      id: `application:internal-import:${slugify(sourceApp.id)}:${slugify(targetApp.id)}:${slugify(importSource)}`,
      kind: 'sdk-install',
      mode: 'sync',
      source_application_id: sourceApp.id,
      target_application_id: targetApp.id,
      source_codebase_id: sourceApp.codebase_id,
      target_codebase_id: targetApp.codebase_id,
      confidence: adjustLinkConfidence(0.82, 'source-backed'),
      evidence_quality: 'source-backed',
      evidence: [`source-backed:import ${importSource} from ${sourceFile}`],
    });
  }
  return links;
}

function isStructuralApplicationDependencyEdge(edge: CASOutput['edges'][number]): boolean {
  const type = String((edge as any).type || (edge as any).relationship_type || '').toLowerCase();
  return /^(imports|import|depends_on|depends|dependency|uses_package|package_dependency|references_package)$/.test(type);
}

function applicationForFile(codebaseIdValue: string, file: string | undefined, applications: SystemApplication[]): SystemApplication | undefined {
  const appName = applicationNameFromFile(file);
  if (!appName) return undefined;
  const id = applicationId(codebaseIdValue, appName);
  return applications.find(app => app.id === id);
}

function applicationForFileFromIndex(
  codebaseIdValue: string,
  file: string | undefined,
  applicationsById: Map<string, SystemApplication>,
): SystemApplication | undefined {
  const appName = applicationNameFromFile(file);
  return appName ? applicationsById.get(applicationId(codebaseIdValue, appName)) : undefined;
}

function applicationForImportSource(
  codebaseIdValue: string,
  sourceFile: string | undefined,
  importSource: string,
  applications: SystemApplication[],
): SystemApplication | undefined {
  if (!importSource) return undefined;
  const normalized = importSource.replace(/\\/g, '/');
  if (normalized.startsWith('.')) {
    const base = path.dirname(String(sourceFile || ''));
    const resolved = path.normalize(path.join(base, normalized)).replace(/\\/g, '/');
    return applicationForFile(codebaseIdValue, resolved, applications);
  }
  const parts = normalized.split('/');
  const packageName = normalizePackageName(normalized.startsWith('@') && parts.length >= 2 ? `${parts[0]}/${parts[1]}` : parts[0]);
  const direct = applications.find(app => {
    const appName = normalizePackageName(app.name);
    return appName === packageName || packageName.endsWith(`/${appName}`);
  });
  if (direct) return direct;
  return undefined;
}

function isMajorApplicationBoundary(app: SystemApplication): boolean {
  const hint = app.path_hint || '';
  return /(?:^|\/)(apps|packages|bin|libs)\//.test(hint) || app.runtime_component_ids.length > 0;
}

function inferPackageDeclaredApplicationLinks(
  applications: SystemApplication[],
  codebases: SystemCodebase[],
): SystemApplicationLink[] {
  const links: SystemApplicationLink[] = [];
  const codebaseById = new Map(codebases.map(codebase => [codebase.id, codebase]));

  const add = (
    source: SystemApplication | undefined,
    target: SystemApplication | undefined,
    kind: SystemApplicationLink['kind'],
    mode: SystemInterfaceMode,
    confidence: number,
    evidenceQuality: WorkspaceLinkEvidenceQuality,
    evidence: string[],
  ) => {
    if (!source || !target || source.id === target.id) return;
    links.push({
      id: `application:inferred:${kind}:${slugify(source.id)}:${slugify(target.id)}`,
      kind,
      mode,
      source_application_id: source.id,
      target_application_id: target.id,
      source_codebase_id: source.codebase_id,
      target_codebase_id: target.codebase_id,
      confidence: adjustLinkConfidence(confidence, evidenceQuality),
      evidence_quality: evidenceQuality,
      evidence: evidence.filter(Boolean).map(item => item.startsWith(`${evidenceQuality}:`) ? item : `${evidenceQuality}:${item}`),
    });
  };

  const packageApps = applications.filter(app => app.kind === 'package' || app.path_hint?.includes('packages/'));
  for (const app of applications) {
    if (app.kind === 'package') continue;
    const codebase = codebaseById.get(app.codebase_id);
    const packageNames = new Set((codebase?.packages || []).map(normalizePackageName));
    for (const pkg of packageApps) {
      if (pkg.codebase_id !== app.codebase_id) continue;
      const normalizedPackageName = normalizePackageName(pkg.name);
      const matchingPackage = [...packageNames].find(packageName =>
        packageName === normalizedPackageName ||
        packageName.endsWith(`/${normalizedPackageName}`)
      );
      if (matchingPackage) {
        add(app, pkg, 'sdk-install', 'sync', 0.82, 'package-declared', [
          `${codebase?.name || app.codebase_id} declares package dependency ${matchingPackage}`,
          pkg.path_hint || pkg.name,
        ]);
      }
    }
  }

  return links;
}

const FRONTEND_FRAMEWORK_NAMES = new Set([
  'react', 'next', 'next.js', 'nextjs', 'vue', 'vue.js', 'vuejs', 'nuxt', 'nuxt.js',
  'angular', 'angularjs', 'svelte', 'sveltekit', 'solid', 'solid-js', 'solidjs',
  'ember', 'ember.js', 'preact', 'lit', 'stencil', 'qwik', 'astro', 'remix',
  'gatsby', 'alpine.js', 'alpinejs', 'backbone', 'backbone.js', 'knockout',
  'polymer', 'flutter', 'swiftui', 'jetpack compose', 'compose',
]);

function hasFrontendFrameworkEvidence(codebase: SystemCodebase | undefined): boolean {
  if (!codebase) return false;
  return codebase.frameworks.some(framework => FRONTEND_FRAMEWORK_NAMES.has(framework.trim().toLowerCase()));
}

function inferSystemInsights(
  codebases: SystemCodebase[],
  applications: SystemApplication[],
  interfaces: SystemInterface[],
  applicationLinks: SystemApplicationLink[],
  runtimeComponents: SystemRuntimeComponent[],
  runtimeLinks: SystemRuntimeLink[],
  distributionUnits: WorkspaceDistributionUnit[] = [],
): SystemInsight[] {
  const appById = new Map(applications.map(app => [app.id, app]));
  const codebaseById = new Map(codebases.map(codebase => [codebase.id, codebase]));
  const codebaseIds = new Set(codebases.map(codebase => codebase.id));
  const visibleAppIds = new Set(applications.filter(app => shouldExposeInWorkspaceOverview(app, applications)).map(app => app.id));
  const sourceBackedLinks = applicationLinks.filter(link =>
    visibleAppIds.has(link.source_application_id) &&
    visibleAppIds.has(link.target_application_id) &&
    applicationLinkHasSourceBackedEvidence(link)
  );
  const topologyAwareLinks = applicationLinks.filter(link =>
    visibleAppIds.has(link.source_application_id) &&
    visibleAppIds.has(link.target_application_id) &&
    link.evidence_quality !== 'name-inferred' &&
    link.evidence_quality !== 'route-shape-inferred'
  );
  const insights: SystemInsight[] = [];
  const allIncoming = new Map<string, SystemApplicationLink[]>();
  for (const link of applicationLinks.filter(link =>
    visibleAppIds.has(link.source_application_id) &&
    visibleAppIds.has(link.target_application_id)
  )) {
    allIncoming.set(link.target_application_id, [...(allIncoming.get(link.target_application_id) || []), link]);
  }
  const incoming = new Map<string, SystemApplicationLink[]>();
  const outgoing = new Map<string, SystemApplicationLink[]>();
  for (const link of sourceBackedLinks) {
    incoming.set(link.target_application_id, [...(incoming.get(link.target_application_id) || []), link]);
    outgoing.set(link.source_application_id, [...(outgoing.get(link.source_application_id) || []), link]);
  }
  const topologyAwareIncoming = new Map<string, SystemApplicationLink[]>();
  const topologyAwareOutgoing = new Map<string, SystemApplicationLink[]>();
  for (const link of topologyAwareLinks) {
    topologyAwareIncoming.set(link.target_application_id, [...(topologyAwareIncoming.get(link.target_application_id) || []), link]);
    topologyAwareOutgoing.set(link.source_application_id, [...(topologyAwareOutgoing.get(link.source_application_id) || []), link]);
  }
  const interfacesByApp = new Map<string, SystemInterface[]>();
  const distributionMemberIds = new Set(distributionUnits.flatMap(unit => unit.component_deployable_ids));
  for (const item of interfaces) {
    interfacesByApp.set(item.application_id, [...(interfacesByApp.get(item.application_id) || []), item]);
  }

  for (const app of applications.filter(app => visibleAppIds.has(app.id))) {
    const inLinks = topologyAwareIncoming.get(app.id) || [];
    const outLinks = topologyAwareOutgoing.get(app.id) || [];
    if (distributionMemberIds.has(app.id)) continue;

    const appInterfacesForBroker = interfacesByApp.get(app.id) || [];
    const emitsOnQueueLikeSurface = appInterfacesForBroker.some(item =>
      (item.kind === 'message' || item.kind === 'stream') && (item.role === 'publisher' || item.role === 'consumer'));
    const receivesOnQueueLikeSurface = appInterfacesForBroker.some(item =>
      (item.kind === 'message' || item.kind === 'stream') && (item.role === 'listener' || item.role === 'provider'));
    const queueEvidenceSurface = emitsOnQueueLikeSurface && receivesOnQueueLikeSurface;
    const appInterfacesForTopology = interfacesByApp.get(app.id) || [];
    const topologyBrokerSurface = inLinks.length > 0 && outLinks.length > 0 &&
      appInterfacesForTopology.some(item => item.role === 'provider' || item.role === 'listener') &&
      appInterfacesForTopology.some(item => item.role === 'consumer' || item.role === 'publisher');
    if ((queueEvidenceSurface || topologyBrokerSurface) && (inLinks.length + outLinks.length) >= 2) {
      const sourceBackedIn = inLinks.filter(applicationLinkHasSourceBackedEvidence);
      const sourceBackedOut = outLinks.filter(applicationLinkHasSourceBackedEvidence);
      const hasSourceBackedBridge = sourceBackedIn.length > 0 && sourceBackedOut.length > 0;
      const peers = [...new Set([...inLinks.map(link => link.source_application_id), ...outLinks.map(link => link.target_application_id)])]
        .map(id => appById.get(id)?.name || id);
      const title = hasSourceBackedBridge
        ? `${app.name} brokers traffic between ${peers.slice(0, 4).join(', ')}`
        : `${app.name} has deployment topology links with ${peers.slice(0, 4).join(', ')}`;
      insights.push({
        id: `insight:broker:${slugify(app.id)}`,
        type: queueEvidenceSurface ? 'bidirectional-message-surface' : 'intermediary-topology',
        title,
        description: hasSourceBackedBridge
          ? `${app.name} has both inbound and outbound source-backed workspace links, so agents should treat it as part of the communication path while preserving each link's evidence quality.`
          : `${app.name} is connected by deployment topology, but the workspace-level CAS should not claim source-level brokering until source-backed incoming and outgoing paths are present.`,
        application_ids: [app.id, ...new Set([...inLinks.map(link => link.source_application_id), ...outLinks.map(link => link.target_application_id)])],
        codebase_ids: [...new Set([app.codebase_id, ...inLinks.map(link => link.source_codebase_id), ...outLinks.map(link => link.target_codebase_id)])],
        confidence: hasSourceBackedBridge ? (queueEvidenceSurface ? 0.86 : 0.72) : 0.62,
        evidence: [...inLinks, ...outLinks].slice(0, 8).flatMap(link => link.evidence),
      });
    }
  }

  for (const app of applications.filter(app => visibleAppIds.has(app.id))) {
    const providerInterfaces = (interfacesByApp.get(app.id) || []).filter(item =>
      item.role === 'provider' &&
      (item.kind === 'http-api' || item.kind === 'message' || item.kind === 'stream')
    );
    if (providerInterfaces.length === 0) continue;
    const sourceBackedIncoming = (incoming.get(app.id) || []).filter(applicationLinkHasSourceBackedEvidence);
    if (sourceBackedIncoming.length > 0) continue;
    insights.push({
      id: `insight:unused-provider:${slugify(app.id)}`,
      type: 'provider-api-without-source-consumers',
      title: `${app.name} exposes provider interfaces with no source-backed incoming consumers`,
      description: `${app.name} has provider interfaces in the CAS, but Klauro did not find source-backed incoming calls, listeners, streams, or package consumers connected to it in this workspace. Treat it as an exposed-but-unclaimed surface: it may be externally consumed, intentionally dormant, or missing caller evidence, but the workspace-level CAS should not claim it is actively used until repo-level CAS proves an incoming path.`,
      application_ids: [app.id],
      codebase_ids: [app.codebase_id],
      confidence: providerInterfaces.length >= 2 ? 0.78 : 0.68,
      evidence: providerInterfaces.slice(0, 8).map(item => `${item.kind}:${item.name}:${item.endpoint || item.topic || item.key}`),
    });
  }

  for (const ui of applications.filter(app => visibleAppIds.has(app.id) && hasFrontendFrameworkEvidence(codebaseById.get(app.codebase_id)))) {
    const uiOutLinks = topologyAwareOutgoing.get(ui.id) || [];
    const apiLink = uiOutLinks.find(link => {
      const target = appById.get(link.target_application_id);
      if (!target || !visibleAppIds.has(target.id)) return false;
      return (interfacesByApp.get(target.id) || []).some(item => item.role === 'provider' && item.kind === 'http-api');
    });
    if (!apiLink) continue;
    const api = appById.get(apiLink.target_application_id);
    if (!api) continue;
    insights.push({
      id: `insight:ui-api:${slugify(ui.id)}:${slugify(api.id)}`,
      type: 'frontend-provider-link',
      title: `${ui.name} pairs with ${api.name}`,
      description: `${ui.name} has frontend-framework evidence and a workspace link to ${api.name}, which exposes provider HTTP interfaces. Changes to either side should validate route contracts and auth expectations together.`,
      application_ids: [ui.id, api.id],
      codebase_ids: [...new Set([ui.codebase_id, api.codebase_id])],
      confidence: applicationLinkHasSourceBackedEvidence(apiLink) ? 0.78 : 0.66,
      evidence: [ui.path_hint || ui.name, api.path_hint || api.name, ...apiLink.evidence.slice(0, 4)],
    });
  }

  for (const app of applications.filter(app => visibleAppIds.has(app.id))) {
    const appInterfaces = interfacesByApp.get(app.id) || [];
    const sourceBackedIncoming = (incoming.get(app.id) || []).filter(applicationLinkHasSourceBackedEvidence);
    if (sourceBackedIncoming.length > 0) continue;
    if (appInterfaces.length === 0) continue;
    if (!appInterfaces.some(item => item.role === 'provider' || item.role === 'listener')) continue;
    if (insights.some(insight => insight.type === 'provider-api-without-source-consumers' && insight.application_ids.includes(app.id))) continue;
    insights.push({
      id: `insight:unclaimed-runtime-surface:${slugify(app.id)}`,
      type: 'unclaimed-runtime-surface',
      title: `${app.name} has no source-backed incoming workspace consumers`,
      description: `${app.name} is a runtime surface with CAS interfaces, but Klauro did not find source-backed incoming workspace calls, listeners, streams, or package consumers. Treat it as isolated, externally consumed, or missing caller evidence until repo-level CAS proves otherwise.`,
      application_ids: [app.id],
      codebase_ids: [app.codebase_id],
      confidence: appInterfaces.some(item => item.role === 'provider') ? 0.76 : 0.66,
      evidence: appInterfaces.slice(0, 8).map(item => `${item.role}:${item.kind}:${item.name}:${item.endpoint || item.topic || item.key || ''}`),
    });
  }

  for (const component of runtimeComponents) {
    const name = component.name.toLowerCase();
    if (!/redis|memcached|rabbit|kafka|nats/.test(name)) continue;
    const app = appById.get(component.application_id);
    const connected = runtimeLinks.filter(link => link.source_component_id === component.id || link.target_component_id === component.id);
    const sourceBacked = connected.some(link => link.evidence.some(isSourceBackedRuntimeEvidence));
    if (connected.length === 0 || !sourceBacked) {
      insights.push({
        id: `insight:declared-unused:${slugify(component.id)}`,
        type: 'declared-unused-infrastructure',
        title: `${component.name} is declared in runtime topology but has no source-level usage evidence`,
        description: `${component.name} appears in deployment topology and dependency wiring, but Klauro did not find source-level calls, data access, or messaging usage connected to it in the analyzed code. Treat it as provisioned infrastructure until source evidence appears.`,
        application_ids: [component.application_id],
        codebase_ids: [component.codebase_id],
        confidence: 0.7,
        evidence: [component.refs[0]?.file || component.name, ...connected.flatMap(link => link.evidence).slice(0, 6), app?.name || ''],
      });
    }
  }

  return dedupeInsights(insights).filter(insight => insight.codebase_ids.some(id => codebaseIds.has(id)));
}

function addConceptualWorkspaceEntities(entities: Map<string, WorkspaceEntity>): void {
  addSuffixConceptualEntity(entities, 'Device', /\bdevice$/);
}

function addSuffixConceptualEntity(
  entities: Map<string, WorkspaceEntity>,
  conceptName: string,
  suffixPattern: RegExp,
): void {
  const conceptKey = slugify(conceptName);
  if (entities.has(conceptKey)) return;
  const members = [...entities.values()].filter(entity => {
    const normalized = normalizeAiItemName(entity.name);
    return normalized !== normalizeAiItemName(conceptName) && suffixPattern.test(normalized);
  });
  if (members.length < 2) return;
  const lifecycle = {
    created_by: members.reduce((sum, entity) => sum + (entity.lifecycle?.created_by || 0), 0),
    read_by: members.reduce((sum, entity) => sum + (entity.lifecycle?.read_by || 0), 0),
    updated_by: members.reduce((sum, entity) => sum + (entity.lifecycle?.updated_by || 0), 0),
    deleted_by: members.reduce((sum, entity) => sum + (entity.lifecycle?.deleted_by || 0), 0),
    external_recipients: members.reduce((sum, entity) => sum + (entity.lifecycle?.external_recipients || 0), 0),
    boundaries_crossed: members.reduce((sum, entity) => sum + (entity.lifecycle?.boundaries_crossed || 0), 0),
  };
  entities.set(conceptKey, {
    id: `workspace-entity:${conceptKey}`,
    name: conceptName,
    project_ids: mergeStrings([], members.flatMap(entity => entity.project_ids)).sort(),
    entity_refs: dedupeEntityRefs(members.flatMap(entity => entity.entity_refs)),
    related_capability_ids: mergeStrings([], members.flatMap(entity => entity.related_capability_ids)),
    related_workflow_ids: mergeStrings([], members.flatMap(entity => entity.related_workflow_ids)),
    related_data_flow_path_ids: mergeStrings([], members.flatMap(entity => entity.related_data_flow_path_ids)),
    sensitive_fields: mergeStrings([], members.flatMap(entity => entity.sensitive_fields)),
    lifecycle,

    description: undefined,
    semantic_role: members.some(entity => entity.semantic_role === 'core') ? 'core' : 'supporting',
    terminal_score: Math.max(...members.map(entity => entity.terminal_score || 0)),
    terminal_evidence: mergeStrings([], members.flatMap(entity => entity.terminal_evidence || [])).slice(0, 8),
    path_count: members.reduce((sum, entity) => sum + (entity.path_count || 0), 0),
    path_types: [...new Set(members.flatMap(entity => entity.path_types || []))],
    evidence: mergeStrings([`conceptual-entity:${conceptName}`], members.flatMap(entity => entity.evidence)).slice(0, 12),
    confidence: Math.min(0.9, Math.max(...members.map(entity => entity.confidence || 0.55), 0.72)),
  });
}

function inferEntityGapInsights(entities: WorkspaceEntity[]): SystemInsight[] {
  return entities
    .filter(entity =>
      entity.semantic_role === 'core' &&
      (entity.lifecycle?.read_by || 0) > 0 &&
      (entity.lifecycle?.created_by || 0) === 0 &&
      (entity.lifecycle?.updated_by || 0) === 0
    )
    .slice(0, 12)
    .map(entity => ({
      id: `insight:entity-read-without-writer:${slugify(entity.name)}`,
      type: 'entity-read-without-writer' as const,
      title: `${entity.name} is read but has no source-backed writer in workspace CAS`,
      description: `${entity.name} appears as a core workspace entity with reader evidence but no source-backed creator or updater. Treat producer ownership as unresolved and drill into repo-level data lineage before changing schemas, workflows, or consumers.`,
      application_ids: [],
      codebase_ids: entity.project_ids.slice(0, 8),
      confidence: 0.76,
      evidence: [
        `read_by:${entity.lifecycle.read_by}`,
        `created_by:${entity.lifecycle.created_by}`,
        `updated_by:${entity.lifecycle.updated_by}`,
        ...(entity.evidence || []).slice(0, 5),
      ],
    }));
}

function buildWorkspaceNarrative(
  name: string,
  generatedAt: string,
  codebases: SystemCodebase[],
  applications: SystemApplication[],
  applicationLinks: SystemApplicationLink[],
  insights: SystemInsight[],
  runtimeComponents: SystemRuntimeComponent[],
  composition: WorkspaceCompositionProfile,
  capabilities: WorkspaceCapability[],
  domains: WorkspaceDomain[],
): WorkspaceNarrative {
  const productName = inferWorkspaceProductName(codebases, name);
  const deployables = applications.filter(app => app.deployable);
  const appById = new Map(applications.map(app => [app.id, app]));
  const linkSummaries = applicationLinks.slice(0, 12).map(link => {
    const source = appById.get(link.source_application_id)?.name || link.source_application_id;
    const target = appById.get(link.target_application_id)?.name || link.target_application_id;
    return `${source} ${link.mode} ${link.kind} ${target}`;
  });
  const capabilityNames = capabilities.length
    ? capabilities.map(capability => capability.name)
    : capabilityNamesFromCodebases(codebases, applications);
  const valueDrivers = [
    deployables.some(app => /ui|web|client/.test(app.name)) ? 'human-facing product surfaces' : '',
    deployables.some(app => /api|server|backend/.test(app.name)) ? 'API-backed application behavior' : '',
    deployables.some(app => /worker|sync|listener|agent|coordinator|gateway|drop-server/.test(app.name)) ? 'background, agent, or coordination services' : '',
    runtimeComponents.length > 0 ? 'declared runtime and deployment topology' : '',
  ].filter(Boolean);
  return {
    source: 'ai-required-degraded',
    generated_at: generatedAt,
    confidence: codebases.length > 1 && applicationLinks.length > 0 ? 0.68 : 0.54,

    title: `${workspaceNarrativeTitleName(name, productName)} workspace analysis`,

    product_value_summary: '',
    description: '',
    value_drivers: valueDrivers,
    domains: domains.map(domain => domain.name).slice(0, 12),
    key_capabilities: capabilityNames.slice(0, 10),

    relationship_summary: [
      ...linkSummaries,
      ...insights
        .filter(insight => !INTERNAL_ANALYSIS_INSIGHT_TYPES.has(insight.type) && !isInternalAnalysisPhrase(insight.title))
        .slice(0, 6)
        .map(insight => insight.title),
    ].slice(0, 16),
    evidence: [
      ...codebases.map(codebase => `${codebase.name}:${codebase.graph.nodes} nodes/${codebase.graph.entry_points} entries/${codebase.graph.exit_points} exits`).slice(0, 8),
      ...runtimeComponents.map(component => `${component.name}:${component.topology_surface}`).slice(0, 8),
    ],
    ai_required: true,
    generation_pass: 'default-summary',
    degraded_reason: 'AI workspace narrative enrichment was not attached to this synchronous workspace builder run. Overall description and primary capabilities are required default interpretation; refresh/run the workspace analysis with interpretation before customer-facing use.',
  };
}

const INTERNAL_ANALYSIS_INSIGHT_TYPES = new Set([
  'provider-api-without-source-consumers',
  'unclaimed-runtime-surface',
  'declared-unused-infrastructure',
]);

function isInternalAnalysisPhrase(text: string): boolean {
  return /\b(?:source-backed|should not be forced|system graph|repo-level CAS|analysis input|Klauro did not find|deployable\(s\)|evidence quality)\b/i.test(String(text || ''));
}

function workspaceNarrativeTitleName(workspaceName: string, productName: string): string {
  const cleaned = String(workspaceName || '').trim();
  if (!cleaned || isHashOrIdShapedToken(cleaned)) return productName;
  return cleaned;
}

function joinHumanReadableList(items: string[]): string {
  const list = items.filter(Boolean);
  if (list.length === 0) return '';
  if (list.length === 1) return list[0];
  if (list.length === 2) return `${list[0]} and ${list[1]}`;
  return `${list.slice(0, -1).join(', ')}, and ${list[list.length - 1]}`;
}

function inferWorkspaceProductName(codebases: SystemCodebase[], fallback: string): string {
  const explicitWorkspaceName = String(fallback || '').trim();
  if (
    explicitWorkspaceName &&
    !/^(?:workspace|analysis|system|project)$/i.test(explicitWorkspaceName) &&
    !/^(?:wsp|prj|acct)[_-][a-z0-9_-]+$/i.test(explicitWorkspaceName)
  ) {
    return explicitWorkspaceName;
  }
  const stop = new Set(['gauntlet', 'workspace', 'analysis', 'proof', 'concept', 'repo', 'app', 'api', 'ui', 'client', 'server', 'service', 'system', 'infra', 'infrastructure', 'admin', 'user', 'mobile', 'website', 'poc', 'old', 'demo', 'self', 'hosted', 'builder', 'current', 'latest']);
  const counts = new Map<string, number>();
  const tokensFor = (value: string | undefined) => String(value || '').split(/[^a-zA-Z0-9]+/).filter(Boolean);
  const add = (value: string | undefined, weight = 1) => {
    for (const token of tokensFor(value)) {
      const normalized = token.toLowerCase();
      if (normalized.length < 4 || stop.has(normalized) || /^\d+$/.test(normalized)) continue;
      counts.set(normalized, (counts.get(normalized) || 0) + weight);
    }
  };
  const fallbackTokens = tokensFor(fallback).map(token => token.toLowerCase()).filter(token => token.length >= 4 && !stop.has(token) && !/^\d+$/.test(token));
  const namedFallbackToken = tokensFor(fallback)
    .map(token => token.toLowerCase())
    .find((token, index, all) => index > 0 && stop.has(all[index - 1]) && token.length >= 4 && !stop.has(token) && !/^\d+$/.test(token));
  if (namedFallbackToken) counts.set(namedFallbackToken, (counts.get(namedFallbackToken) || 0) + 6);
  fallbackTokens.forEach((token, index) => {
    const randomishSuffix = index > 0 && index >= fallbackTokens.length - 2 && /^[a-z]{5,8}$/.test(token);
    counts.set(token, (counts.get(token) || 0) + (randomishSuffix ? 0.1 : 1.25));
  });
  for (const codebase of codebases) {
    add(codebase.name, 3);
    add(codebase.path, 1);
    for (const pkg of codebase.packages.slice(0, 20)) add(pkg, pkg.startsWith('@') ? 2 : 0.5);
  }
  const best = [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0]?.[0];
  return best ? best[0].toUpperCase() + best.slice(1) : (fallback || 'Workspace');
}

function capabilityNamesFromCodebases(codebases: SystemCodebase[], applications: SystemApplication[]): string[] {
  const names = new Set<string>();
  for (const app of applications) {
    const normalized = app.name.replace(/[-_]+/g, ' ');
    if (!/^(api|app|server|service|codebase)$/.test(app.name)) names.add(normalized);
  }
  for (const codebase of codebases) {
    const normalized = codebase.name.replace(/[-_]+/g, ' ');
    if (normalized && normalized !== 'system') names.add(normalized);
  }
  return [...names];
}

function bestLinksForConsumer(links: SystemLink[], interfaceById: Map<string, SystemInterface>): SystemLink[] {
  const httpLinks = links.filter(link => link.kind === 'http-call');
  const otherLinks = links.filter(link => link.kind !== 'http-call');
  if (httpLinks.length <= 1) return links;
  const maxRank = Math.max(...httpLinks.map(link => httpLinkSelectionRank(link, interfaceById)));
  return [
    ...otherLinks,
    ...httpLinks
      .filter(link => httpLinkSelectionRank(link, interfaceById) === maxRank)
      .sort((left, right) => right.confidence - left.confidence || linkQualityRank(right) - linkQualityRank(left) || left.id.localeCompare(right.id))
      .slice(0, maxRank >= 120 ? 4 : 1),
  ];
}

function httpLinkSelectionRank(link: SystemLink, interfaceById: Map<string, SystemInterface>): number {
  const source = interfaceById.get(link.source_interface_id);
  const target = interfaceById.get(link.target_interface_id);
  if (!source || !target) return link.confidence * 10;

  const sourceRoute = normalizeRoute(source.endpoint || source.key);
  const targetRoute = normalizeRoute(target.endpoint || target.key);
  const exactRoute = routeSegmentCandidates(sourceRoute).some(left =>
    routeSegmentCandidates(targetRoute).some(right => exactShapeWithoutWildcards(left, right))
  );
  const compatibleRoute = routeCompatible(sourceRoute, targetRoute);
  const targetSpecificity = routeSegments(targetRoute).filter(part => part !== ':param').length;
  const sourceSpecificity = routeSegments(sourceRoute).filter(part => part !== ':param').length;
  const hostOnlyTarget = hostOnlyHttpInterface(target);
  const hostOnlySource = hostOnlyHttpInterface(source);
  const methodExact = normalizeHttpMethod(source.method) === normalizeHttpMethod(target.method);

  let rank = 0;
  if (exactRoute) rank += 120;
  else if (compatibleRoute) rank += 80;
  rank += Math.min(30, (targetSpecificity + sourceSpecificity) * 4);
  if (methodExact) rank += 12;
  rank += linkQualityRank(link) * 5;
  rank += link.confidence * 10;
  if (hostOnlyTarget) rank -= 45;
  if (hostOnlySource && !exactRoute) rank -= 20;
  if (String(target.endpoint || '').includes('${')) rank -= 20;
  return rank;
}

function matchInterfaces(source: SystemInterface, target: SystemInterface, appById: Map<string, SystemApplication>): Pick<SystemLink, 'kind' | 'mode' | 'confidence'> | null {
  if (source.kind === 'http-api' && source.role === 'consumer' && target.kind === 'http-api' && target.role === 'provider') {
    if (source.codebase_id !== target.codebase_id && source.topology_surface && target.topology_surface) return null;
    if (!apiAudienceCompatible(source, target, appById)) return null;
    if (serviceAliasesOverlap(source, target)) {
      if (!hostOnlyHttpInterface(source) && !hostOnlyHttpInterface(target) && !httpCompatible(source, target)) return null;
      return { kind: 'http-call', mode: source.mode === 'async' ? 'async' : target.mode, confidence: 0.88 };
    }
    const sourceHost = concreteEndpointHost(source.endpoint);
    if (
      source.codebase_id !== target.codebase_id &&
      sourceHost &&
      !interfaceMatchesHost(target, sourceHost) &&
      !hostMatchesSourceInterface(source, sourceHost)
    ) return null;
    if (
      source.codebase_id !== target.codebase_id &&
      isRelativeHttpEndpoint(source.endpoint) &&
      !hasSpecificCrossRepoRouteSeam(source, target)
    ) return null;
    if (hasLikelyExternalTemplatedBase(source.endpoint)) return null;
    if (!httpCompatible(source, target)) return null;
    return { kind: 'http-call', mode: source.mode === 'async' ? 'async' : target.mode, confidence: routeMatchConfidence(source, target) };
  }
  if (source.kind === 'sdk' && source.role === 'consumer' && target.kind === 'sdk' && target.role === 'provider') {
    if (!source.package_name || source.package_name !== target.package_name) return null;
    return { kind: 'sdk-install', mode: 'sync', confidence: 0.9 };
  }
  if (source.kind === 'message' && source.role === 'publisher' && target.kind === 'message' && target.role === 'listener') {
    if (!source.topic || source.topic !== target.topic) return null;
    return { kind: 'message-flow', mode: 'async', confidence: source.schema && target.schema && source.schema === target.schema ? 0.94 : 0.88 };
  }
  if (source.kind === 'stream' && (source.role === 'publisher' || source.role === 'consumer') && target.kind === 'stream' && (target.role === 'listener' || target.role === 'provider')) {
    if (source.key !== target.key && !routeCompatible(source.key, target.key)) return null;
    return { kind: 'stream-flow', mode: 'stream', confidence: 0.82 };
  }
  return null;
}

function hostOnlyHttpInterface(item: SystemInterface): boolean {
  const route = normalizeRoute(item.endpoint || item.key);
  return route === '/' || Boolean(item.endpoint?.startsWith('http://') || item.endpoint?.startsWith('https://'));
}

function isRelativeHttpEndpoint(endpoint: string | undefined): boolean {
  const value = String(endpoint || '').trim();
  return value.startsWith('/') || value.startsWith('./') || value.startsWith('../');
}

function hasSpecificCrossRepoRouteSeam(source: SystemInterface, target: SystemInterface): boolean {
  const sourceCandidates = routeSegmentCandidates(normalizeRoute(source.endpoint || source.key));
  const targetCandidates = routeSegmentCandidates(normalizeRoute(target.endpoint || target.key));
  for (const left of sourceCandidates) {
    for (const right of targetCandidates) {
      if (!routePartsCompatible(left, right)) continue;
      const hasSpecificSharedSegment = left.some((part, index) =>
        part !== ':param' && right[index] === part && isSpecificRouteSegment(part));
      if (hasSpecificSharedSegment) return true;
    }
  }
  return false;
}

function isSpecificRouteSegment(segment: string): boolean {
  if (!segment || segment === ':param') return false;
  if (/^(api|v\d+)$/.test(segment)) return false;
  if (segment.length < 4) return false;
  return !GENERIC_ROUTE_SEGMENTS.has(segment);
}

const GENERIC_ROUTE_SEGMENTS = new Set([
  'health',
  'healthz',
  'status',
  'ping',
  'ready',
  'readyz',
  'live',
  'livez',
  'login',
  'logout',
  'auth',
  'callback',
  'webhook',
  'webhooks',
  'user',
  'users',
  'me',
  'admin',
  'public',
  'static',
  'assets',
  'index',
  'home',
  'data',
  'list',
  'items',
  'item',
  'object',
  'objects',
  'metrics',
  'version',
  'config',
  'settings',
]);

function concreteEndpointHost(endpoint: string | undefined): string | undefined {
  const value = String(endpoint || '').trim();
  if (!value || value.startsWith('/') || value.includes('${')) return undefined;
  try {
    const url = /^https?:\/\//i.test(value) ? new URL(value) : new URL(`http://${value}`);
    const host = cleanApplicationName(url.hostname);
    if (!host || /^(localhost|127-0-0-1|0-0-0-0)$/.test(host)) return undefined;
    return host;
  } catch {
    return undefined;
  }
}

function interfaceMatchesHost(item: SystemInterface, host: string): boolean {
  const normalizedHost = cleanApplicationName(host);
  if (!normalizedHost) return false;
  const aliases = normalizeAliases(item.service_aliases, serviceAliasesFromEndpoint(item.endpoint)).map(cleanApplicationName);
  if (aliases.includes(normalizedHost)) return true;
  return item.application_id.split(':app:')[1] === normalizedHost;
}

function hostMatchesSourceInterface(item: SystemInterface, host: string): boolean {
  const normalizedHost = cleanApplicationName(host);
  if (!normalizedHost) return false;
  const aliases = normalizeAliases(item.service_aliases, serviceAliasesFromEndpoint(item.endpoint)).map(cleanApplicationName);
  if (aliases.includes(normalizedHost)) return true;
  return cleanApplicationName(applicationNameFromId(item.application_id)) === normalizedHost;
}

function isServiceTierDeployableEvidence(app: SystemApplication | undefined): boolean {
  if (!app) return false;
  if (app.kind === 'app') return false;
  return app.runtime_component_ids.length > 0 || app.kind === 'service' || app.kind === 'worker' || app.kind === 'runtime-service';
}

function apiAudienceCompatible(source: SystemInterface, target: SystemInterface, appById: Map<string, SystemApplication>): boolean {
  const sourceName = cleanApplicationName(applicationNameFromId(source.application_id));
  const targetName = cleanApplicationName(applicationNameFromId(target.application_id));
  const sourceText = `${source.name} ${source.endpoint || ''} ${source.key || ''}`.toLowerCase();
  if (!sourceName || !targetName) return true;

  const clientFacingSource = /(?:^|[-_])(client|user|mobile|desktop|tray|frontend|web|ui)(?:[-_]|$)/.test(sourceName);
  const privilegedTarget = /(?:^|[-_])(admin|internal)(?:[-_]|$)/.test(targetName);
  const explicitPrivilegedIntent = /\b(admin|internal|partner-portal|impersonat|service\/agents|metrics\/service|m2m|machine-to-machine)\b/.test(sourceText);
  if (clientFacingSource && privilegedTarget && !explicitPrivilegedIntent) return false;

  const operationalSource = isServiceTierDeployableEvidence(appById.get(source.application_id));
  const userTarget = /(?:^|[-_])(user|public|client)(?:[-_]|$)/.test(targetName);
  const operationalRoute = /\b(service\/agents|metrics\/service|agent|gateway|traffic|keepalive|registry|register-service-account)\b/.test(sourceText);
  if (operationalSource && userTarget && operationalRoute) return false;

  return true;
}

function canLinkWithinSameCodebase(source: SystemInterface, target: SystemInterface): boolean {
  if (source.id === target.id) return false;
  if (source.role === 'consumer' && target.role === 'provider') {
    if (source.topology_surface && target.topology_surface) return true;
    if (source.kind === 'http-api' && target.kind === 'http-api') return sourceAndTargetLookDistinct(source, target);
  }
  if (source.kind === 'passive-data' && target.kind === 'passive-data') return true;
  return false;
}

function sourceAndTargetLookDistinct(source: SystemInterface, target: SystemInterface): boolean {
  const sourceFiles = new Set(source.refs.map(ref => ref.file).filter(Boolean));
  const targetFiles = new Set(target.refs.map(ref => ref.file).filter(Boolean));
  if (sourceFiles.size === 0 || targetFiles.size === 0) return false;
  for (const file of sourceFiles) {
    if (targetFiles.has(file)) return false;
  }
  return true;
}

function toDataFlowPath(link: SystemLink, interfaces: SystemInterface[], applications: SystemApplication[]): SystemDataFlowPath {
  const source = interfaces.find(item => item.id === link.source_interface_id);
  const target = interfaces.find(item => item.id === link.target_interface_id);
  const appById = new Map(applications.map(app => [app.id, app]));
  const sourceApp = appById.get(link.source_application_id);
  const targetApp = appById.get(link.target_application_id);
  const sourceLabel = formatInterfaceLabel(source) || source?.name || link.source_interface_id;
  const targetLabel = formatInterfaceLabel(target) || target?.name || link.target_interface_id;
  const sourceName = sourceApp?.name || source?.application_id || link.source_application_id;
  const targetName = targetApp?.name || target?.application_id || link.target_application_id;
  const name = `${sourceName} to ${targetName}`;
  return {
    id: `flow:${link.id}`,
    name,
    mode: link.mode,
    source_codebase_id: link.source_codebase_id,
    target_codebase_id: link.target_codebase_id,
    source_application_id: link.source_application_id,
    target_application_id: link.target_application_id,
      source_interface_id: link.source_interface_id,
      target_interface_id: link.target_interface_id,
      via: [sourceLabel, targetLabel],
    description: `${sourceName} ${link.mode} ${link.kind} ${targetName}: ${sourceLabel} -> ${targetLabel}. Evidence quality: ${link.evidence_quality}.`,
    confidence: link.confidence,
    evidence: [`evidence_quality:${link.evidence_quality}`, ...link.evidence].slice(0, 8),
  };
}

function formatInterfaceLabel(item: SystemInterface | undefined): string {
  if (!item) return '';
  if (item.method && item.endpoint) return `${item.method} ${item.endpoint}`;
  if (item.endpoint) return item.endpoint;
  if (item.topic) return item.topic;
  if (item.package_name) return item.package_name;
  if (item.resource) return item.resource;
  return item.name;
}

function findUnmatchedInterfaces(interfaces: SystemInterface[], links: SystemLink[]): UnmatchedSystemInterface[] {
  const matched = new Set<string>();
  for (const link of links) {
    matched.add(link.source_interface_id);
    matched.add(link.target_interface_id);
  }

  return interfaces
    .filter(item => !matched.has(item.id) && item.kind !== 'passive-data')
    .map(item => ({
      interface_id: item.id,
      codebase_id: item.codebase_id,
      kind: item.kind,
      role: item.role,
      mode: item.mode,
      name: item.name,
      key: item.key,
      reason: unmatchedReason(item),
    }))
    .sort((left, right) => left.kind.localeCompare(right.kind) || left.key.localeCompare(right.key));
}

function buildApplications(
  codebases: SystemCodebase[],
  interfaces: SystemInterface[],
  runtimeComponents: SystemRuntimeComponent[],
  repositories: CrossCodebaseInput[],
): SystemApplication[] {
  const byId = new Map<string, SystemApplication>();
  const codebaseById = new Map(codebases.map(codebase => [codebase.id, codebase]));

  const pathHintConflicts = (a: string, b: string): boolean => {
    if (!a || !b) return false;
    if (a === b) return false;
    return !a.startsWith(`${b}/`) && !b.startsWith(`${a}/`);
  };
  const disambiguatedId = (applicationIdValue: string, pathHint: string): string =>
    `${applicationIdValue}@${slugify(pathHint || 'root')}`;

  const ensure = (applicationIdValue: string, codebaseIdValue: string, nameHint?: string, facts: Partial<SystemApplication> = {}): SystemApplication => {
    let existing = byId.get(applicationIdValue);
    let targetId = applicationIdValue;
    if (existing && pathHintConflicts(existing.path_hint || '', facts.path_hint || '')) {

      targetId = disambiguatedId(applicationIdValue, facts.path_hint || '');
      const disambiguatedExisting = byId.get(targetId);
      existing = disambiguatedExisting;
    }
    if (existing) {
      existing.deployable = existing.deployable || Boolean(facts.deployable);
      if (!existing.description && facts.description) existing.description = facts.description;
      if (!existing.path_hint && facts.path_hint) existing.path_hint = facts.path_hint;
      if (!existing.trust_guidance && facts.trust_guidance) existing.trust_guidance = facts.trust_guidance;
      existing.service_aliases = mergeStrings(existing.service_aliases, facts.service_aliases || []);
      existing.ports = mergeStrings(existing.ports, facts.ports || []);
      existing.interface_ids = mergeStrings(existing.interface_ids, facts.interface_ids || []);
      existing.runtime_component_ids = mergeStrings(existing.runtime_component_ids, facts.runtime_component_ids || []);
      existing.evidence = mergeStrings(existing.evidence || [], facts.evidence || []);
      if (facts.kind && (existing.kind === 'codebase' || existing.kind === 'tool')) existing.kind = facts.kind;
      return existing;
    }
    const codebase = codebaseById.get(codebaseIdValue);
    const name = nameHint || applicationNameFromId(applicationIdValue) || codebase?.name || codebaseIdValue;
    const application: SystemApplication = {
      id: targetId,
      codebase_id: codebaseIdValue,
      codebase_path: codebase?.path || '',
      name,
      kind: facts.kind || applicationKind(name, codebase?.system_type, facts.path_hint),
      deployable: Boolean(facts.deployable) || isDeployableApplication(name, facts.path_hint || '', facts.service_aliases || [], codebase?.system_type),
      description: facts.description,
      path_hint: facts.path_hint || '',
      service_aliases: [...new Set(facts.service_aliases || [])],
      ports: [...new Set(facts.ports || [])],
      interface_ids: [...new Set(facts.interface_ids || [])],
      runtime_component_ids: [...new Set(facts.runtime_component_ids || [])],
      evidence: [...new Set(facts.evidence || [])],
      trust_guidance: facts.trust_guidance,
    };
    byId.set(targetId, application);
    return application;
  };

  for (const codebase of codebases) {
    ensure(applicationId(codebase.id, codebase.name), codebase.id, codebase.name, {
      description: `${codebase.name} root codebase surface inferred from the CAS input.`,
      evidence: [`cas-input:${codebase.path}`],
      trust_guidance: 'Root project surface; prefer more specific apps/services/packages when present.',
    });
  }

  for (const repository of repositories) {
    const projectId = codebaseId(repository.path);
    for (const candidate of applicationSurfaceCandidatesFromCas(repository, projectId)) {
      ensure(applicationId(projectId, candidate.name), projectId, candidate.name, candidate);
    }
  }

  for (const repository of repositories) {
    const projectId = codebaseId(repository.path);
    for (const candidate of applicationSurfaceCandidatesFromEvidenceRoots(repository, projectId, byId)) {
      ensure(applicationId(projectId, candidate.name), projectId, candidate.name, candidate);
    }
  }

  for (const item of interfaces) {
    const app = ensure(item.application_id, item.codebase_id);
    app.interface_ids.push(item.id);
    app.service_aliases = mergeStrings(app.service_aliases, item.service_aliases || []);
    const fileHint = item.refs.find(ref => ref.file)?.file;
    const fileSurface = applicationSurfaceFromFile(fileHint);
    const codebase = codebaseById.get(item.codebase_id);
    const isCodebaseRoot = Boolean(codebase && app.id === applicationId(item.codebase_id, codebase.name));
    if (!isCodebaseRoot && !app.path_hint && fileSurface) app.path_hint = fileSurface.pathHint;
    if (isPackagePathHint(app.path_hint)) {
      app.kind = 'package';
      app.deployable = false;
    } else {
      app.kind = applicationKind(app.name, codebaseById.get(item.codebase_id)?.system_type, app.path_hint);
      app.deployable = app.deployable || isDeployableApplication(app.name, app.path_hint, item.service_aliases || [], codebaseById.get(item.codebase_id)?.system_type);
    }
  }
  for (const component of runtimeComponents) {
    const app = ensure(component.application_id, component.codebase_id, runtimeApplicationDisplayName(component.name));
    app.runtime_component_ids.push(component.id);
    app.service_aliases = mergeStrings(app.service_aliases, component.service_aliases || []);
    app.ports = mergeStrings(app.ports, component.ports || []);
    const fileHint = component.refs.find(ref => ref.file)?.file;
    const fileSurface = applicationSurfaceFromFile(fileHint);
    if (!app.path_hint && fileSurface) app.path_hint = fileSurface.pathHint;
    app.kind = applicationKind(app.name, codebaseById.get(component.codebase_id)?.system_type, app.path_hint);
    app.deployable = app.deployable || (
      app.kind !== 'tool' &&
      !looksLikeInternalUtilityApplication(app) &&
      !isRawInfrastructureOrImageSurface(app)
    );
  }
  const normalized = [...byId.values()]
    .map(app => {
      const normalizedApp = {
        ...app,
        service_aliases: app.service_aliases.sort(),
        ports: app.ports.sort(),
        interface_ids: [...new Set(app.interface_ids)].sort(),
        runtime_component_ids: [...new Set(app.runtime_component_ids)].sort(),
        evidence: [...new Set(app.evidence || [])].slice(0, 10),
      };
      return {
        ...normalizedApp,
        deployable: normalizedApp.deployable &&
          !isRawInfrastructureOrImageSurface(normalizedApp) &&
          !looksLikeInternalUtilityApplication(normalizedApp),
      };
    });

  suppressWorkspaceContainerRoots(normalized, repositories, codebaseById);

  const admitted = normalized.filter(app => {
    if (app.deployable) return true;
    const codebase = codebaseById.get(app.codebase_id);
    if (codebase && app.id === applicationId(app.codebase_id, codebase.name)) return true;
    if (app.kind !== 'package' && app.kind !== 'codebase') return true;
    const sameNamedDistinctSurface = normalized.some(other =>
      other.id !== app.id &&
      cleanApplicationName(other.name) === cleanApplicationName(app.name) &&
      pathHintConflicts(other.path_hint || '', app.path_hint || ''));
    if (sameNamedDistinctSurface) return true;
    if (app.kind === 'package') {
      const repository = repositories.find(candidate => codebaseId(candidate.path) === app.codebase_id);
      const imported = (repository?.cas.nodes || []).some(node => {
        if (String(node.type || '').toLowerCase() !== 'import') return false;
        const importSource = String((node.metadata as Record<string, unknown> | undefined)?.source || '');
        return applicationForImportSource(app.codebase_id, node.source?.file, importSource, normalized)?.id === app.id;
      });
      if (imported) return true;
    }
    return app.interface_ids.length > 0 || app.runtime_component_ids.length > 0;
  });

  return admitted.sort((left, right) => left.codebase_id.localeCompare(right.codebase_id) || left.name.localeCompare(right.name));
}

function suppressWorkspaceContainerRoots(
  applications: SystemApplication[],
  repositories: CrossCodebaseInput[],
  codebaseById: Map<string, SystemCodebase>,
): void {
  for (const repository of repositories) {
    const projectId = codebaseId(repository.path);
    const codebase = codebaseById.get(projectId);
    if (!codebase) continue;

    const appsForRepo = applications.filter(app => app.codebase_id === projectId);
    const rootApp = appsForRepo.find(app =>
      cleanApplicationName(app.name) === cleanApplicationName(codebase.name) && !isRealDeployableSurfacePathHint(app.path_hint));
    if (!rootApp || !rootApp.deployable) continue;

    const isContainerRoot = isWorkspaceContainerRoot(repository.path);
    const isDefaultedPhantomRoot = !isContainerRoot && isSystemTypeDefaultedWithoutRealEvidence(repository, rootApp);
    if (!isContainerRoot && !isDefaultedPhantomRoot) continue;

    const siblingDeployables = appsForRepo.some(app =>
      app.id !== rootApp.id && app.deployable && isRealDeployableSurfacePathHint(app.path_hint));
    if (!siblingDeployables) continue;

    rootApp.deployable = false;
    rootApp.boundary_evidence = mergeStrings(rootApp.boundary_evidence || [], [
      'workspace-container-root:suppressed',
      isContainerRoot
        ? 'root declares workspace members with sibling deployable apps present'
        : 'phantom-root:system-type-defaulted-to-application-without-real-evidence',
    ]);
  }
}

function isSystemTypeDefaultedWithoutRealEvidence(repository: CrossCodebaseInput, rootApp: SystemApplication): boolean {
  const systemType = repository.cas.system?.type;
  if (systemType !== 'application') return false;

  const hasEntryPointEvidence = (repository.cas.entry_points || []).length > 0;
  const hasShipOrRunnableEvidence = (repository.cas.deployable_evidence || [])
    .some(item => item.tier === 1 || item.tier === 2);
  if (hasEntryPointEvidence || hasShipOrRunnableEvidence) return false;

  if (rootApp.path_hint) return false;
  if ((rootApp.service_aliases || []).length > 0) return false;
  if ((rootApp.evidence || []).some(line => !line.startsWith('cas-input:'))) return false;

  return true;
}

function isRealDeployableSurfacePathHint(pathHint: string | undefined): boolean {
  return /^(apps|services|cmd|bin|crates|packages|libs)\//.test(pathHint || '');
}

function isWorkspaceContainerRoot(repositoryPath: string): boolean {
  try {
    const packageJsonPath = path.join(repositoryPath, 'package.json');
    if (fs.existsSync(packageJsonPath)) {
      const json = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
      if (json && (Array.isArray(json.workspaces) || (json.workspaces && Array.isArray(json.workspaces.packages)))) {
        return true;
      }
    }
  } catch {

  }

  const markerFiles = ['pnpm-workspace.yaml', 'turbo.json', 'nx.json', 'lerna.json'];
  if (markerFiles.some(marker => fs.existsSync(path.join(repositoryPath, marker)))) return true;

  try {
    const cargoTomlPath = path.join(repositoryPath, 'Cargo.toml');
    if (fs.existsSync(cargoTomlPath)) {
      const content = fs.readFileSync(cargoTomlPath, 'utf8');
      if (/^\s*\[workspace\]/m.test(content)) return true;
    }
  } catch {

  }

  return false;
}

function applicationSurfaceCandidatesFromCas(repository: CrossCodebaseInput, projectId: string): Array<Partial<SystemApplication> & { name: string }> {
  const byKey = new Map<string, Partial<SystemApplication> & { name: string }>();
  const add = (name: string, pathHint: string, evidence: string, deployableHint?: boolean) => {
    const cleanName = cleanApplicationName(name);
    if (!cleanName || shouldSkipWorkspaceApplicationPath(pathHint)) return;
    const key = `${cleanName}:${pathHint}`;
    const existing = byKey.get(key);
    const kind = applicationKind(cleanName, repository.cas.system?.type, pathHint);
    const deployable = deployableHint ?? isDeployableApplication(cleanName, pathHint, [], repository.cas.system?.type);
    const description = `${cleanName} is a ${kind} surface inferred from repo-level CAS facts under ${pathHint || 'the project root'}.`;
    if (existing) {
      existing.deployable = Boolean(existing.deployable) || deployable;
      existing.evidence = mergeStrings(existing.evidence || [], [evidence]);
      return;
    }
    byKey.set(key, {
      id: applicationId(projectId, cleanName),
      codebase_id: projectId,
      codebase_path: repository.path,
      name: cleanName,
      kind,
      deployable,
      description,
      path_hint: pathHint,
      service_aliases: [cleanName],
      ports: [],
      interface_ids: [],
      runtime_component_ids: [],
      evidence: [evidence],
      trust_guidance: deployable
        ? 'CAS-derived application surface; use repo-level drilldown before editing behavior or release boundaries.'
        : 'CAS-derived package/library surface; use repo-level drilldown before assuming runtime behavior.',
    });
  };

  for (const node of repository.cas.nodes || []) {
    const sourceFile = String((node as any)?.source?.file || (node as any)?.metadata?.file || '');
    const surface = applicationSurfaceFromFile(sourceFile);
    if (surface) {
      add(surface.name, surface.pathHint, `cas-node:${node.id || node.name || sourceFile}:${sourceFile}`, surface.deployableHint);
    }
    const nodeName = String((node as any)?.name || '');
    const nodeType = String((node as any)?.type || '').toLowerCase();
    if (/distribution|deploy|release|container|compose|kubernetes|terraform/.test(nodeType) || /release script|deploy script|dockerfile|compose service/i.test(nodeName)) {
      const fileSurface = applicationSurfaceFromFile(sourceFile);
      if (fileSurface) add(fileSurface.name, fileSurface.pathHint, `cas-runtime-or-distribution:${nodeName || nodeType}:${sourceFile}`, true);
    }
  }

  for (const unit of repository.cas.distribution_units || []) {
    for (const artifactPath of unit.artifact_paths || []) {
      const surface = applicationSurfaceFromFile(artifactPath);
      if (surface) add(surface.name, surface.pathHint, `distribution-unit:${unit.name}:${artifactPath}`, true);
    }
    for (const componentName of unit.component_names || []) {
      const cleanName = cleanApplicationName(componentName);
      if (cleanName) add(cleanName, '', `distribution-unit:${unit.name}:component:${componentName}`, true);
    }
  }

  return [...byKey.values()];
}

function applicationSurfaceFromFile(file: string | undefined): { name: string; pathHint: string; deployableHint: boolean } | undefined {
  const normalized = String(file || '').replace(/\\/g, '/');
  if (!normalized || isLegacyReferenceSource(normalized)) return undefined;
  const patterns: Array<{ regex: RegExp; deployable: boolean }> = [
    { regex: /^(apps\/[^/]+)/, deployable: true },
    { regex: /^(services\/[^/]+)/, deployable: true },
    { regex: /^(cmd\/[^/]+)/, deployable: true },
    { regex: /^(bin\/[^/]+)/, deployable: true },
    { regex: /^(packages\/[^/]+)/, deployable: false },
    { regex: /^(crates\/[^/]+)/, deployable: false },
    { regex: /^(libs\/[^/]+\/(?!src|lib|test|tests|dist|build|__tests__)[^/]+)/, deployable: false },
    { regex: /^(libs\/[^/]+)/, deployable: false },
  ];
  for (const pattern of patterns) {
    const match = normalized.match(pattern.regex);
    if (!match?.[1]) continue;
    const pathHint = match[1];
    const name = pathHint.split('/').pop() || '';
    if (!name) continue;
    return { name, pathHint, deployableHint: pattern.deployable };
  }
  const srcBin = normalized.match(/(?:^|\/)src\/bin\/([^/.]+)\.[a-z0-9]+$/i);
  if (srcBin?.[1]) return { name: srcBin[1], pathHint: `src/bin/${srcBin[1]}`, deployableHint: true };
  return undefined;
}

function applicationSurfaceCandidatesFromEvidenceRoots(
  repository: CrossCodebaseInput,
  projectId: string,
  existingById: Map<string, SystemApplication>,
): Array<Partial<SystemApplication> & { name: string }> {
  const evidenceList = deployableEvidenceFromCas(repository);
  if (evidenceList.length === 0) return [];

  const byRoot = new Map<string, { tier: 1 | 2 | 3; evidence: string[]; names: Set<string>; shipsPaths: string[] }>();
  for (const evidence of evidenceList) {

    if (!evidence.root_path || evidence.root_path === '.') continue;
    if (shouldSkipWorkspaceApplicationPath(evidence.root_path)) continue;
    const cleanEvidenceName = cleanApplicationName(evidence.name);
    const existing = byRoot.get(evidence.root_path);
    if (!existing) {
      byRoot.set(evidence.root_path, {
        tier: evidence.tier,
        evidence: [...evidence.evidence],
        names: new Set(cleanEvidenceName ? [cleanEvidenceName] : []),
        shipsPaths: [...(evidence.ships_paths || [])],
      });
    } else {
      if (evidence.tier < existing.tier) {
        existing.tier = evidence.tier;
        existing.names = new Set(cleanEvidenceName ? [cleanEvidenceName] : []);
      } else if (evidence.tier === existing.tier && cleanEvidenceName) {
        existing.names.add(cleanEvidenceName);
      }
      existing.evidence = mergeStrings(existing.evidence, evidence.evidence);
      existing.shipsPaths = mergeStrings(existing.shipsPaths, evidence.ships_paths || []);
    }
  }
  if (byRoot.size === 0) return [];

  const existingForRepo = [...existingById.values()].filter(app => app.codebase_id === projectId);

  const coveredByExisting = (rootPath: string): boolean =>
    existingForRepo.some(app => {
      const hint = app.path_hint || '';
      if (!hint) return false;
      return hint === rootPath || hint.startsWith(`${rootPath}/`) || rootPath.startsWith(`${hint}/`);
    });

  const isOpsToolingPath = (rootPath: string): boolean => /(?:^|\/)(scripts|docker|deploy|infra|hack|ci|tools|tooling)(?:\/|$)/i.test(rootPath);

  const out: Array<Partial<SystemApplication> & { name: string }> = [];
  for (const [rootPath, entry] of byRoot) {
    if (coveredByExisting(rootPath)) continue;
    if (isOpsToolingPath(rootPath)) continue;

    if (entry.tier !== 1) continue;

    if (entry.names.size > 1) continue;

    const namedOtherApps = new Set(
      entry.shipsPaths
        .map(shipped => existingForRepo.find(other => bundleNameMatches(shipped, other)))
        .filter((other): other is SystemApplication => Boolean(other))
        .map(other => other.id),
    );
    if (namedOtherApps.size >= 2) continue;

    const cleanName = cleanApplicationName(rootPath.split('/').pop() || rootPath);
    if (!cleanName) continue;

    const deployable = entry.tier === 1;
    out.push({
      id: applicationId(projectId, cleanName),
      codebase_id: projectId,
      codebase_path: repository.path,
      name: cleanName,
      kind: applicationKind(cleanName, repository.cas.system?.type, rootPath),
      deployable,
      description: `${cleanName} is an application surface discovered directly from deployable evidence at ${rootPath} (tier ${entry.tier}).`,
      path_hint: rootPath,
      service_aliases: [cleanName],
      ports: [],
      interface_ids: [],
      runtime_component_ids: [],
      evidence: [...entry.evidence],
      trust_guidance: deployable
        ? 'Evidence-derived application surface (non-conventional path); use repo-level drilldown before editing behavior or release boundaries.'
        : 'Evidence-derived package/library surface (non-conventional path); use repo-level drilldown before assuming runtime behavior.',
    });
  }
  return out;
}

function deployableEvidenceFromCas(repository: CrossCodebaseInput): DeployableEvidence[] {
  const supplied = (repository.cas as unknown as { deployable_evidence?: DeployableEvidence[] })?.deployable_evidence;
  if (Array.isArray(supplied) && supplied.length > 0) return supplied;
  return deriveDeployableEvidenceFallback(repository);
}

function deriveDeployableEvidenceFallback(repository: CrossCodebaseInput): DeployableEvidence[] {
  const byRoot = new Map<string, DeployableEvidence>();
  const upsert = (rootPath: string, tier: 1 | 2 | 3, kind: DeployableEvidence['kind'], evidenceLine: string, shipsPath?: string) => {
    if (!rootPath) return;
    const existing = byRoot.get(rootPath);
    if (existing) {
      if (tier < existing.tier) { existing.tier = tier; existing.kind = kind; }
      existing.evidence = mergeStrings(existing.evidence, [evidenceLine]);
      if (shipsPath) existing.ships_paths = mergeStrings(existing.ships_paths || [], [shipsPath]);
      return;
    }
    byRoot.set(rootPath, {
      root_path: rootPath,
      name: rootPath.split('/').pop() || rootPath,
      tier,
      kind,
      evidence: [evidenceLine],
      ships_paths: shipsPath ? [shipsPath] : undefined,
    });
  };

  for (const node of repository.cas.nodes || []) {
    const sourceFile = String((node as any)?.source?.file || (node as any)?.metadata?.file || '');
    const surface = applicationSurfaceFromFile(sourceFile);
    if (!surface) continue;
    const nodeName = String((node as any)?.name || '');
    const nodeType = String((node as any)?.type || '').toLowerCase();
    const combined = `${nodeName} ${nodeType} ${sourceFile}`.toLowerCase();
    if (/dockerfile/.test(combined)) {
      upsert(surface.pathHint, 1, 'container', `cas-node:dockerfile:${sourceFile}`);
    } else if (/compose/.test(combined)) {
      upsert(surface.pathHint, 1, 'compose-service', `cas-node:compose:${sourceFile}`);
    } else if (/kubernetes|k8s|\bhelm\b/.test(combined)) {
      upsert(surface.pathHint, 1, 'k8s', `cas-node:k8s:${sourceFile}`);
    } else if (/serverless|lambda|cloud function/.test(combined)) {
      upsert(surface.pathHint, 1, 'serverless', `cas-node:serverless:${sourceFile}`);
    } else if (/installer|packaging|\.msi\b|\.deb\b|\.rpm\b|nsis/.test(combined)) {
      upsert(surface.pathHint, 1, 'installer', `cas-node:installer:${sourceFile}`);
    } else if (/deploy script|release script|\bci\b.*deploy|deploy.*\bci\b/.test(combined)) {
      upsert(surface.pathHint, 1, 'ci-deploy', `cas-node:ci-deploy:${sourceFile}`);
    } else if (/^(bin\/|cmd\/)/.test(surface.pathHint) || /(?:^|\/)src\/bin\//.test(sourceFile)) {
      upsert(surface.pathHint, 2, 'bin', `cas-node:bin:${sourceFile}`);
    } else if (surface.deployableHint && /(^|\/)(apps|services)\//.test(surface.pathHint)) {
      upsert(surface.pathHint, 2, 'server-entry', `cas-node:server-entry:${sourceFile}`);
    } else if (!surface.deployableHint) {
      upsert(surface.pathHint, 3, 'package', `cas-node:package:${sourceFile}`);
    }
  }

  for (const unit of repository.cas.distribution_units || []) {
    const kindLower = String(unit.kind || '').toLowerCase();
    const tierOneKind: DeployableEvidence['kind'] | undefined =
      /container|docker/.test(kindLower) ? 'container' :
      /compose/.test(kindLower) ? 'compose-service' :
      /k8s|kubernetes|helm/.test(kindLower) ? 'k8s' :
      /serverless|lambda/.test(kindLower) ? 'serverless' :
      /installer|package|msi|deb|rpm/.test(kindLower) ? 'installer' :
      /ci|deploy|release/.test(kindLower) ? 'ci-deploy' : undefined;
    for (const artifactPath of unit.artifact_paths || []) {
      const surface = applicationSurfaceFromFile(artifactPath);
      const rootPath = surface?.pathHint || unit.name;
      if (tierOneKind) {
        upsert(rootPath, 1, tierOneKind, `distribution-unit:${unit.name}:${artifactPath}`, artifactPath);
      } else {
        upsert(rootPath, 2, 'bin', `distribution-unit:${unit.name}:${artifactPath}`, artifactPath);
      }
    }

    if ((unit.component_names || []).length > 1) {
      for (const componentName of unit.component_names || []) {
        const cleanName = cleanApplicationName(componentName);
        if (!cleanName) continue;
        upsert(cleanName, 1, 'installer', `distribution-unit:${unit.name}:bundles:${unit.component_names.join(',')}`);
      }
    }
  }

  return [...byRoot.values()];
}

function bundleNameMatches(shipped: string, app: SystemApplication, resolvedName?: string): boolean {
  const cleanShipped = cleanApplicationName(shipped);
  if (!cleanShipped) return false;
  if (cleanApplicationName(app.name) === cleanShipped) return true;
  const pathBasename = cleanApplicationName((app.path_hint || '').split('/').pop() || '');
  if (pathBasename && pathBasename === cleanShipped) return true;
  if (resolvedName && cleanApplicationName(resolvedName) === cleanShipped) return true;
  return false;
}

interface DeployableResolution {
  rootPath: string;
  name: string;
  tier: 1 | 2 | 3 | 4;
  kind: DeployableEvidence['kind'] | 'folder-heuristic';
  evidence: string[];
  shipsPaths: string[];

  selfAnchored?: boolean;
}

function resolveDeployables(applications: SystemApplication[], repositories: CrossCodebaseInput[]): void {
  for (const repository of repositories) {
    const projectId = codebaseId(repository.path);
    const evidenceList = deployableEvidenceFromCas(repository);

    const evidenceByRoot = new Map<string, DeployableEvidence>();
    for (const evidence of evidenceList) {
      const existing = evidenceByRoot.get(evidence.root_path);
      if (!existing) {
        evidenceByRoot.set(evidence.root_path, { ...evidence });
        continue;
      }
      if (evidence.tier < existing.tier) {
        evidenceByRoot.set(evidence.root_path, {
          ...evidence,
          evidence: mergeStrings(evidence.evidence, existing.evidence),
          entry_files: mergeStrings(evidence.entry_files || [], existing.entry_files || []),
          ships_paths: mergeStrings(evidence.ships_paths || [], existing.ships_paths || []),
        });
      } else if (evidence.tier > existing.tier) {
        existing.evidence = mergeStrings(existing.evidence, evidence.evidence);
        existing.entry_files = mergeStrings(existing.entry_files || [], evidence.entry_files || []);
        existing.ships_paths = mergeStrings(existing.ships_paths || [], evidence.ships_paths || []);
      } else {
        existing.evidence = mergeStrings(existing.evidence, evidence.evidence);
        existing.entry_files = mergeStrings(existing.entry_files || [], evidence.entry_files || []);
        existing.ships_paths = mergeStrings(existing.ships_paths || [], evidence.ships_paths || []);
      }
    }

    const appsForRepo = applications.filter(app => app.codebase_id === projectId);
    if (appsForRepo.length === 0) continue;

    const resolutions = new Map<string, DeployableResolution>();
    for (const app of appsForRepo) {
      const rootPath = app.path_hint || app.name;
      const hasSpecificSibling = appsForRepo.some(other =>
        other.id !== app.id &&
        Boolean(other.path_hint) &&
        !isRawInfrastructureOrImageSurface(other));

      const directoryDecoupledCandidates = evidenceList.filter(candidate =>
        candidate.tier === 1 && candidate.entrypoint_member && bundleNameMatches(candidate.entrypoint_member, app));
      const directoryDecoupledMatch = directoryDecoupledCandidates.find(candidate => candidate.root_path !== '.')
        || directoryDecoupledCandidates[0];
      const exactRootEvidence = directoryDecoupledMatch
        || (!app.path_hint && !hasSpecificSibling ? evidenceByRoot.get('.') : undefined)
        || evidenceByRoot.get(rootPath);
      const evidence = exactRootEvidence
        || [...evidenceByRoot.values()].find(candidate => rootPath && (rootPath.startsWith(`${candidate.root_path}/`) || candidate.root_path.startsWith(`${rootPath}/`)))
        || (rootPath ? evidenceByRoot.get('') : undefined);
      if (evidence) {
        resolutions.set(app.id, {
          rootPath: evidence.root_path,
          name: evidence.name,
          tier: evidence.tier,
          kind: evidence.kind,
          evidence: [...evidence.evidence],
          shipsPaths: evidence.ships_paths || [],

          selfAnchored: Boolean(exactRootEvidence),
        });
      } else {

        resolutions.set(app.id, {
          rootPath,
          name: app.name,
          tier: 4,
          kind: 'folder-heuristic',
          evidence: [`folder-heuristic:${rootPath || app.name}`],
          shipsPaths: [],
        });
      }
    }

    const appByRoot = new Map(appsForRepo.filter(app => app.path_hint).map(app => [app.path_hint as string, app]));
    for (const app of appsForRepo) {
      const held = evidenceByRoot.get(app.path_hint || '');
      if (!held?.bundled_into) continue;
      const owner = appByRoot.get(held.bundled_into.replace(/^deployable:/, ''));
      if (!owner || owner.id === app.id || owner.bundled_into === app.id) continue;
      app.bundled_into = owner.id;
      app.boundary_evidence = mergeStrings(app.boundary_evidence || [], [
        `bundled-into:${owner.name}`,
        'positive-bundling-evidence:engine-scope-ship-artifact',
        ...held.evidence,
      ]);
    }

    const rootBundleTargets = new Map<string, { primaryAppId: string; evidence: DeployableEvidence }>();
    for (const evidence of evidenceList) {
      if (evidence.tier !== 1 || evidence.root_path !== '.') continue;
      const shipsPaths = evidence.ships_paths || [];
      if (shipsPaths.length < 2) continue;

      const hasOwnDedicatedTier1 = (app: SystemApplication): boolean => {
        const ownResolution = resolutions.get(app.id);
        return Boolean(ownResolution && ownResolution.tier === 1 && ownResolution.rootPath !== evidence.root_path);
      };
      const namedApps = appsForRepo.filter(app => shipsPaths.some(shipped => bundleNameMatches(shipped, app, resolutions.get(app.id)?.name)));
      if (namedApps.length < 2) continue;
      const dedicatedApps = namedApps.filter(hasOwnDedicatedTier1);
      const sweepableApps = namedApps.filter(app => !hasOwnDedicatedTier1(app));

      const primary = (evidence.entrypoint_member && dedicatedApps.find(app => bundleNameMatches(evidence.entrypoint_member!, app, resolutions.get(app.id)?.name)))
        || dedicatedApps[0]
        || (evidence.entrypoint_member && namedApps.find(app => bundleNameMatches(evidence.entrypoint_member!, app, resolutions.get(app.id)?.name)))
        || namedApps[0];
      rootBundleTargets.set(primary.id, { primaryAppId: primary.id, evidence });
      for (const member of sweepableApps) {
        if (member.id === primary.id) continue;
        member.bundled_into = primary.id;
        member.boundary_evidence = mergeStrings(member.boundary_evidence || [], [
          `bundled-into:${primary.name}`,
          `positive-bundling-evidence:root-installer-artifact`,
          ...evidence.evidence,
        ]);
      }

    }

    const demotedAsPackagingArtifact = new Set<string>();
    for (const app of appsForRepo) {
      if (app.bundled_into || rootBundleTargets.has(app.id)) continue;
      const resolution = resolutions.get(app.id);
      if (!resolution || resolution.tier !== 1 || resolution.rootPath === '.') continue;
      if (!resolution.selfAnchored) continue;
      const namedSiblings = new Set(
        resolution.shipsPaths
          .map(shipped => appsForRepo.find(other => other.id !== app.id && bundleNameMatches(shipped, other, resolutions.get(other.id)?.name)))
          .filter((other): other is SystemApplication => Boolean(other))
          .map(other => other.id),
      );
      if (namedSiblings.size < 2) continue;
      app.deployable = false;
      demotedAsPackagingArtifact.add(app.id);
      app.boundary_evidence = mergeStrings(app.boundary_evidence || [], [
        'packaging-artifact-not-own-deployable:ships-paths-name-multiple-sibling-apps',
        ...resolution.evidence,
      ]);
    }

    for (const app of appsForRepo) {
      if (app.bundled_into) continue;
      const resolution = resolutions.get(app.id);
      if (!resolution) continue;
      if (!app.deployable && demotedAsPackagingArtifact.has(app.id)) continue;
      if (resolution.tier === 1 || rootBundleTargets.has(app.id)) {

        if (!app.deployable && resolution.selfAnchored) {
          app.deployable = true;
          app.boundary_evidence = mergeStrings(app.boundary_evidence || [], [
            'tier-1-overrides-folder-prior:self-anchored-ship-artifact-outranks-packages-crates-libs-default',
          ]);
        }
        const rootBundle = rootBundleTargets.get(app.id);
        app.boundary_evidence = mergeStrings(app.boundary_evidence || [], [
          `tier-1-deployable:${resolution.kind}`,
          ...resolution.evidence,
          ...(rootBundle ? [`bundle-primary:root-installer-artifact`, ...rootBundle.evidence.evidence] : []),
        ]);
        continue;
      }

      const bundleTarget = appsForRepo.find(other => {
        if (other.id === app.id) return false;
        const otherResolution = resolutions.get(other.id);
        if (!otherResolution || otherResolution.tier !== 1) return false;
        const shipsHit = otherResolution.shipsPaths.some(shipped =>
          shipped === resolution.rootPath
          || shipped.includes(app.name)
          || (resolution.name && resolution.name !== app.name && shipped.includes(resolution.name))
          || (resolution.rootPath && shipped.startsWith(resolution.rootPath)));
        const bundleEvidenceHit = otherResolution.evidence.some(line =>
          line.includes('bundles:') && (line.includes(app.name) || (resolution.name ? line.includes(resolution.name) : false)));
        return shipsHit || bundleEvidenceHit;
      });

      if (bundleTarget && resolution.tier <= 3) {
        app.bundled_into = bundleTarget.id;
        app.boundary_evidence = mergeStrings(app.boundary_evidence || [], [
          `bundled-into:${bundleTarget.name}`,
          `positive-bundling-evidence:ships_paths-or-distribution-unit`,
          ...resolution.evidence,
        ]);
        continue;
      }

      if (resolution.tier === 4) {
        app.boundary_evidence = mergeStrings(app.boundary_evidence || [], [`tier-4-folder-heuristic:${resolution.rootPath}`, 'possible_bundle:unresolved-no-tier1-3-evidence']);
      } else {

        const hasTier1Sibling = appsForRepo.some(other => other.id !== app.id && resolutions.get(other.id)?.tier === 1);
        app.boundary_evidence = mergeStrings(app.boundary_evidence || [], [
          `tier-${resolution.tier}-standalone:${resolution.kind}`,
          ...resolution.evidence,
          ...(hasTier1Sibling ? ['possible_bundle:no_positive_evidence_found'] : []),
        ]);
      }
    }

    applyShippedGate(appsForRepo, resolutions, rootBundleTargets);
    for (const app of appsForRepo) {
      if (!isRawInfrastructureOrImageSurface(app)) continue;
      app.deployable = false;
      app.boundary_evidence = mergeStrings(app.boundary_evidence || [], ['infrastructure-artifact-not-application']);
    }
    const specificDeployableSiblings = appsForRepo.filter(app =>
      Boolean(app.path_hint) && app.deployable && !isRawInfrastructureOrImageSurface(app));
    if (specificDeployableSiblings.length > 0) {
      for (const app of appsForRepo) {
        if (app.path_hint || !app.deployable) continue;
        const ownsDistinctRootArtifact = evidenceList.some(evidence =>
          evidence.root_path === '.' &&
          evidence.tier === 1 &&
          (evidence.ships_paths?.length ?? 0) <= 1 &&
          (bundleNameMatches(evidence.name, app) ||
            Boolean(evidence.entrypoint_member && bundleNameMatches(evidence.entrypoint_member, app))));
        if (ownsDistinctRootArtifact) continue;
        app.deployable = false;
        app.boundary_evidence = mergeStrings(app.boundary_evidence || [], [
          'workspace-container-root:specific-deployable-siblings-own-runtime-boundaries',
        ]);
      }
    }
  }
}

function linkSubCasNodes(applications: SystemApplication[], repositories: CrossCodebaseInput[]): void {
  const rootMatches = (appRoot: string, unitRoot: string): boolean => {
    if (!appRoot || !unitRoot) return false;
    if (appRoot === unitRoot) return true;
    return appRoot.startsWith(`${unitRoot}/`) || unitRoot.startsWith(`${appRoot}/`);
  };

  for (const repository of repositories) {
    const projectId = codebaseId(repository.path);
    const appsForRepo = applications.filter(app => app.codebase_id === projectId);
    if (appsForRepo.length === 0) continue;

    let das;
    try {
      das = getCachedDeployableAnalyses(repository.cas);
    } catch {
      continue;
    }
    if (!das.promoted || das.sub_cas_nodes.units.length === 0) continue;

    for (const app of appsForRepo) {
      const appRoot = app.path_hint || app.name;
      const nameMatch = das.sub_cas_nodes.units.find(unit => distributionNamesMatch(app.name, unit.name));
      if (app.bundled_into) {
        if (nameMatch) app.source_sub_cas_node_id = nameMatch.id;
        continue;
      }
      const match = nameMatch || das.sub_cas_nodes.units.find(unit =>
        rootMatches(appRoot, unit.root_path) ||
        unit.member_root_paths.some(memberRoot => rootMatches(appRoot, memberRoot)));
      if (match) app.source_sub_cas_node_id = match.id;
    }
  }
}

function mergeDuplicateSubCasNodeApplications(applications: SystemApplication[]): void {
  const byUnit = new Map<string, SystemApplication[]>();
  for (const app of applications) {
    if (!app.source_sub_cas_node_id || app.merged_into) continue;
    const key = `${app.codebase_id}:${app.source_sub_cas_node_id}`;
    byUnit.set(key, [...(byUnit.get(key) || []), app]);
  }

  const evidenceScore = (app: SystemApplication): number =>
    app.runtime_component_ids.length * 8 +
    app.interface_ids.length * 6 +
    app.ports.length * 4 +
    app.service_aliases.length * 2 +
    (app.boundary_evidence || []).length +
    (app.evidence || []).length;

  for (const unitApplications of byUnit.values()) {
    if (unitApplications.length < 2) continue;
    const identityGroups: SystemApplication[][] = [];
    for (const app of unitApplications) {
      const pathName = path.basename(app.path_hint || '');
      const group = identityGroups.find(items => items.some(item =>
        distributionNamesMatch(item.name, app.name) ||
        distributionNamesMatch(path.basename(item.path_hint || ''), app.name) ||
        distributionNamesMatch(item.name, pathName)));
      if (group) group.push(app);
      else identityGroups.push([app]);
    }

    for (const duplicates of identityGroups) {
      if (duplicates.length < 2) continue;
      const survivor = [...duplicates].sort((left, right) =>
        Number(isRawInfrastructureOrImageSurface(left)) - Number(isRawInfrastructureOrImageSurface(right)) ||
        evidenceScore(right) - evidenceScore(left) ||
        Number(right.kind !== 'codebase') - Number(left.kind !== 'codebase') ||
        left.name.localeCompare(right.name))[0];

      for (const duplicate of duplicates) {
        if (duplicate.id === survivor.id) continue;
        survivor.interface_ids = mergeStrings(survivor.interface_ids, duplicate.interface_ids);
        survivor.runtime_component_ids = mergeStrings(survivor.runtime_component_ids, duplicate.runtime_component_ids);
        survivor.ports = mergeStrings(survivor.ports, duplicate.ports);
        survivor.service_aliases = mergeStrings(survivor.service_aliases, duplicate.service_aliases);
        survivor.evidence = mergeStrings(survivor.evidence || [], duplicate.evidence || []);
        survivor.boundary_evidence = mergeStrings(survivor.boundary_evidence || [], duplicate.boundary_evidence || []);
        if (!survivor.description && duplicate.description) survivor.description = duplicate.description;
        duplicate.merged_into = survivor.id;
        duplicate.boundary_evidence = mergeStrings(duplicate.boundary_evidence || [], [
          `duplicate-sub-cas-node-surface:merged-into:${survivor.id}`,
          `shared-sub-cas-node:${duplicate.source_sub_cas_node_id}`,
        ]);
      }
    }
  }
}

function mergeCrossMemberSubdirApplications(
  applications: SystemApplication[],
  codebases: SystemCodebase[],
  repositories: CrossCodebaseInput[],
): void {
  if (codebases.length < 2) return;

  const nameKey = (value: string | undefined): string => cleanApplicationName(value).replace(/[-_]/g, '').toLowerCase();

  const repositoryByCodebaseId = new Map(repositories.map(repository => [codebaseId(repository.path), repository]));
  const identityKeysByCodebaseId = new Map<string, Set<string>>();
  for (const codebase of codebases) {
    const repository = repositoryByCodebaseId.get(codebase.id);
    const keys = new Set<string>();
    for (const candidate of [codebase.name, repository?.name, repository?.cas.system?.name]) {
      const key = nameKey(candidate);
      if (key) keys.add(key);
    }
    identityKeysByCodebaseId.set(codebase.id, keys);
  }
  const pathTail = (pathHint: string | undefined): string => {
    const segments = String(pathHint || '').split('/').filter(Boolean);
    return segments[segments.length - 1] || '';
  };
  const evidenceScore = (app: SystemApplication): number =>
    app.interface_ids.length + app.runtime_component_ids.length * 2 + app.ports.length + (app.evidence || []).length;

  for (const parentApp of applications) {
    if (parentApp.merged_into) continue;

    if (!isRealDeployableSurfacePathHint(parentApp.path_hint)) continue;
    const tail = pathTail(parentApp.path_hint);
    if (!tail) continue;
    const tailKey = nameKey(tail);
    if (!tailKey) continue;

    for (const memberCodebase of codebases) {
      if (memberCodebase.id === parentApp.codebase_id) continue;

      const memberIdentityKeys = identityKeysByCodebaseId.get(memberCodebase.id);
      if (!memberIdentityKeys || !memberIdentityKeys.has(tailKey)) continue;

      const candidates = applications.filter(app =>
        app.codebase_id === memberCodebase.id &&
        !app.merged_into &&
        (nameKey(app.name) === nameKey(parentApp.name) || nameKey(app.name) === tailKey));
      if (candidates.length === 0) continue;

      const survivor = [...candidates].sort((left, right) => evidenceScore(right) - evidenceScore(left))[0];
      if (!survivor || survivor.id === parentApp.id) continue;

      survivor.also_declared_by = mergeStrings(survivor.also_declared_by || [], [parentApp.codebase_id]);
      survivor.interface_ids = mergeStrings(survivor.interface_ids, parentApp.interface_ids);
      survivor.runtime_component_ids = mergeStrings(survivor.runtime_component_ids, parentApp.runtime_component_ids);
      survivor.ports = mergeStrings(survivor.ports, parentApp.ports);
      survivor.service_aliases = mergeStrings(survivor.service_aliases, parentApp.service_aliases);
      survivor.evidence = mergeStrings(survivor.evidence || [], [
        `cross-member-duplicate-absorbed:${parentApp.codebase_id}:${parentApp.id}`,
        ...(parentApp.evidence || []),
      ]);
      survivor.boundary_evidence = mergeStrings(survivor.boundary_evidence || [], [
        `absorbed-monorepo-subdir-application:${parentApp.codebase_id}${parentApp.path_hint ? `:${parentApp.path_hint}` : ''}`,
      ]);
      if (!survivor.description && parentApp.description) survivor.description = parentApp.description;

      parentApp.merged_into = survivor.id;
      parentApp.boundary_evidence = mergeStrings(parentApp.boundary_evidence || [], [
        `cross-member-duplicate:merged-into:${survivor.codebase_id}:${survivor.name}`,
        `containment-evidence:subdir-path-tail-matches-member-project-name:${tail}`,
        `name-identity-evidence:${nameKey(parentApp.name)}`,
      ]);
      break;
    }
  }
}

function applyShippedGate(
  appsForRepo: SystemApplication[],
  resolutions: Map<string, DeployableResolution>,
  rootBundleTargets: Map<string, { primaryAppId: string; evidence: DeployableEvidence }>,
): void {
  const runnableApps = appsForRepo.filter(app => {
    const resolution = resolutions.get(app.id);
    return resolution && (resolution.tier === 2 || resolution.tier === 3);
  });

  if (runnableApps.length <= 1) return;
  if (!appsForRepo.some(app => resolutions.get(app.id)?.tier === 1)) return;

  for (const app of runnableApps) {
    const resolution = resolutions.get(app.id)!;
    if (app.bundled_into) continue;
    if (rootBundleTargets.has(app.id)) continue;

    const referencedByTier1 = appsForRepo.some(other => {
      if (other.id === app.id) return false;
      const otherResolution = resolutions.get(other.id);
      return otherResolution?.tier === 1 && otherResolution.shipsPaths.some(shipped => bundleNameMatches(shipped, app));
    });
    if (referencedByTier1) continue;

    if (!app.deployable) continue;

    app.deployable = false;
    app.boundary_evidence = mergeStrings(app.boundary_evidence || [], [
      'runnable-not-shipped:no-tier1-artifact-references-it',
      `tier-${resolution.tier}-runnable-only:${resolution.kind}`,
    ]);
  }
}

function shouldSkipWorkspaceApplicationPath(pathHint: string | undefined): boolean {
  const normalized = String(pathHint || '').toLowerCase();
  if (!normalized) return false;
  if (/(^|\/)(tests?|__tests__|fixtures?|examples?|samples?|docs?|dist|build|coverage|node_modules|vendor)(\/|$)/.test(normalized)) return true;
  if (/\/(?:generated|gen|tmp|temp)\//.test(`/${normalized}/`)) return true;
  return false;
}

function buildWorkspaceDistributionUnits(
  repositories: CrossCodebaseInput[],
  applications: SystemApplication[],
  codebases: SystemCodebase[],
): WorkspaceDistributionUnit[] {
  const codebaseById = new Map(codebases.map(codebase => [codebase.id, codebase]));
  const appsByCodebase = new Map<string, SystemApplication[]>();
  for (const app of applications) {
    const list = appsByCodebase.get(app.codebase_id) || [];
    list.push(app);
    appsByCodebase.set(app.codebase_id, list);
  }

  const units: WorkspaceDistributionUnit[] = [];
  for (const repository of repositories) {
    const projectId = codebaseId(repository.path);
    const project = codebaseById.get(projectId);
    const repoApps = appsByCodebase.get(projectId) || [];
    for (const unit of repository.cas.distribution_units || []) {
      const componentNames = (unit.component_names || []).filter(Boolean);
      const componentDeployableIds = repoApps
        .filter(app => componentNames.some(name => distributionNamesMatch(app.name, name) || distributionNamesMatch(app.path_hint || '', name)))
        .map(app => app.id);
      units.push({
        id: `${projectId}:distribution:${slugify(unit.id || unit.name)}`,
        project_id: projectId,
        project: project?.name || repository.name || projectId,
        name: unit.name,
        kind: unit.kind,
        platforms: unit.platforms || [],
        component_names: componentNames,
        component_deployable_ids: [...new Set(componentDeployableIds)].sort(),
        artifact_paths: unit.artifact_paths || [],
        confidence: unit.confidence,
        evidence: (unit.evidence || []).map(item => ({
          source: item.source,
          file: item.file,
          line: item.line,
          claim: item.claim,
          confidence: item.confidence,
        })),
        agent_guidance: unit.agent_guidance,
      });
    }
  }
  return units.sort((left, right) => left.project_id.localeCompare(right.project_id) || left.name.localeCompare(right.name));
}

function distributionNamesMatch(left: string, right: string): boolean {
  const a = normalizeDistributionName(left);
  const b = normalizeDistributionName(right);
  return Boolean(a && b && (a === b || a.endsWith(`-${b}`) || b.endsWith(`-${a}`)));
}

function normalizeDistributionName(value: string): string {
  return String(value || '').replace(/\\/g, '/').split('/').pop()!.replace(/\.exe$/i, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase();
}

export interface WorkspaceSharedCodeRollupConsumer {
  deployable_id: string;
  deployable_name: string;
  project_id: string;
  usage_count: number;
  consumed_symbols: string[];
  evidence_quality: WorkspaceLinkEvidenceQuality;
}

export interface WorkspaceSharedCodeRollupBlastRadiusEntry {
  symbol: string;
  consumer_deployable_ids: string[];
  consumer_count: number;
}

export interface WorkspaceSharedCodeRollup {
  id: string;
  lib_application_id: string;
  lib_name: string;
  project_id: string;
  path_hint: string;
  consumer_count: number;
  total_usage_count: number;
  consumers: WorkspaceSharedCodeRollupConsumer[];
  consumed_surface: string[];
  surface_derivable: boolean;
  blast_radius: WorkspaceSharedCodeRollupBlastRadiusEntry[];
  evidence: string[];
}

function buildSharedCodeRollup(
  repositories: CrossCodebaseInput[],
  applications: SystemApplication[],
  applicationLinks: SystemApplicationLink[],
): WorkspaceSharedCodeRollup[] {
  const libApps = applications.filter(app => !app.deployable && isPackagePathHint(app.path_hint));
  if (libApps.length === 0) return [];

  const appById = new Map(applications.map(app => [app.id, app]));
  const repoByProjectId = new Map(repositories.map(repository => [codebaseId(repository.path), repository]));

  const linksByTargetLibId = new Map<string, SystemApplicationLink[]>();
  for (const link of applicationLinks) {
    if (link.kind !== 'sdk-install') continue;
    const list = linksByTargetLibId.get(link.target_application_id) || [];
    list.push(link);
    linksByTargetLibId.set(link.target_application_id, list);
  }

  const rollups: WorkspaceSharedCodeRollup[] = [];
  for (const libApp of libApps) {
    const libLinks = linksByTargetLibId.get(libApp.id) || [];
    const consumerDeployableIds = new Set(
      libLinks
        .map(link => link.source_application_id)
        .filter(id => appById.get(id)?.deployable),
    );
    if (consumerDeployableIds.size === 0) continue;

    const repository = repoByProjectId.get(libApp.codebase_id);
    const consumedByDeployable = new Map<string, Set<string>>();
    let surfaceDerivable = false;
    if (repository) {
      for (const node of repository.cas.nodes || []) {
        if (String((node as any)?.type || '').toLowerCase() !== 'import') continue;
        const metadata = (node as any)?.metadata as Record<string, unknown> | undefined;
        const importSource = String(metadata?.source || '');
        if (!importSource) continue;
        const sourceFile = (node as any)?.source?.file as string | undefined;

        const consumerApp = applicationForFile(libApp.codebase_id, sourceFile, applications);
        if (!consumerApp || consumerApp.id === libApp.id || !consumerApp.deployable) continue;
        if (!consumerDeployableIds.has(consumerApp.id)) continue;

        const resolvedTarget = applicationForImportSource(libApp.codebase_id, sourceFile, importSource, applications);
        if (resolvedTarget?.id !== libApp.id) continue;
        const specifiers = Array.isArray(metadata?.specifiers) ? metadata!.specifiers as Array<Record<string, unknown>> : [];
        if (specifiers.length === 0) continue;
        surfaceDerivable = true;
        const set = consumedByDeployable.get(consumerApp.id) || new Set<string>();
        for (const specifier of specifiers) {
          const imported = String(specifier?.imported || specifier?.name || '').trim();
          if (imported && imported !== '*') set.add(imported);
        }
        consumedByDeployable.set(consumerApp.id, set);
      }
    }

    const consumers: WorkspaceSharedCodeRollupConsumer[] = [...consumerDeployableIds].map(deployableId => {
      const deployableApp = appById.get(deployableId);
      const links = libLinks.filter(link => link.source_application_id === deployableId);
      const usageCount = links.length || 1;
      const evidenceQuality = links.find(link => link.evidence_quality === 'source-backed')
        ? 'source-backed' as const
        : (links[0]?.evidence_quality || 'source-backed');
      return {
        deployable_id: deployableId,
        deployable_name: deployableApp?.name || deployableId,
        project_id: deployableApp?.codebase_id || libApp.codebase_id,
        usage_count: usageCount,
        consumed_symbols: [...(consumedByDeployable.get(deployableId) || [])].sort(),
        evidence_quality: evidenceQuality,
      };
    }).sort((left, right) => right.usage_count - left.usage_count || left.deployable_name.localeCompare(right.deployable_name));

    const consumedSurface = [...new Set(consumers.flatMap(consumer => consumer.consumed_symbols))].sort();

    const blastRadiusBySymbol = new Map<string, Set<string>>();
    for (const consumer of consumers) {
      for (const symbol of consumer.consumed_symbols) {
        const set = blastRadiusBySymbol.get(symbol) || new Set<string>();
        set.add(consumer.deployable_id);
        blastRadiusBySymbol.set(symbol, set);
      }
    }
    const blastRadius: WorkspaceSharedCodeRollupBlastRadiusEntry[] = [...blastRadiusBySymbol.entries()]
      .map(([symbol, ids]) => ({ symbol, consumer_deployable_ids: [...ids].sort(), consumer_count: ids.size }))
      .sort((left, right) => right.consumer_count - left.consumer_count || left.symbol.localeCompare(right.symbol));

    rollups.push({
      id: `${libApp.codebase_id}:shared-code-rollup:${slugify(libApp.name)}`,
      lib_application_id: libApp.id,
      lib_name: libApp.name,
      project_id: libApp.codebase_id,
      path_hint: libApp.path_hint || '',
      consumer_count: consumers.length,
      total_usage_count: consumers.reduce((sum, consumer) => sum + consumer.usage_count, 0),
      consumers,
      consumed_surface: consumedSurface,
      surface_derivable: surfaceDerivable,
      blast_radius: blastRadius,
      evidence: libApp.evidence || [],
    });
  }

  return rollups.sort((left, right) => right.consumer_count - left.consumer_count || left.lib_name.localeCompare(right.lib_name));
}

function summarize(
  codebases: SystemCodebase[],
  applications: SystemApplication[],
  overviewApplications: SystemApplication[],
  distributionUnits: WorkspaceDistributionUnit[],
  interfaces: SystemInterface[],
  runtimeComponents: SystemRuntimeComponent[],
  runtimeLinks: SystemRuntimeLink[],
  applicationLinks: SystemApplicationLink[],
  systemInsights: SystemInsight[],
  links: SystemLink[],
  unmatched: UnmatchedSystemInterface[],
  composition: WorkspaceCompositionProfile,
  riskAreas: WorkspaceRiskArea[],
  capabilities: WorkspaceCapability[],
  workflows: WorkspaceWorkflow[],
  domains: WorkspaceDomain[],
  entities: WorkspaceEntity[],
  entityPaths: WorkspaceEntityPath[],
  workflowsTotal?: number,
): CrossCodebaseSystemGraph['summary'] {
  return {
    codebases: codebases.length,
    applications: overviewApplications.length,
    application_surfaces: applications.length,
    distribution_units: distributionUnits.length,
    composition_kind: composition.kind,
    interfaces: countBy(interfaces, item => item.kind),
    modes: countBy(interfaces, item => item.mode),
    links: countBy(links, item => item.kind),
    runtime_components: runtimeComponents.length,
    runtime_links: runtimeLinks.length,
    application_links: applicationLinks.length,
    system_insights: systemInsights.length,
    unmatched: unmatched.length,
    risk_areas: riskAreas.length,
    capabilities: capabilities.length,
    workflows: workflows.length,
    workflows_total: workflowsTotal ?? workflows.length,
    workflows_truncated: (workflowsTotal ?? workflows.length) > workflows.length,
    domains: domains.length,
    entities: entities.length,
    entity_paths: entityPaths.length,
  };
}

function isHttpProvider(entryPoint: CASEntryPoint): boolean {
  if (entryPoint.type === 'http' || entryPoint.type === 'websocket') return true;
  if (entryPoint.type !== 'route') return false;
  const framework = String(entryPoint.metadata?.framework || entryPoint.source_analyzer || '').toLowerCase();
  if (framework.includes('react')) return false;
  return Boolean(entryPoint.trigger?.path || entryPoint.trigger?.method);
}

function isHttpConsumer(exitPoint: CASExitPoint): boolean {
  return exitPoint.type === 'api' || exitPoint.type === 'webhook';
}

function isConcreteHttpConsumerEndpoint(endpoint: string | undefined, exitPoint?: CASExitPoint): boolean {
  const raw = String(endpoint || '').trim();
  const name = String(exitPoint?.name || '').trim();
  if (!raw) return false;
  if (/^(external|unknown|fetch external|get external|post external|delete external|put external|patch external)$/i.test(raw)) return false;
  if (/^(external|unknown|fetch external|get external|post external|delete external|put external|patch external)$/i.test(name)) return false;
  if (/^EXTERNAL_CALL\b/i.test(raw) || /^EXTERNAL_CALL\b/i.test(name)) return false;
  if (/^Bearer\s+/i.test(raw)) return false;
  if (/^[A-Za-z_][A-Za-z0-9_:.-]*::[A-Za-z_][A-Za-z0-9_]*$/.test(raw)) return false;
  if (/^[A-Za-z_][A-Za-z0-9_.-]*\.(get|post|put|delete|patch|send|read|write|connect|bind|listen|fetch)$/i.test(raw)) return false;
  if (/^[A-Za-z_][A-Za-z0-9_]*(::[A-Za-z_][A-Za-z0-9_]*)+$/.test(raw)) return false;
  return /^(https?:\/\/|wss?:\/\/|\/|\$\{|[A-Za-z0-9_.-]+:\d+|[A-Za-z0-9_.-]+\/)/.test(raw);
}

function isMessageListener(entryPoint: CASEntryPoint): boolean {
  return entryPoint.type === 'message' || entryPoint.type === 'event' || entryPoint.type === 'websocket';
}

function isMessagePublisher(exitPoint: CASExitPoint): boolean {
  return exitPoint.type === 'message' || exitPoint.type === 'event';
}

function isStreamEntry(entryPoint: CASEntryPoint): boolean {
  return entryPoint.type === 'websocket' || String(entryPoint.metadata?.transport || '').toLowerCase().includes('stream');
}

function isStreamExit(exitPoint: CASExitPoint): boolean {
  return String(exitPoint.metadata?.transport || '').toLowerCase().includes('stream');
}

function httpCompatible(source: SystemInterface, target: SystemInterface): boolean {
  const sourceRoute = normalizeRoute(source.endpoint || source.key);
  const targetRoute = normalizeRoute(target.endpoint || target.key);
  if (!routeCompatible(sourceRoute, targetRoute)) return false;
  const sourceMethod = normalizeHttpMethod(source.method);
  const targetMethod = normalizeHttpMethod(target.method);
  return !sourceMethod || sourceMethod === 'FETCH' || !targetMethod || targetMethod === 'ALL' || sourceMethod === targetMethod;
}

function routeMatchConfidence(source: SystemInterface, target: SystemInterface): number {
  const sourceRoute = normalizeRoute(source.endpoint || source.key);
  const targetRoute = normalizeRoute(target.endpoint || target.key);
  const methodExact = normalizeHttpMethod(source.method) === normalizeHttpMethod(target.method);
  const routeExact = routeSegmentCandidates(sourceRoute).some(left =>
    routeSegmentCandidates(targetRoute).some(right => exactShapeWithoutWildcards(left, right))
  );
  if (routeExact && methodExact) return 0.96;
  if (routeExact) return 0.9;
  return methodExact ? 0.84 : 0.76;
}

function hasLikelyExternalTemplatedBase(endpoint: string | undefined): boolean {
  const raw = String(endpoint || '');
  const template = raw.match(/\$\{([^}]+)}/);
  if (!template || template.index === undefined) return false;
  const prefix = raw.slice(0, template.index);
  return prefix.length === 0 || /^(?:https?:\/\/|wss?:\/\/)$/.test(prefix);
}

function routeCompatible(left: string, right: string): boolean {
  for (const leftParts of routeSegmentCandidates(left)) {
    for (const rightParts of routeSegmentCandidates(right)) {
      if (routePartsCompatible(leftParts, rightParts)) return true;
    }
  }
  return false;
}

function routePartsCompatible(leftParts: string[], rightParts: string[]): boolean {
  if (leftParts.length !== rightParts.length) return false;
  const segmentsCompatible = leftParts.every((part, index) => part === rightParts[index] || part === ':param' || rightParts[index] === ':param');
  if (!segmentsCompatible) return false;
  return hasSharedLiteralSegment(leftParts, rightParts) || exactShapeWithoutWildcards(leftParts, rightParts);
}

function routeSegmentCandidates(value: string): string[][] {
  const original = routeSegments(value);
  const variants = [original];
  if (original[0] === 'api') variants.push(original.slice(1));
  if (original[0] === 'api' && /^v\d+$/i.test(original[1] || '')) variants.push(original.slice(2));
  return variants.filter(parts => parts.length > 0);
}

function httpKey(method: string | undefined, endpoint: string | undefined): string {
  return `${normalizeHttpMethod(method) || 'FETCH'} ${normalizeHttpKeyEndpoint(endpoint || '/')}`;
}

function normalizeHttpKeyEndpoint(endpoint: string): string {
  const raw = String(endpoint || '').trim();
  if (!raw || raw.startsWith('/')) return normalizeRoute(raw || '/');
  if (raw.includes('${')) return normalizeRoute(raw);
  try {
    if (/^https?:\/\//i.test(raw)) {
      const url = new URL(raw);
      return `//${url.hostname}${url.port ? `:${url.port}` : ''}${normalizeRoute(url.pathname || '/')}`;
    }
    const url = new URL(`http://${raw}`);
    return `//${url.hostname}${url.port ? `:${url.port}` : ''}${normalizeRoute(url.pathname || '/')}`;
  } catch {
    return normalizeRoute(raw);
  }
}

function normalizeHttpMethod(method: string | undefined): string | undefined {
  if (!method) return undefined;
  const normalized = method.toUpperCase();
  if (normalized === 'REQUEST') return 'FETCH';
  if (['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'ALL', 'FETCH'].includes(normalized)) return normalized;
  return normalized.includes('GET') ? 'GET'
    : normalized.includes('POST') ? 'POST'
      : normalized.includes('PUT') ? 'PUT'
        : normalized.includes('PATCH') ? 'PATCH'
          : normalized.includes('DELETE') ? 'DELETE'
            : normalized.includes('FETCH') ? 'FETCH'
              : normalized;
}

function normalizeRoute(value: string): string {
  const raw = String(value || '').trim();
  if (!raw) return '/';
  let route = raw;
  try {
    if (/^https?:\/\//i.test(raw)) route = new URL(raw).pathname || '/';
  } catch {
    route = raw;
  }
  route = route
    .replace(/\?.*$/, '')
    .replace(/\$\{[^}]+\}/g, ':param')
    .replace(/:\w+/g, ':param')
    .replace(/\[[^\]]+\]/g, ':param')
    .replace(/{[^}]+}/g, ':param')
    .replace(/\/+/g, '/');
  if (!route.startsWith('/')) route = `/${route}`;
  return route.replace(/\/$/g, '') || '/';
}

function routeSegments(value: string): string[] {
  return normalizeRoute(value).split('/').filter(Boolean).map(segment => {
    if (segment.startsWith(':')) return ':param';
    if (/^\d+$/.test(segment)) return ':param';
    return segment.toLowerCase();
  });
}

function hasSharedLiteralSegment(leftParts: string[], rightParts: string[]): boolean {
  return leftParts.some((part, index) => part !== ':param' &&
    rightParts[index] !== ':param' &&
    part === rightParts[index] &&
    !/^(api|v\d+)$/.test(part));
}

function exactShapeWithoutWildcards(leftParts: string[], rightParts: string[]): boolean {
  return leftParts.length > 0 &&
    leftParts.every(part => part !== ':param') &&
    rightParts.every(part => part !== ':param') &&
    leftParts.every((part, index) => part === rightParts[index]);
}

function normalizeTopic(value: string | undefined): string {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, '.').replace(/:+/g, '.');
}

function normalizeResource(value: string | undefined): string {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw || raw.length < 3) return '';
  return raw.replace(/[^a-z0-9_.-]/g, '-').replace(/-+/g, '-');
}

function isSpecificSharedResource(value: string | undefined): boolean {
  const resource = normalizeResource(value);
  if (!resource) return false;
  if (resource.length < 4) return false;
  if (resource.includes('.')) {
    const parts = resource.split('.');
    const last = parts[parts.length - 1];
    if (/^(find|findone|findbyid|create|update|delete|remove|flush|count|getreference|nativeupdate|persist|save|query|execute)$/.test(last)) {
      return false;
    }
    if (/^(this|manager|repository|entitymanager)$/.test(parts[0])) return false;
  }
  return !new Set([
    'database',
    'db',
    'data',
    'object',
    'entity',
    'entitymanager',
    'repository',
    'manager',
    'model',
    'record',
    'table',
    'user',
    'users',
    'organization',
    'organizations',
    'connection',
    'connections',
  ]).has(resource);
}

function entryServiceAliases(entryPoint: CASEntryPoint): string[] {
  return normalizeAliases(
    entryPoint.metadata?.service_aliases,
    entryPoint.metadata?.deployment_service_name,
    serviceAliasesFromEndpoint(entryPoint.trigger?.path),
  );
}

function routeServiceAliases(route: any, refs: CrossCodebaseRef[]): string[] {
  return normalizeAliases(
    route.metadata?.service_aliases,
    route.metadata?.deployment_service_name,
    refs.flatMap(ref => serviceAliasesFromFile(ref.file)),
  );
}

function exitServiceAliases(exitPoint: CASExitPoint): string[] {
  return normalizeAliases(
    exitPoint.metadata?.service_aliases,
    exitPoint.metadata?.deployment_service_name,
    exitPoint.target?.service_id,
    serviceAliasesFromEndpoint(exitPoint.target?.endpoint),
  );
}

function sourceNodeServiceAliases(lookupIndex: CrossCodebaseLookupIndex, nodeId: string | undefined): string[] {
  if (!nodeId) return [];
  const node = lookupNode(lookupIndex, nodeId);
  const metadata = (node?.metadata || {}) as Record<string, unknown>;
  const explicitAliases = normalizeAliases(
    metadata.service_aliases,
    metadata.deployment_service_name,
  ).filter(isUsefulApplicationAlias);
  if (explicitAliases.length > 0) return explicitAliases;
  const type = String(node?.type || '').toLowerCase();
  const hasTopologySurface = Boolean(metadata.topology_surface);
  const isDeploymentNode = hasTopologySurface || /(?:compose|container|docker|kubernetes|deployment|runtime)/.test(type);
  if (!isDeploymentNode) return [];
  return normalizeAliases(node?.name?.replace(/^Compose service:\s*/i, '')).filter(isUsefulApplicationAlias);
}

function isHashOrIdShapedToken(token: string): boolean {
  const normalized = (token || '').toLowerCase();
  if (normalized.length < 8) return false;
  if (/^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/.test(normalized)) return true;
  if (normalized.length >= 12 && /^[0-9a-f]+$/.test(normalized)) return true;
  if (normalized.length >= 10 && /^[0-9a-z]+$/.test(normalized) && /[0-9]/.test(normalized) && !/[aeiou]/.test(normalized)) {
    return true;
  }
  return false;
}

function isHostShapedToken(cleanedName: string): boolean {
  const normalized = (cleanedName || '').toLowerCase();

  const dotSegments = normalized.split('.').filter(Boolean);
  if (dotSegments.length >= 2) {
    const dotTld = dotSegments[dotSegments.length - 1];
    if (/^[a-z]{2,6}$/.test(dotTld) && dotSegments.slice(0, -1).every(segment => /^[a-z0-9-]+$/.test(segment))) return true;
  }

  return false;
}

function isUnsafeDeployableName(cleanedName: string): boolean {
  if (!cleanedName) return true;
  return isHashOrIdShapedToken(cleanedName) || isHostShapedToken(cleanedName);
}

function safeRepositoryFallbackName(repository: CrossCodebaseInput): string {
  return cleanApplicationName(path.basename(repository.path)) || 'codebase';
}

function sanitizeDeployableName(candidate: string, repository: CrossCodebaseInput): string {
  const cleaned = cleanApplicationName(candidate);
  if (isUnsafeDeployableName(cleaned)) return safeRepositoryFallbackName(repository);
  return candidate;
}

function serviceAliasesFromEndpoint(endpoint: string | undefined): string[] {
  const value = String(endpoint || '').trim();
  if (!value) return [];
  if (value.startsWith('/')) return [];
  if (value.includes('${') || value.includes(':param')) return [];
  if (!/^https?:\/\//i.test(value) && !value.includes('/') && !/^[A-Za-z0-9_.-]+:\d+/.test(value)) return [];
  try {
    if (!/^https?:\/\//i.test(value) && !/^[A-Za-z0-9_.-]+(?::\d+)?(?:\/|$)/.test(value)) return [];
    const url = /^https?:\/\//i.test(value) ? new URL(value) : new URL(`http://${value}`);
    const host = url.hostname;
    if (host && !host.includes('${') && !/^(localhost|127\.0\.0\.1|0\.0\.0\.0)$/.test(host)) return [host];
  } catch {

  }
  const match = value.match(/^https?:\/\/([A-Za-z0-9_.-]+)/) || value.match(/^([A-Za-z0-9_.-]+)(?::\d+)?(?:\/|$)/);
  return match ? [match[1]] : [];
}

function serviceAliasesFromFile(file: string | undefined): string[] {
  const normalized = String(file || '').toLowerCase();
  const match = normalized.match(/(?:^|\/)apps\/([a-z0-9_.-]+)\//);
  return match ? [match[1]] : [];
}

function inferApplicationName(
  repository: CrossCodebaseInput,
  refs: CrossCodebaseRef[],
  aliases: string[] = [],
  fallback = '',
): string {
  for (const ref of refs) {
    const fromFile = applicationNameFromFile(ref.file);
    if (fromFile) return fromFile;
  }
  for (const alias of normalizeAliases(aliases)) {
    if (isExternalRuntimeDependency(alias)) return alias;
    if (isUsefulApplicationAlias(alias) && !isUnsafeDeployableName(cleanApplicationName(alias))) return alias;
  }

  const endpointAlias = serviceAliasesFromEndpoint(fallback).find(alias => isUsefulApplicationAlias(alias) && !isHostShapedToken(cleanApplicationName(alias)));
  if (endpointAlias) return endpointAlias;
  const externalEndpointAlias = serviceAliasesFromEndpoint(fallback).find(alias => isExternalRuntimeDependency(alias));
  if (externalEndpointAlias) return externalEndpointAlias;
  return sanitizeDeployableName(repository.name || repository.cas.system?.name || path.basename(repository.path), repository);
}

function applicationNameFromFile(file: string | undefined): string {
  const normalized = String(file || '').replace(/\\/g, '/');
  const lower = normalized.toLowerCase();

  const rustServiceModule = normalized.match(/(?:^|\/)crates\/[^/]+\/src\/([^/.]+)\.rs$/i);
  if (rustServiceModule?.[1] && !/^(lib|main|mod|types?|models?|schema|error|config|utils?)$/i.test(rustServiceModule[1])) {
    const moduleName = rustServiceModule[1].replace(/_/g, '-');

    if (/(api|server|service|worker|client)/i.test(moduleName)) return moduleName;
  }
  const patterns = [
    /(?:^|\/)apps\/([^/]+)\//i,
    /(?:^|\/)packages\/([^/]+)\//i,
    /(?:^|\/)crates\/([^/]+)\//i,
    /(?:^|\/)bin\/([^/]+)\//i,
    /(?:^|\/)src\/bin\/([^/.]+)\.[a-z0-9]+$/i,
  ];
  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (match?.[1]) return match[1];
  }
  const serviceMatch = normalized.match(/(?:^|\/)services\/([^/]+)\//i);
  if (serviceMatch?.[1] && !/(?:^|\/)(src|lib|libs|packages|apps)\//i.test(lower.split('/services/')[0] || '')) {
    return serviceMatch[1];
  }
  const dockerfile = normalized.match(/(?:^|\/)([^/]+)\.Dockerfile$/i);
  if (dockerfile?.[1]) return cleanApplicationName(dockerfile[1]);
  return '';
}

function applicationId(codebase: string, name: string): string {
  return `${codebase}:app:${slugify(cleanApplicationName(name) || 'codebase')}`;
}

function applicationNameFromId(id: string): string {
  return id.split(':app:')[1] || '';
}

function applicationKind(name: string, systemType?: string, pathHint?: string): SystemApplication['kind'] {
  if (isPackagePathHint(pathHint)) return 'package';
  const normalized = name.toLowerCase();
  if (/(?:^|[-_/])(cli|command|commands|console)(?:[-_/]|$)/.test(normalized)) return 'cli';
  if (/(?:^|[-_/])(build|check|script|migrate|seed|release|releases|ci|jenkins|terraform)(?:[-_/]|$)/.test(normalized)) return 'tool';
  if (/(worker|listener|scheduler|agent|drop-server|coordinator|gateway|sync)/.test(normalized)) return 'service';
  if (/(api|backend|server|service)/.test(normalized)) return 'service';
  if (/(ui|web|frontend|client|mobile|ios|android)/.test(normalized)) return 'app';
  if (/(sdk|package|library)/.test(normalized) || systemType === 'package' || systemType === 'library') return 'package';
  return systemType === 'service' ? 'service' : 'codebase';
}

function isDeployableApplication(name: string, pathHint: string | undefined, aliases: string[] = [], systemType?: string): boolean {
  const normalized = [name, pathHint || '', ...aliases].join(' ').toLowerCase();
  if (isPackagePathHint(pathHint)) return false;
  if (/(?:^|[-_/])(build|check|script|migrate|seed)(?:[-_/]|$)/.test(normalized)) return false;
  if (/(?:^|\/)(apps|bin|services)\//.test(pathHint || '')) return true;
  if (/(api|ui|web|frontend|backend|server|worker|listener|scheduler|agent|client|coordinator|gateway|drop-server|mcp|mobile|ios|android)/.test(normalized)) return true;
  if (aliases.length > 0 && systemType !== 'library' && systemType !== 'package') return true;
  return systemType === 'application' || systemType === 'service';
}

function isPackagePathHint(pathHint: string | undefined): boolean {
  return /(?:^|\/)(packages|crates|libs)\//.test(pathHint || '');
}

function runtimeApplicationDisplayName(name: string): string {
  return cleanApplicationName(name.replace(/^image:\s*/i, '').replace(/^.*\//, '').replace(/\.dockerfile$/i, '')) || name;
}

function cleanApplicationName(value: string | undefined): string {
  const raw = String(value || '').trim();
  if (!raw) return '';
  return raw
    .replace(/^https?:\/\//i, '')
    .replace(/:\d+(?:\/.*)?$/, '')
    .replace(/^.*\//, '')
    .replace(/^compose service:\s*/i, '')
    .replace(/^docker image definition:\s*/i, '')
    .replace(/\.dockerfile$/i, '')

    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .replace(/[^a-zA-Z0-9_.-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
}

function isUsefulApplicationAlias(value: string): boolean {
  return Boolean(value) && !/^(api|app|server|service|backend|frontend|http|https|postgres|redis|minio|database|db|localhost)$/.test(value);
}

function mergeStrings(left: string[], right: string[]): string[] {
  return [...new Set([...left, ...right].filter(Boolean))];
}

function serviceAliasesOverlap(source: SystemInterface, target: SystemInterface): boolean {
  const sourceAliases = new Set(normalizeAliases(source.service_aliases, serviceAliasesFromEndpoint(source.endpoint)));
  const targetAliases = normalizeAliases(target.service_aliases, serviceAliasesFromEndpoint(target.endpoint));
  return targetAliases.some(alias => sourceAliases.has(alias));
}

function normalizeAliases(...values: unknown[]): string[] {
  const aliases = new Set<string>();
  const add = (value: unknown) => {
    if (Array.isArray(value)) {
      for (const item of value) add(item);
      return;
    }
    const alias = String(value || '').trim().toLowerCase();
    if (!alias) return;
    if (alias.includes('${')) return;
    if (/^(http|https|tcp|udp)$/.test(alias)) return;
    aliases.add(alias.replace(/:\d+$/, ''));
  };
  for (const value of values) add(value);
  return [...aliases];
}

function topologySurface(metadata: unknown): string | undefined {
  if (!metadata || typeof metadata !== 'object') return undefined;
  const surface = String((metadata as Record<string, unknown>).topology_surface || '').trim();
  return surface || undefined;
}

function runtimeComponentName(node: CASNode): string {
  return node.name.replace(/^Compose service:\s*/i, '').replace(/^Docker image definition:\s*/i, 'image: ');
}

function runtimeComponentApplicationName(repository: CrossCodebaseInput, node: CASNode, aliases: string[]): string {
  const surface = topologySurface(node.metadata);
  if (surface === 'terraform' || String(node.type || '').startsWith('infrastructure_')) {
    return repository.name || repository.cas.system?.name || 'infrastructure';
  }
  const name = runtimeComponentName(node);
  if (isExternalRuntimeDependency(name, node.type)) return name;
  return inferApplicationName(repository, [nodeRef(node)], aliases, runtimeComponentName(node));
}

function runtimeComponentPorts(node: CASNode): string[] {
  const metadata = (node.metadata || {}) as Record<string, any>;
  const attributes = (metadata.attributes || {}) as Record<string, any>;
  const ports = [
    ...(Array.isArray(metadata.ports) ? metadata.ports : []),
    ...(Array.isArray(metadata.exposed_ports) ? metadata.exposed_ports : []),
    ...(Array.isArray(attributes.ports) ? attributes.ports : []),
    ...(Array.isArray(attributes.exposed_ports) ? attributes.exposed_ports : []),
  ];
  return [...new Set(ports.flatMap(port => {
    if (!port) return [];
    if (typeof port === 'string') return [port];
    if (typeof port === 'object') {
      const value = (port as Record<string, unknown>).container || (port as Record<string, unknown>).host;
      return value ? [String(value)] : [];
    }
    return [String(port)];
  }).map(value => value.replace(/\/tcp$|\/udp$/i, '')))];
}

function runtimeEnvironment(node: CASNode): string | undefined {
  return nodeEnvironment(node);
}

function nodeEnvironment(node: CASNode): string | undefined {
  const metadata = (node.metadata || {}) as Record<string, any>;
  const attributes = (metadata.attributes || {}) as Record<string, any>;
  const direct = String(metadata.environment || attributes.environment || attributes.workspace || '').trim();
  if (direct) return direct;
  const fromFile = environmentFromPath(String(node.source?.file || ''));
  if (fromFile) return fromFile;
  return undefined;
}

function environmentFromPath(filePath: string): string | undefined {
  const file = filePath.toLowerCase();
  if (/(^|\/)(prod|production)(\/|\.|-|_)/.test(file)) return 'production';
  if (/(^|\/)(stage|staging)(\/|\.|-|_)/.test(file)) return 'staging';
  if (/(^|\/)(dev|development|demo)(\/|\.|-|_)/.test(file)) return file.includes('demo') ? 'demo' : 'development';
  if (/(^|\/)(internal)(\/|\.|-|_)/.test(file)) return 'internal';
  if (/(^|\/)(local|docker-compose)(\/|\.|-|_)/.test(file)) return 'local';
  return undefined;
}

function runtimeComponentForInterface(
  item: SystemInterface,
  componentByRef: Map<string, SystemRuntimeComponent>,
  componentByAlias: Map<string, SystemRuntimeComponent[]>,
): SystemRuntimeComponent | undefined {
  for (const ref of item.refs) {
    const component = componentByRef.get(`${item.codebase_id}:${ref.id}`);
    if (component) return component;
  }
  for (const alias of normalizeAliases(item.service_aliases, serviceAliasesFromEndpoint(item.endpoint))) {
    const matches = componentByAlias.get(`${item.codebase_id}:${alias}`);
    if (matches?.length) return matches[0];
  }
  return undefined;
}

function normalizePackageName(value: string | undefined): string {
  return String(value || '').trim().toLowerCase();
}

function isWorkspaceRelevantExternalDependency(packageName: string): boolean {
  const normalized = normalizePackageName(packageName);
  if (!normalized) return false;
  return /auth0|clerk|firebase|supabase|stripe|sendgrid|twilio|sentry|datadog|posthog|launchdarkly|openai|anthropic|aws-sdk|@aws-sdk|google-cloud|azure|slack|github|linear|segment|snowflake|bigquery/.test(normalized);
}

function displayExternalDependencyName(packageName: string): string {
  const normalized = normalizePackageName(packageName);
  if (normalized.includes('auth0')) return 'Auth0';
  if (normalized.includes('clerk')) return 'Clerk';
  if (normalized.includes('firebase')) return 'Firebase';
  if (normalized.includes('supabase')) return 'Supabase';
  if (normalized.includes('stripe')) return 'Stripe';
  if (normalized.includes('sendgrid')) return 'SendGrid';
  if (normalized.includes('twilio')) return 'Twilio';
  if (normalized.includes('sentry')) return 'Sentry';
  if (normalized.includes('datadog')) return 'Datadog';
  if (normalized.includes('posthog')) return 'PostHog';
  if (normalized.includes('launchdarkly')) return 'LaunchDarkly';
  if (normalized.includes('openai')) return 'OpenAI';
  if (normalized.includes('anthropic')) return 'Anthropic';
  if (normalized.includes('aws-sdk') || normalized.includes('@aws-sdk')) return 'AWS SDK';
  if (normalized.includes('google-cloud')) return 'Google Cloud';
  if (normalized.includes('azure')) return 'Azure';
  if (normalized.includes('github')) return 'GitHub';
  if (normalized.includes('linear')) return 'Linear';
  return packageName.replace(/^@/, '').split('/')[0] || packageName;
}

function directPackages(cas: CASOutput): Array<{ name: string; version?: string; direct?: boolean }> {
  return (cas.dependencies?.packages || []).filter(pkg => pkg.direct !== false);
}

function sdkPackageCandidates(repository: CrossCodebaseInput): string[] {
  const candidates = new Set<string>();
  const cas = repository.cas;
  const packageNames = [
    cas.system?.metadata?.package_name,
    cas.system?.metadata?.packageName,
    cas.system?.metadata?.npm_package,
    cas.system?.name,
    repository.name,
  ];
  for (const candidate of packageNames) {
    const packageName = normalizePackageName(String(candidate || ''));
    if (packageName && (cas.system?.type === 'library' || cas.system?.type === 'package' || packageName.includes('sdk'))) {
      candidates.add(packageName);
    }
  }
  for (const node of cas.nodes || []) {
    const name = normalizePackageName(node.name);
    if ((node.type === 'module' || node.type === 'package' || node.type === 'library') && name.includes('sdk')) {
      candidates.add(name);
    }
  }
  return [...candidates].filter(candidate => !looksLikePlatformPackage(candidate)).sort();
}

function looksLikePlatformPackage(packageName: string): boolean {
  if (/^(react|next|vue|express|fastify|@nestjs\/|typescript|tsx|vite|jest|vitest|eslint|prettier|webpack|babel|zod|dotenv|axios)$/.test(packageName)) return true;
  if (packageName.startsWith('@/') || packageName.startsWith('@hooks/') || packageName.startsWith('@stores/') || packageName.startsWith('@types/') || packageName.startsWith('@utils/')) return true;
  if (/^[@]?(mui|emotion|dnd-kit|tanstack|nestjs|types)\b/.test(packageName)) return true;
  return false;
}

function isSystemPackageConsumer(packageName: string): boolean {
  if (packageName.includes('sdk')) return true;
  if (/\/sdk(?:-|$)|-sdk(?:-|$)/.test(packageName)) return true;
  if (/^(?:@[^/]+\/)?(?:client|api)-sdk$/.test(packageName)) return true;
  return false;
}

function entryRefs(lookupIndex: CrossCodebaseLookupIndex, entryPoint: CASEntryPoint): CrossCodebaseRef[] {
  return [
    ...nodeRefs(lookupIndex, [entryPoint.source_node, entryPoint.handler?.node_id].filter(Boolean) as string[]),
    entryPoint.handler?.file ? { id: entryPoint.handler.node_id || entryPoint.source_node, file: entryPoint.handler.file, line: entryPoint.handler.line } : undefined,
  ].filter(Boolean) as CrossCodebaseRef[];
}

function exitRefs(lookupIndex: CrossCodebaseLookupIndex, exitPoint: CASExitPoint): CrossCodebaseRef[] {
  return nodeRefs(lookupIndex, [exitPoint.source_node, ...(exitPoint.connected_nodes || [])].filter(Boolean));
}

function providerSdkRefs(lookupIndex: CrossCodebaseLookupIndex): CrossCodebaseRef[] {
  return lookupIndex.provider_sdk_refs;
}

function nodeRefs(lookupIndex: CrossCodebaseLookupIndex, nodeIds: string[]): CrossCodebaseRef[] {
  return [...new Set(nodeIds)].map(id => {
    const node = lookupNode(lookupIndex, id);
    return node ? nodeRef(node) : { id };
  });
}

function lookupNode(lookupIndex: CrossCodebaseLookupIndex, nodeId: string | undefined): CASNode | undefined {
  if (!nodeId) return undefined;
  if (lookupIndex.diagnostics) lookupIndex.diagnostics.node_lookups += 1;
  return lookupIndex.nodes_by_id.get(nodeId);
}

function lookupEntryPoint(lookupIndex: CrossCodebaseLookupIndex, entryPointId: string): CASEntryPoint | undefined {
  if (lookupIndex.diagnostics) lookupIndex.diagnostics.entry_lookups += 1;
  return lookupIndex.entry_points_by_id.get(entryPointId);
}

function lookupExitPoint(lookupIndex: CrossCodebaseLookupIndex, exitPointId: string): CASExitPoint | undefined {
  if (lookupIndex.diagnostics) lookupIndex.diagnostics.exit_lookups += 1;
  return lookupIndex.exit_points_by_id.get(exitPointId);
}

function nodeRef(node: CASNode): CrossCodebaseRef {
  return {
    id: node.id,
    name: node.name,
    type: node.type,
    file: node.source?.file,
    line: node.source?.line,
  };
}

function dedupeInterfaces(interfaces: SystemInterface[]): SystemInterface[] {
  const byKey = new Map<string, SystemInterface>();
  for (const item of interfaces) {
    const key = interfaceDedupeKey(item);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, item);
      continue;
    }
    byKey.set(key, {
      ...existing,
      refs: mergeById(existing.refs, item.refs),
      evidence: [...existing.evidence, ...item.evidence],
    });
  }
  return [...byKey.values()].sort((left, right) => left.codebase_id.localeCompare(right.codebase_id) || left.kind.localeCompare(right.kind) || left.name.localeCompare(right.name));
}

function interfaceDedupeKey(item: SystemInterface): string {
  if (item.topology_surface) {
    const sourceRef = item.refs[0]?.id || item.id;
    return `${item.codebase_id}:${item.kind}:${item.role}:${item.key}:${sourceRef}`;
  }
  return `${item.codebase_id}:${item.kind}:${item.role}:${item.key}`;
}

function dedupeLinks(links: SystemLink[]): SystemLink[] {
  const byId = new Map<string, SystemLink>();
  for (const link of links) {
    const existing = byId.get(link.id);
    if (!existing || linkQualityRank(link) > linkQualityRank(existing) || link.confidence > existing.confidence) byId.set(link.id, link);
  }
  return [...byId.values()].sort((left, right) => left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id));
}

function dedupeRuntimeLinks(links: SystemRuntimeLink[]): SystemRuntimeLink[] {
  const byId = new Map<string, SystemRuntimeLink>();
  for (const link of links) {
    const key = `${link.kind}:${link.source_component_id}:${link.target_component_id}`;
    const existing = byId.get(key);
    if (!existing || link.confidence > existing.confidence) byId.set(key, { ...link, id: key });
  }
  return [...byId.values()].sort((left, right) => left.codebase_id.localeCompare(right.codebase_id) || left.id.localeCompare(right.id));
}

function dedupeApplicationLinks(links: SystemApplicationLink[]): SystemApplicationLink[] {
  const byKey = new Map<string, SystemApplicationLink>();
  for (const link of links) {
    const keepInterfaceSpecificity = link.evidence_quality === 'source-backed' || link.evidence_quality === 'route-shape-inferred';
    const key = keepInterfaceSpecificity
      ? [
        link.kind,
        link.source_application_id,
        link.target_application_id,
        link.source_interface_id || link.source_runtime_component_id || '',
        link.target_interface_id || link.target_runtime_component_id || '',
      ].join(':')
      : [
        link.kind,
        link.mode,
        link.evidence_quality,
        link.source_application_id,
        link.target_application_id,
      ].join(':');
    const existing = byKey.get(key);
    if (!existing || linkQualityRank(link) > linkQualityRank(existing) || link.confidence > existing.confidence) byKey.set(key, { ...link, id: key });
  }
  return [...byKey.values()].sort((left, right) => left.source_application_id.localeCompare(right.source_application_id) || left.target_application_id.localeCompare(right.target_application_id));
}

function dedupeInsights(insights: SystemInsight[]): SystemInsight[] {
  const byId = new Map<string, SystemInsight>();
  for (const insight of insights) {
    const key = `${insight.type}:${normalizeAiItemName(insight.title)}`;
    const existing = byId.get(key);
    if (!existing || insight.confidence > existing.confidence) byId.set(key, {
      ...insight,
      application_ids: [...new Set(insight.application_ids)].sort(),
      codebase_ids: [...new Set(insight.codebase_ids)].sort(),
      evidence: [...new Set(insight.evidence.filter(Boolean))].slice(0, 12),
    });
  }
  return [...byId.values()].sort((left, right) => left.type.localeCompare(right.type) || left.title.localeCompare(right.title));
}

function mergeById<T extends { id: string }>(left: T[], right: T[]): T[] {
  const byId = new Map<string, T>();
  for (const item of [...left, ...right]) byId.set(item.id, item);
  return [...byId.values()];
}

function countBy<T, K extends string>(items: T[], getKey: (item: T) => K): Record<K, number> {
  return items.reduce((counts, item) => {
    const key = getKey(item);
    counts[key] = (counts[key] || 0) + 1;
    return counts;
  }, {} as Record<K, number>);
}

function unmatchedReason(item: SystemInterface): string {
  if (item.role === 'provider') return 'No analyzed consumer matched this provided interface.';
  if (item.role === 'consumer') return 'No analyzed provider matched this consumed interface.';
  if (item.role === 'publisher') return 'No analyzed listener matched this published message or stream.';
  if (item.role === 'listener') return 'No analyzed publisher matched this listener.';
  return 'No matching interface was found in the selected analyses.';
}

function codebaseId(repositoryPath: string): string {
  return slugify(repositoryPath.split(path.sep).filter(Boolean).slice(-2).join('-')) || slugify(repositoryPath) || 'codebase';
}

function interfaceId(codebase: string, prefix: string, value: string): string {
  return `${codebase}:${prefix}:${slugify(stripLocalPathPrefix(value))}`;
}

function runtimeComponentId(codebase: string, nodeId: string): string {
  return `${codebase}:runtime:${slugify(stripLocalPathPrefix(nodeId))}`;
}

function linkId(kind: string, source: string, target: string): string {
  return `link:${kind}:${slugify(stripLocalPathPrefix(source))}:${slugify(stripLocalPathPrefix(target))}`;
}

function stripLocalPathPrefix(value: string): string {
  return String(value || '')
    .replace(/\/Users\/[^/]+\/dev\//gi, '')
    .replace(/\/home\/[^/]+\/dev\//gi, '')
    .replace(/[A-Z]:\\Users\\[^\\]+\\dev\\/gi, '')
    .replace(/\\/g, '/');
}

function slugify(input: string): string {
  return String(input || '')
    .replace(/[^a-zA-Z0-9@/._-]/g, '-')
    .replace(/[/.]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase()
    .slice(0, 120);
}
