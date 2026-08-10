export interface CASOutput {
  cas_version: string;
  /**
   * Deterministic identity of the analyzer build that produced this output
   * (getBuildIdentity().version — base package version + git sha). Incremental
   * analysis stamps this and forces a full rebuild of derived artifacts when the
   * stored stamp differs from the current analyzer build, so engine/deriver code
   * changes are not masked by cached derived layers on unchanged target files.
   */
  analyzer_build?: string;
  /**
   * Stage fingerprints (see analyzer/core/stage-fingerprint.ts): scoped hashes
   * of the parser/language-analyzer layer and the graph/derived-facts layer,
   * respectively. Incremental analysis compares these instead of the blanket
   * `analyzer_build` stamp so a release that never touches the parse/graph
   * pipeline (e.g. MCP-tool-only or parent-CAS-composition-only changes) does not force a full
   * rebuild just because the whole-monorepo build identity moved.
   */
  parser_fingerprint?: string;
  derived_fingerprint?: string;
  analysis_timestamp: string;
  analysis_id: string;
  system: CASSystem;
  analysis_phases?: CASAnalysisPhase[];
  /** Compact per-run timing breakdown (total + coarse stage buckets + per-
   *  analyzer ms). Instrumentation only — see CASAnalysisTimings. */
  timings?: CASAnalysisTimings;
  architecture_summary?: CASArchitectureSummary;
  route_table?: CASRouteTableEntry[];
  database_schema?: CASDatabaseSchema;
  perspectives?: CASPerspective[];
  nodes: CASNode[];
  edges: CASEdge[];
  entry_points?: CASEntryPoint[];
  exit_points?: CASExitPoint[];
  external_services?: CASExternalService[];
  repository_links?: CASCrossRepositoryLink[];
  dependencies?: Dependencies;
  disclosure?: DisclosureHints;
  analyzer_contributions: CASAnalyzerContribution[];

  // v1.3.0+ Call graph structures
  method_calls?: CASMethodCall[];
  call_chains?: CASCallChain[];
  decorators?: CASDecorator[];

  // v1.4.0+ Documentation and health structures
  documentation_summary?: CASDocumentationSummary;
  todos_summary?: CASTodoSummary;
  implementation_health?: CASImplementationHealth;
  system_health?: CASSystemHealth;

  // Legacy structures for backward compatibility
  behaviors?: CASBehavior[];
  patterns?: CASPattern[];
  /** Louvain functional modules (clustering of the call graph). Structural
   *  parity with codebase-memory's community detection; Klauro layers domain
   *  meaning on top. */
  communities?: CASCommunity[];
  /**
   * Reachability index over the directed call graph (SCC condensation +
   * pruned landmark labeling; see CASReachabilityIndex / analyzer/core/
   * reachability-index.ts). Built in the graph stage; consumers use it for
   * near-O(1) transitive reachability and affected-set queries instead of
   * per-query traversals, falling back to traversal when absent (older CAS).
   */
  reachability_index?: CASReachabilityIndex;
  /** Provenance of the per-node `structural_importance` scores (seed count,
   *  iterations, convergence). Deterministic layer — same CAS revision, same
   *  scores. Absent on CAS outputs produced before the layer existed. */
  structural_importance_meta?: CASStructuralImportanceMeta;
  categories?: CASCategories;
  tags?: CASTag[];
  index?: CASIndex;
  cross_repository_links?: CASCrossRepositoryLink[];
  security_contexts?: CASSecurityContext[];
  test_coverage?: CASTestCoverage;

  // v1.6.0+ Test structures
  test_suites?: CASTestSuite[];
  mocks?: CASMock[];
  fixtures?: CASFixture[];
  test_summary?: CASTestSummary;

  // v1.7.0+ Inference-Based Intelligence
  intents?: CASIntent[];
  flow_summary?: CASFlowSummary;
  change_risks?: CASChangeRisk[];
  change_risk_summary?: CASChangeRiskSummary;
  data_entities?: CASDataEntity[];
  data_summary?: CASDataSummary;
  behavioral_invariants?: CASBehavioralInvariant[];
  behavioral_invariant_summary?: CASBehavioralInvariantSummary;
  security_boundaries?: CASSecurityBoundary[];
  security_summary?: CASSecuritySummary;
  flow_coverage?: CASFlowCoverage[];
  test_gaps?: CASTestGap[];
  temporal_stability?: CASTemporalStability[];
  stability_summary?: CASStabilitySummary;
  system_capabilities?: SystemCapability[];
  /**
   * Navigation tier for behavior/registration surfaces (mcp_tool / rpc /
   * command / event / message-handler engines with no product-entity anchor
   * — see buildBehaviorCapabilities in orchestrator.ts). SURFACES ARE NOT
   * CAPABILITIES (docs/SEMANTIC-MODEL.md purpose test): a surface is
   * structurally excluded from system_capabilities/top_capabilities ranking,
   * always category:'internal', and criticality is capped at 'medium' so it
   * can never boost or outrank a domain capability's urgency. Still fully
   * navigable — each entry carries its own operations/entry-point evidence,
   * just as a SystemCapability does. A surface that genuinely overlaps a
   * real domain capability's entities is merged INTO that capability instead
   * of appearing here (mergeBehaviorCapabilityIntoExisting).
   */
  behavior_surfaces?: SystemCapability[];
  system_purpose?: SystemPurpose;

  workflows?: CASWorkflow[];
  workflow_graph?: CASWorkflowGraph;
  user_journeys?: CASUserJourney[];
  user_journey_summary?: CASUserJourneySummary;
  data_lineage?: CASEntityLineage[];
  domain_concepts?: CASDomainConcept[];
  enhanced_system_purpose?: EnhancedSystemPurpose;

  flow_graph?: CASFlowGraph;
  runtime_static_links?: CASRuntimeStaticLink[];
  analysis_facts?: CASAnalysisFact[];
  distribution_units?: CASDistributionUnit[];
  deployable_evidence?: DeployableEvidence[];

  // v1.9.0+ Codebase Idiom Intelligence
  codebase_idioms?: CASCodebaseIdiom[];
  idiom_summary?: CASIdiomSummary;
  idiom_examples?: CASIdiomExample[];
  idiom_violations?: CASIdiomViolation[];
  paradigm_conformance?: CASParadigmConformance[];
  architectural_conflicts?: CASArchitecturalConflict[];
  principle_violations?: CASPrincipleViolation[];
  /** File-level "dangerous to touch, and why" surface — size/churn/fan-in/
   *  mixed-concern outliers relative to this codebase's own distribution.
   *  See CASModuleHealth / analyzer/core/module-health.ts. Undefined when
   *  the analyzed file count is below the statistical-signal floor. */
  module_health?: CASModuleHealth;
  product_map?: CASProductMap;

  // v1.10.0+ Graph-Anchored Semantic Retrieval
  embedding_index?: CASEmbeddingIndex;

  /**
   * Codebase-TYPE classification (see analyzer/core/codebase-type.ts):
   * what KIND of thing this repo/root is (web-backend, library, cli, ...),
   * from deterministic manifest/entry-point/dependency evidence. Tells
   * downstream analysis what an "entry point" even means here (a library's
   * public surface is its exports, not routes).
   */
  codebase_type?: import('../analyzer/core/codebase-type').CodebaseType;
  codebase_type_confidence?: number;
  /** Every codebase TYPE with non-trivial evidence, ranked by confidence — a
   *  monorepo or hybrid root can legitimately carry more than one. */
  codebase_types?: Array<{ type: import('../analyzer/core/codebase-type').CodebaseType; confidence: number }>;
  codebase_type_signals?: import('../analyzer/core/codebase-type').CodebaseTypeSignal[];

  /**
   * Self-discovered coverage gaps recorded during this analysis (see
   * analyzer/core/coverage-gaps.ts): unknown dependencies matching no
   * analyzer, low node-extraction-ratio files, zero-entry-point roots, and
   * aggregate counts of tree-sitter node types no analyzer handled. This is
   * the mechanism that makes gap-closing systematic — "take note of new
   * things we haven't encountered, so we close gaps as discovered."
   */
  coverage_gaps?: CASCoverageGap[];

  /**
   * Audit trail for declared custom-architecture conventions (.klaurorc
   * `conventions:`, see analyzer/core/conventions-applier.ts): what each
   * declared convention matched or failed to match in the real extracted
   * nodes. Evidence-gated — a convention with `matched: false` emitted
   * nothing rather than fabricating a route/entity/flow. Absent when no
   * conventions are declared.
   */
  conventions_applied?: import('../analyzer/core/conventions-applier').ConventionMatchReport[];

  /**
   * Unified communication-seam classification (see
   * analyzer/core/communication-seams.ts): every seam between components —
   * exit points, messaging edges, and shared-state (passive) links — tagged
   * with a modality (sync | async | passive) + confidence + the driving fact,
   * plus a system-level inventory at node and deployable level. Derived
   * additively from exit/entry/messaging/data-lineage facts; never re-detects.
   */
  communication_seams?: import('../analyzer/core/communication-seams').CommunicationSeamsResult;

  /**
   * CONSISTENCY / CAP characterization + broadened PASSIVE seams. Tags data-store
   * egress and passive seams (read-replicas, streaming sinks, CDC, materialized
   * stores, ETL loads) with a consistency posture (strong | eventual | tunable,
   * staleness_risk, CP/AP lean, evidence) so staleness / eventual-consistency
   * risk is visible. Derived additively from external services, exit points,
   * config env vars, and data lineage; evidence-gated (never a guessed
   * consistency). See consistency-model.ts.
   */
  consistency_model?: import('../analyzer/core/consistency-model').ConsistencyModelResult;

  libraries?: CASLibrary[];

  /**
   * Full declared-dependency manifest (Camp-B structural FACT), extracted
   * repo-agnostically from every package.json / requirements*.txt / Cargo.toml /
   * go.mod / pyproject.toml under the project root. This is the COMPLETE list of
   * declared dependency names, not just the subset the framework/library
   * detectors recognize (`libraries` above). It is a fact bundle only — raw
   * names + which manifest declared them + the scope (runtime/dev/peer/optional).
   * No interpretation of what a dependency MEANS lives here; that is the AI
   * comprehension pass's job, which reads these facts as grounding. Absent when
   * no manifest files are found. See buildDependencyManifest() in orchestrator.ts.
   */
  dependency_manifest?: CASDependencyManifest;

  /**
   * Tier 2 GAP FIX (§6.3, "Library and dependency roles"): dependency_manifest
   * above is deliberately uninterpreted (raw names only — no meaning may live
   * there, see its own doc comment). This is the separate, additive Tier 2
   * field the spec identifies as missing: a role classification per declared
   * dependency (http-client, database-driver, orm, cache, message-broker,
   * observability, auth, ...), evidence-grounded and joinable back to
   * dependency_manifest by name. This is the concrete input the capability
   * builder was missing for the integrations-never-become-candidates defect.
   * Deterministic, Tier 1-only (reads exit_points + the library analyzers'
   * own known-package detection lists) — NOT an AI comprehension output, and
   * not present when dependency_manifest is absent. See dependency-roles.ts.
   */
  dependency_roles?: CASDependencyRole[];

  progressive_levels: CASProgressiveLevels;
  configuration?: CASConfiguration;
  runtime?: CASRuntime;
  analysis_errors?: CASAnalysisError[];
  validation?: CASValidation;

  /** Revision identity (stamped at runtime; see revision.ts / track.ts). */
  base_commit?: string;
  branch?: string;
  /** Which analysis track this output represents: 'main' | 'other-branch' | 'in-flight'. */
  analyzed_track?: 'main' | 'other-branch' | 'in-flight';
  /** True when this CAS was produced over only the files changed on a branch
   *  (a light diff-only payload), not the full source tree. */
  diff_only?: boolean;

  /**
   * Progressive AI availability marker for the (opt-in) deferred-enrichment path.
   * Absent on legacy/older stores. 'synchronous' = AI ran inline (default path).
   * 'pending' = deterministic analysis returned, AI enrichment still running in
   * the background. 'ready' = background AI enrichment applied. 'disabled' = AI
   * unavailable, no upgrade will arrive. 'error' = AI enrichment was dispatched
   * and failed — a visible terminal failure, never a silent stay-pending (no
   * deterministic substitute exists; comprehension is AI-only).
   */
  ai_enrichment?: 'pending' | 'ready' | 'disabled' | 'synchronous' | 'error';

  /** When ai_enrichment === 'error', the underlying failure reason, queryable via the API. Absent otherwise. */
  ai_enrichment_error?: string;

  /**
   * Progressive-layering manifest. Absent on legacy stores and the plain
   * synchronous analyzeProject() path, where every layer is implicitly ready.
   * A partial CAS (some layers 'pending') never fabricates facts for a layer
   * that hasn't landed; callers must treat missing/pending fields as "still
   * computing", not "absent from the codebase".
   */
  layers_ready?: CASLayersReady;

  /**
   * L0 fast index/inventory from a pure filesystem walk, computed before the
   * analyzer pipeline (L1-L4) runs. Present only on a layered-entrypoint CAS;
   * superseded by system.technologies once fuller L1+ facts land.
   */
  l0_index?: {
    total_files: number;
    languages: Array<{ name: string; files: number }>;
    top_level_dirs: string[];
    duration_ms: number;
  };
}

/** One entry in the layer ladder. `fields` lists the top-level CASOutput keys
 *  this layer is responsible for populating, for callers that want to check a
 *  specific field's provenance without re-deriving the ladder. */
export interface CASLayerStatus {
  layer: 'L0' | 'L1' | 'L2' | 'L3' | 'L4' | 'L5';
  name: string;
  /**
   * 'pending' = not landed yet; 'ready' = landed; 'error' = dispatched and
   * failed, reason in `error`. On L5 this means AI comprehension failed — must
   * never sit 'pending' forever, and has no deterministic substitute. On a
   * structural layer (L1..L4) it means the deterministic analysis itself
   * crashed. A failure must always be visible and terminal, never an infinite
   * "pending"/"populating" wait.
   */
  status: 'pending' | 'ready' | 'error';
  /** ISO timestamp this layer's status last changed, when known. */
  completed_at?: string;
  duration_ms?: number;
  /** When status === 'error', the failure reason surfaced to callers. */
  error?: string;
  fields: string[];
}

/**
 * L0 index/inventory -> L1 nodes/entry points/routes -> L2 call graph/edges ->
 * L3 entities/lineage/database schema -> L4 flows/capabilities/contracts ->
 * L5 AI enrichment. Ordered fast -> slow; each layer is additive — a later
 * layer never retracts an earlier one's facts.
 */
export interface CASLayersReady {
  layers: CASLayerStatus[];
  /** True once every layer in `layers` is 'ready' (L5 excluded when AI is
   *  disabled for this project, since no upgrade is ever coming). */
  complete: boolean;
  generated_at: string;
}

export interface CASEmbeddingIndex {
  model: string;
  provider: 'api' | 'local';
  dimensions: number;
  document_version: string;
  store: 'file' | 'pgvector';
  generated_at: string;
  node_count: number;
  coverage: {
    embedded: number;
    skipped: number;
    failed: number;
  };
  degraded?: boolean;
  degraded_reason?: string;
}

export type CASDistributionUnitKind =
  | 'desktop-app'
  | 'mobile-app'
  | 'server-bundle'
  | 'installer'
  | 'container-stack'
  | 'package'
  | 'deployment-unit';

export type CASDistributionEvidenceSource =
  | 'installer'
  | 'install-script'
  | 'release-script'
  | 'service-unit'
  | 'desktop-entry'
  | 'package-manifest'
  | 'container-topology'
  | 'ci'
  | 'inferred';

export interface CASDistributionEvidence {
  source: CASDistributionEvidenceSource;
  file?: string;
  line?: number;
  claim: string;
  confidence: number;
}

export interface CASDistributionUnit {
  id: string;
  name: string;
  kind: CASDistributionUnitKind;
  platforms: string[];
  component_names: string[];
  component_node_ids: string[];
  artifact_node_ids: string[];
  artifact_paths: string[];
  install_paths?: string[];
  evidence: CASDistributionEvidence[];
  confidence: number;
  agent_guidance?: string;
}

export interface CASPerspective {
  id: string;
  name: string;
  description: string;
  analyzer_id: string;
  type: 'flow' | 'structure' | 'deployment' | 'data' | 'security' | 'custom';
  connection_rules?: {
    node_connections?: Array<{
      from_type: string;
      to_types: string[];
      edge_type: string;
      conditions?: Record<string, any>;
    }>;
    visible_node_types?: string[];
    relevant_edge_types?: string[];
  };
  layout_hints?: {
    style: 'hierarchical' | 'force' | 'circular' | 'grid';
    direction?: 'TB' | 'LR' | 'BT' | 'RL';
    group_by?: string;
  };
  metadata?: Record<string, any>;
}

export interface CASNestedRepository {
  path: string;
  has_git_directory: boolean;
  primary_language?: string;
  source_files: number;
  note: string;
}

export interface CASSystem {
  id: string;
  name: string;
  description?: string;
  type: 'monorepo' | 'application' | 'library' | 'service' | 'package';
  root_path: string;
  repository?: {
    url?: string;
    branch?: string;
    commit?: string;
  };
  package_management?: {
    primary_manager?: string;
    lock_files?: string[];
    manifests?: string[];
  };
  technologies?: {
    languages?: Array<{
      name: string;
      version?: string;
      percentage?: number;
      files?: number;
    }>;
    unanalyzed_languages?: Array<{
      name: string;
      files: number;
      share_of_source: number;
    }>;
    nested_repositories?: CASNestedRepository[];
    frameworks?: Array<{
      name: string;
      version?: string;
      confidence?: number;
    }>;
    /**
     * Tier 2 GAP FIX (§6.2, "Framework identity and version"): `frameworks`
     * above is a bare name list with no version and no purpose. Each entry
     * here is the SAME detected framework, additionally carrying a declared
     * version (joined structurally against dependency_manifest — the same
     * package name recorded by a real manifest file) and a closed-vocabulary
     * role (§6.2 asks for "web, ORM, DI, test, build, queue, observability").
     * Role is derived from what the framework's OWN analyzer contribution
     * structurally produced — which ENTRY_POINT_TYPES / EXIT_POINT_TYPES its
     * nodes carry (`source_analyzer` join) — never from a brand/domain word
     * list. See framework-identity.ts. Additive: `frameworks` is unchanged
     * for backward compatibility.
     */
    framework_identities?: CASFrameworkIdentity[];
    runtime?: string;
    databases?: string[];
    infrastructure?: string[];
  };
  dependencies?: {
    direct_count?: number;
    total_count?: number;
    critical_vulnerabilities?: number;
    outdated_packages?: number;
    license_issues?: number;
  };
  quality?: {
    test_coverage?: number;
    code_quality_score?: number;
    documentation_coverage?: number;
    complexity_score?: number;
    maintainability_index?: number;
  };
  /**
   * Cheap repo-level facts (contributor count, first/last commit timestamps)
   * derived client-side from git metadata at snapshot-build time
   * (apps/mcp-server/src/remote-source.ts deriveRepoFacts) and stamped onto
   * the analysis server-side from the upload manifest (remote-analyzer-service.ts
   * handleAnalyze/handleSync). Additive and honest: absent whenever the
   * client could not derive it (not a git repo, no commits yet) rather than
   * a fabricated zero/empty value. analyzer-core does not itself compute
   * this — analyzer-core has no git access — it only carries the field
   * through the CAS shape. Powers the UI's Contributors / Codebase age
   * elements (codebase age = now - first_commit_at).
   */
  repo_facts?: {
    contributor_count?: number;
    first_commit_at?: string;
    last_commit_at?: string;
  };
  /**
   * Honest absence marker for `repo_facts` on builds where no client-derived
   * value was available to stamp — e.g. a server-side `/api/projects/:id/
   * reanalyze` or `/api/workspaces/:id/reanalyze` run against a stored
   * snapshot with no client `.git` in reach, and no prior push for this
   * project ever carried a manifest.repo_facts to fall back on. Set ONLY
   * when `repo_facts` itself is absent (never both) — this is "here is why
   * the field above is missing," never a substitute for a real value.
   */
  repo_facts_status?: {
    available: false;
    reason: string;
  };
  metadata?: Record<string, any>;
}

export interface CASNodePerspective {
  hierarchy: string[];
  level: number;
  priority: number;
  metadata?: Record<string, any>;
}

export interface CASNode {
  id: string;
  name: string;
  type: string;
  qualified_name?: string;
  category?: string;
  subcategories?: string[];
  perspectives?: Record<string, CASNodePerspective>;
  analyzers?: string[];
  primaryAnalyzer?: string;
  level?: number;
  level_name?: string;
  description?: string;
  description_source?: 'deterministic' | 'ai' | 'manual' | 'reused';
  description_generation?: CASDescriptionGeneration;
  tags?: string[];
  /**
   * Tier 2 GAP FIX (docs/SPEC-ABSTRACTION-TIERS.md tier 2, group 2:
   * "framework-conferred node roles"): a closed-vocabulary classification of
   * what CONVENTION this unit plays — see NODE_ROLES for the full set and
   * per-role rationale. Deterministic, assigned by analyzer/core/node-roles.ts
   * from tier-1 facts only (nodes/edges/entry_points/exit_points); never from
   * AI, never from the node's own name/casing. Absent means no role evidence
   * was found, not "role: none" — an honest gap, per the refusal-over-
   * fabrication rule that applies at every tier.
   */
  role?: CASNodeRole;
  /**
   * `framework-evidence` when a real ecosystem convention conferred the role
   * (a decorator, a base class/interface, an already-typed node from a
   * framework analyzer). `structural-evidence` when NO framework fired and
   * the role came from bare structural shape alone (a wrapping position in
   * the request chain, a directory+filename convention, an entry-point
   * grouping) — the framework-less path every role must have. Mirrors
   * CASDataEntityKind's `kind_source` precedent exactly.
   */
  role_source?: 'framework-evidence' | 'structural-evidence';
  /**
   * Citation for `role`: the actual decorator/interface/base-class/tag name,
   * or the structural fact (entry-point id + type, directory pattern,
   * wrapping-chain call name), that proves it. Mandatory whenever `role` is
   * set — an uncited role is the fabrication class this codebase purges.
   */
  role_evidence?: string;
  /** Structural importance — deterministic seeded random-walk centrality over
   *  the call graph, normalized [0,1] (1 = most important node in this CAS).
   *  Computed in the graph stage from structure only, NEVER AI-derived.
   *  See analyzer/core/structural-importance.ts. */
  structural_importance?: number;
  documentation?: CASDocumentation; // New in v1.4.0
  comments?: CASComment[]; // New in v1.4.0
  implementation_status?: CASImplementationStatus; // New in v1.4.0
  todos?: CASTodo[]; // New in v1.4.0
  call_graph?: CASCallGraph; // New in v1.3.0
  source?: {
    file?: string;
    line?: number;
    end_line?: number;
    column?: number;
    end_column?: number;
    raw?: string;
  };
  metadata?: {
    language?: string;
    framework?: string;
    paradigm?: string;
    access_modifier?: 'public' | 'private' | 'protected';
    is_abstract?: boolean;
    is_static?: boolean;
    is_async?: boolean;
    is_exported?: boolean;
    is_test?: boolean;
    is_generated?: boolean;
    complexity?: {
      cyclomatic?: number;
      cognitive?: number;
      halstead?: Record<string, number>;
    };
    metrics?: {
      lines_of_code?: number;
      lines_of_comments?: number;
      test_coverage?: number;
    };
    documentation?: string;
    annotations?: string[];
    attributes?: Record<string, any>;
    perspective_data?: Record<string, any>; // New in v1.2: perspective-specific metadata
  };
  signature?: {
    parameters?: Array<{
      name: string;
      type?: string;
      optional?: boolean;
      default_value?: string;
    }>;
    return_type?: string;
    type_parameters?: string[];
    throws?: string[];
  };
  implementation?: {
    body_hash?: string;
    uses?: string[];
    modifies?: string[];
    local_variables?: Array<{
      name: string;
      type?: string;
    }>;
    control_flow?: Record<string, any>;
  };
  runtime?: {
    performance_characteristics?: {
      typical_latency?: string;
      memory_usage?: string;
      cpu_intensive?: boolean;
      io_bound?: boolean;
    };
    scalability?: {
      stateless?: boolean;
      horizontally_scalable?: boolean;
      singleton?: boolean;
    };
  };
  security?: {
    authentication_required?: boolean;
    authorization_roles?: string[];
    data_sensitivity?: string;
    encryption?: string;
    protected?: boolean;
    public?: boolean;
  };
  testing?: {
    tested_by?: string[];
    test_type?: string;
    coverage_percentage?: number;
    assertions?: number;
  };
  configuration?: {
    environment_variables?: string[];
    config_files?: string[];
    feature_flags?: string[];
    required_services?: string[];
  };
  children?: string[];
  parent?: string;
}

export interface CASEdge {
  id: string;
  source: string;
  target: string;
  type: string;
  perspectives?: string[]; // New in v1.2: perspectives this edge is relevant to
  category?: string;
  metadata?: {
    weight?: number;
    confidence?: number;
    occurrences?: number;
    bidirectional?: boolean;
    transitive?: boolean;
    async?: boolean;
    conditional?: boolean;
    locations?: Array<{
      file?: string;
      line?: number;
      context?: string;
    }>;
    attributes?: Record<string, any>;
    perspective_data?: Record<string, any>; // New in v1.2: perspective-specific metadata
  };
}

/**
 * Single source of truth for the kinds of entry point the analyzers may emit.
 *
 * The `CASEntryPoint['type']` union below is DERIVED from this array
 * (`type: typeof ENTRY_POINT_TYPES[number]`), and the orchestrator's
 * `isValidEntryPoint` validator MUST check membership in this same array.
 * That keeps the union and the runtime allowlist from ever drifting: add a new
 * kind here and both the type and the validator pick it up automatically. See
 * the entry-point parity guard test in analyzer-core's __tests__.
 */
export const ENTRY_POINT_TYPES = [
  'http', 'websocket', 'cli', 'event', 'schedule', 'page', 'route',
  'message', 'file', 'test', 'lifecycle', 'api',
  // data/ML pipeline entry-point kinds: an orchestration task/asset node (Airflow/Dagster/Prefect/Luigi),
  // a pipeline-level entry (the DAG/flow/job itself), a single ordered notebook code cell, or an ML
  // training-loop entry point (train()/fit() call, or the script that drives it).
  'task', 'pipeline', 'notebook-cell', 'train',
  // embedded/systems entry-point kinds: a hardware/timer interrupt service routine (ISR),
  // and a kernel/driver hook (module_init/module_exit, file_operations fops, ioctl handler).
  'interrupt', 'driver',
  // desktop-app entry-point kinds: an Electron IPC main-process handler
  // (ipcMain.handle/.on) invoked from the renderer, and a Tauri Rust command
  // (#[tauri::command]) invoked from the frontend via invoke().
  'ipc', 'command',
  // non-REST API entry-point kind: a gRPC/RPC server-side method handler
  // (grpc-js addService impl, NestJS @GrpcMethod, Python grpcio Servicer) —
  // a method dispatch, not an HTTP path, so it reads distinctly from REST routes.
  'rpc',
  // non-REST API entry-point kind: a GraphQL root operation (a Query/Mutation/
  // Subscription field, or a field resolver on an object type). Callers address it
  // by OPERATION NAME over a single transport endpoint, not by path+verb, so it is
  // not a route: lumping it in with routes made an entire protocol surface
  // unaskable ("what are the GraphQL entry points?" returned nothing filterable).
  'graphql',
] as const;

export type CASEntryPointType = typeof ENTRY_POINT_TYPES[number];

export interface CASEntryPoint {
  id: string;
  source_node: string;
  source_analyzer?: string;
  type: CASEntryPointType;
  name: string;
  description?: string;
  description_source?: 'deterministic' | 'ai' | 'manual' | 'reused';
  description_generation?: CASDescriptionGeneration;
  trigger?: {
    method?: string;
    path?: string;
    pattern?: string;
    event?: string;
    schedule?: string;
    parameters?: Array<{
      name: string;
      type: string;
      required: boolean;
      location?: string;
    }>;
  };
  handler?: {
    node_id: string;
    method_name: string;
    file?: string;
    line?: number;
  };
  input?: {
    type?: string;
    schema?: string;
    validation?: string[];
    example?: any;
    // entry-point-enrichment.ts (flow-contract join): structured inputs derived
    // from the entry point's flow ICELOT contract when not otherwise set.
    fields?: Array<{ name?: string; type: string }>;
    is_positional_only?: boolean;
  };
  output?: {
    type?: string;
    schema?: string;
    status_codes?: number[];
    // entry-point-enrichment.ts: is_named_type marks a return that is a
    // class/interface/type (its `type` is the bare name, linkable to a
    // definition elsewhere); is_void marks a no-value return.
    is_named_type?: boolean;
    is_void?: boolean;
  };
  security?: {
    authenticated?: boolean;
    authorized_roles?: string[];
    guards?: string[];
    roles?: string[];
    permissions?: string[];
    rate_limit?: string;
    redirect_if_unauthorized?: string;
    // entry-point-security.ts: confidence of the security-boundary/context join —
    // 'enforced' when a matching enforcement point was itself 'enforced', else
    // 'assumed'. Absent = no security evidence was joined (do NOT read as public).
    enforcement?: 'enforced' | 'assumed';
  };
  // entry-point-enrichment.ts (capability join): the capabilities this entry
  // point serves, via its flow. Many-to-many with a per-tie role — an entry
  // point may serve zero, one, or many capabilities (cross-cutting like auth).
  capabilities?: Array<{ capability_id: string; capability_name: string; role: string }>;
  // entry-point-enrichment.ts: reachable from outside the deployable ('external')
  // or only internally ('internal'); 'unknown' when there is no signal.
  interaction_reach?: 'external' | 'internal' | 'unknown';
  // entry-point-deployable.ts: the deployable this entry point belongs to
  // (longest-path-prefix match of its file against deployable_evidence roots).
  deployable_id?: string;
  deployable_name?: string;
  connected_nodes?: string[];
  metadata?: Record<string, any>;
}

/**
 * Single source of truth for the kinds of exit point analyzers may emit.
 * CASExitPoint['type'] is derived from this array, and the orchestrator's
 * isValidExitPoint validator must check membership in this same array — a
 * separate hardcoded allowlist WILL drift. Add a new kind here only; see the
 * exit-point parity guard test in analyzer-core's __tests__.
 */
export const EXIT_POINT_TYPES = [
  'database', 'api', 'file', 'message', 'event', 'cache', 'sdk',
  'webhook', 'navigation', 'client_storage', 'analytics',
] as const;

export type CASExitPointType = typeof EXIT_POINT_TYPES[number];

/**
 * Single source of truth for tier-2 framework-conferred NODE ROLES (docs/
 * SPEC-ABSTRACTION-TIERS.md, tier 2, group 2: "the meaning a convention
 * assigns to a unit"). Mirrors the ENTRY_POINT_TYPES / EXIT_POINT_TYPES
 * pattern exactly: `CASNode['role']` below is DERIVED from this array, and
 * any validator that checks role membership MUST check this same array —
 * see analyzer/core/node-roles.ts, which is the only writer of `CASNode.role`.
 *
 * `route-handler` and `persisted-entity` are deliberately NOT in this list —
 * they already have a home (CASEntryPoint['type'] and CASDataEntityKind
 * respectively) and duplicating them here would give one concept two fields
 * that can disagree. This vocabulary covers the roles that had NO field at
 * all before this pass: the largest remaining tier-2 gap.
 *
 * Every role must be reachable two ways — from a framework's own convention
 * (a decorator, a base class, an interface) AND from bare structural
 * evidence with no framework present (a wrapping position in a request
 * chain, a directory+filename convention, a grouping shape) — see
 * node-roles.ts `role_source` for which path fired. A role assigned without
 * a framework signal is not a downgrade; `structural-evidence` is an honest
 * label for the framework-less path, exactly like CASDataEntityKind's
 * `shape-inference` vs `framework-evidence` precedent.
 */
export const NODE_ROLES = [
  // Groups >=2 route/API entry points under one owning unit (class, struct,
  // or file) — the concept `@Controller` and a Go file full of
  // `http.HandleFunc` registrations both structurally satisfy.
  'controller',
  // Sits in the request chain BEFORE a handler runs, wrapping/forwarding
  // rather than terminating the request. Not auth-classified (see `guard`).
  'middleware',
  // A middleware/interceptor whose classified purpose is authentication or
  // authorization (see CASGuardKind) — the request-chain position of
  // `middleware`, narrowed by what it actually protects.
  'guard',
  // A boundary unit that receives external traffic and forwards it onward
  // to another surface (a websocket gateway, an API-gateway route) rather
  // than terminating it in the unit's own business logic.
  'gateway',
  // The handler of a schema-backed dispatch (GraphQL field resolver) — a
  // dispatch mechanism distinct from a path+verb route.
  'resolver',
  // A schema-change artefact — identified by directory convention (a
  // `migrations`-shaped path) plus its operations (a DDL/schema-change
  // shape), never by name alone.
  'migration',
  // The handler of a timer/cron registration (CASEntryPoint type
  // `schedule`) rather than an inbound request.
  'scheduled-job',
  // The handler of an event-subscription registration (CASEntryPoint type
  // `event`) rather than an inbound request.
  'event-listener',
] as const;

export type CASNodeRole = typeof NODE_ROLES[number];

export interface CASExitPoint {
  id: string;
  source_node: string;
  source_analyzer?: string;
  type: CASExitPointType;
  name: string;
  description?: string;
  description_source?: 'deterministic' | 'ai' | 'manual' | 'reused';
  description_generation?: CASDescriptionGeneration;
  target?: {
    service_id?: string;
    endpoint?: string;
    resource?: string;
    sdk?: string;
  };
  operation?: {
    action?: string;
    method?: string;
    async?: boolean;
  };
  data?: {
    input_type?: string;
    output_type?: string;
    transformation_node?: string;
  };
  reliability?: {
    retry_attempts?: number;
    timeout_ms?: number;
    circuit_breaker?: boolean;
  };
  connected_nodes?: string[];
  metadata?: Record<string, any>;
}

export interface CASBehavior {
  id: string;
  name: string;
  description?: string;
  nodes?: string[];
  flow?: Array<{
    from: string;
    to: string;
    action: string;
  }>;
  metadata?: Record<string, any>;
}

export interface CASPatternVariation {
  id: string;
  implementation: string;
  description: string;
  instances: string[];
  percentage: number;
  characteristics?: Record<string, any>;
}

export interface CASPatternDeviation {
  type: 'inconsistent-adoption' | 'partial-implementation' | 'anti-pattern' | 'obsolete-usage' | 'mixed-styles';
  severity: 'info' | 'warning' | 'error';
  description: string;
  affected_instances: string[];
  recommendation?: string;
}

/** A Louvain functional module: a cluster of tightly call-connected nodes. */
export interface CASCommunity {
  id: number;
  member_ids: string[];
  size: number;
  internal_edges: number;
}

/**
 * Persisted reachability index over the directed call graph (Workstream C,
 * docs/SPEC-MATHEMATICAL-INTELLIGENCE.md): Tarjan SCC condensation + pruned
 * 2-hop landmark labeling, built at analysis time by
 * analyzer/core/reachability-index.ts and rehydrated with
 * `ReachabilityIndex.from()` for near-O(1) "can A reach B" and O(answer)
 * affected-set queries. Contains ONLY graph-shape facts (no timestamps) —
 * byte-stable across identical runs. Only nodes incident to at least one
 * call edge participate (node absent from `node_ids` = reaches only itself),
 * keeping the stored size proportional to the call graph, not the CAS.
 * All *_offsets/* arrays are CSR (compressed sparse row) form: entries for
 * component c live at positions [offsets[c], offsets[c+1]).
 */
export interface CASReachabilityIndex {
  version: 1;
  /**
   * Content-coverage marker, NOT a format version (the CSR shape above is
   * unchanged and still `version: 1`): true when this index's closure was
   * built over 'calls' + resolved method_calls + 'invokes' edges
   * (reachabilityEdgePairs, task #100); absent/false on analyses stored
   * BEFORE that fix, whose closure covered 'calls' + method_calls only.
   * Every consumer that can either rehydrate this persisted index OR fall
   * back to rebuilding its own (query.ts's getAffectedSet,
   * deployable-analysis.ts's sub-CAS-node slice) MUST gate reuse on this flag being
   * true — trusting presence alone would silently hand a stale, narrower
   * closure to a caller that used to get the wider (invokes-inclusive) one
   * from a from-scratch rebuild, on any analysis stored before this field
   * existed.
   */
  includes_invokes_edges?: boolean;
  /** Sorted node ids; array position = compact node index. */
  node_ids: string[];
  /** comp_of[i] = SCC component of node_ids[i] (components canonically
   *  numbered by minimum member index). */
  comp_of: number[];
  comp_count: number;
  /** Condensation DAG (caller->callee direction), CSR, deduped, sorted. */
  comp_adj_offsets: number[];
  comp_adj_targets: number[];
  /** 2-hop labels: canReach(a,b) = same comp OR label_out(comp a) intersects
   *  label_in(comp b). Entries sorted ascending per component. */
  label_out_offsets: number[];
  label_out: number[];
  label_in_offsets: number[];
  label_in: number[];
  stats: {
    nodes: number;
    edges: number;
    comps: number;
    largest_scc: number;
    label_entries: number;
  };
}

/** Provenance block for the per-node structural-importance scores. Contains
 *  only run-shape facts (never timestamps/durations) so serialization stays
 *  byte-stable across identical runs. */
export interface CASStructuralImportanceMeta {
  algorithm: 'seeded-random-walk-power-iteration';
  damping: number;
  epsilon: number;
  max_iterations: number;
  iterations: number;
  converged: boolean;
  /** Number of seed nodes the walk restarts at — non-test entry-point nodes
   *  (mandatory filtering: most entry points on test-heavy repos are tests). */
  seed_count: number;
  seed_source: 'entry-points' | 'uniform';
  node_count: number;
  edge_count: number;
}

export interface CASPattern {
  id: string;
  type?: 'design-pattern' | 'architectural-pattern' | 'anti-pattern';
  name: string;
  description?: string;
  confidence: number;
  instances: string[];
  variations?: CASPatternVariation[];
  deviations?: CASPatternDeviation[];
  metadata?: {
    framework_specific?: boolean;
    language_specific?: boolean;
    benefits?: string[];
    drawbacks?: string[];
  };
}

export type CASIdiomCategory =
  | 'naming'
  | 'file-organization'
  | 'module-boundary'
  | 'dependency-injection'
  | 'data-access'
  | 'error-handling'
  | 'validation'
  | 'auth-tenant-scope'
  | 'logging'
  | 'testing'
  | 'migrations'
  | 'async-style'
  | 'configuration';

export interface CASIdiomScope {
  languages?: string[];
  frameworks?: string[];
  node_types?: string[];
  file_globs?: string[];
  node_ids?: string[];
  files?: string[];
}

export interface CASIdiomEvidence {
  kind: 'node' | 'edge' | 'file' | 'import' | 'decorator' | 'test' | 'migration' | 'invariant' | 'pattern' | 'analysis-fact';
  file?: string;
  line?: number;
  node_id?: string;
  edge_id?: string;
  fact_id?: string;
  claim: string;
  confidence: number;
}

export interface CASIdiomExample {
  id: string;
  idiom_id: string;
  file: string;
  line?: number;
  node_id?: string;
  name?: string;
  excerpt?: string;
  explanation: string;
}

export interface CASIdiomViolation {
  id: string;
  idiom_id: string;
  category: CASIdiomCategory;
  severity: 'info' | 'warning' | 'error';
  file?: string;
  line?: number;
  node_id?: string;
  description: string;
  recommendation: string;
  evidence?: CASIdiomEvidence[];
}

export interface CASCodebaseIdiom {
  id: string;
  category: CASIdiomCategory;
  name: string;
  description: string;
  confidence: number;
  prevalence: number;
  evidence: CASIdiomEvidence[];
  positive_examples: CASIdiomExample[];
  affected_scopes: CASIdiomScope;
  agent_guidance: {
    do: string[];
    avoid: string[];
    validation: string[];
  };
  deviations?: CASIdiomViolation[];
  provenance?: {
    evidence_files: number;
    evidence_nodes: number;
    population: number;
    matching: number;
    derivation: string;
  };
}

export interface CASIdiomSummary {
  total: number;
  high_confidence: number;
  violations: number;
  by_category: Record<CASIdiomCategory, number>;
  top_idioms: string[];
  guidance_digest: string[];
}

export type CASParadigmDeviationKind =
  | 'direct-data-access'
  | 'layer-skipping-call'
  | 'unguarded-entry-point'
  | 'parallel-implementation';

export interface CASParadigmDeviation {
  file: string;
  node_id: string;
  kind: CASParadigmDeviationKind;
  detail: string;
  severity: 'info' | 'warning' | 'error';
}

/** A concern (responsibility) handled by two different structural patterns in
 *  different places in the codebase — the architectural-conflict/overlap
 *  signal behind get_architectural_conflicts. Grounded in the same deviation
 *  evidence as paradigm_conformance and the pattern-instance variations. */
export interface CASArchitecturalConflict {
  id: string;
  kind: 'pattern-conflict' | 'pattern-overlap';
  concern: string;
  competing: Array<{
    label: string;
    files: string[];
    share: number;
  }>;
  severity: 'low' | 'medium' | 'high';
  evidence: string[];
  suggested_alignment: string;
}

/** An engineering-principle break (layering, single-responsibility, coupling)
 *  grounded in structural evidence — deterministic detection, no AI judgment
 *  baked in. */
export interface CASPrincipleViolation {
  id: string;
  principle: 'layering' | 'single-responsibility' | 'coupling';
  file: string;
  node_id: string;
  detail: string;
  severity: 'info' | 'warning' | 'error';
}

/**
 * Module Health — Tier 2 "which parts of this system are dangerous to touch,
 * and why" (SPEC-ABSTRACTION-TIERS.md §4, architecture-adherence health).
 * Composed entirely from facts computed elsewhere (node spans, temporal
 * stability/churn, the edge graph, capability anchors); see
 * analyzer/core/module-health.ts for the derivation. Every finding is a
 * statistical outlier RELATIVE to this codebase's own file distribution
 * (median + MAD modified z-score) — never a fixed line-count/churn/fan-in
 * threshold. A tidy codebase with no outliers reports an empty `findings`
 * array, not manufactured filler.
 */
export interface CASModuleHealthFileStat {
  file: string;
  lines: number;
  node_count: number;
  fan_in: number;
  commits_90d: number;
  capability_anchor_count: number;
}

export interface CASModuleHealthFinding {
  id: string;
  file: string;
  kind: 'size-outlier' | 'change-concentration' | 'fan-in-hotspot' | 'mixed-concerns' | 'danger-composite';
  /** The raw metric value that triggered this finding (lines / commits_90d /
   *  fan_in / capability count / composite danger score, per `kind`). */
  metric_value: number;
  /** Modified z-score (Iglewicz & Hoaglin): 0.6745 * (x - median) / scale. */
  robust_z: number;
  comparison: { median: number; scale: number; sample_size: number };
  severity: 'info' | 'warning' | 'error';
  detail: string;
  evidence: string[];
}

export interface CASModuleHealth {
  /** Human-readable statement of the statistical method, for provenance —
   *  so a consumer never has to guess how a threshold was chosen. */
  method: string;
  files_analyzed: number;
  total_lines: number;
  total_commits_90d: number;
  concentration: {
    size_outlier_file_count: number;
    /** Fraction (0..1) of total codebase lines living in size-outlier files. */
    size_outlier_share_of_lines: number;
    churn_outlier_file_count: number;
    /** Fraction (0..1) of total 90-day commits absorbed by churn-outlier files. */
    churn_outlier_share_of_commits: number;
  };
  findings: CASModuleHealthFinding[];
  /** Per-file raw stats (size-sorted, capped) for consumers that want the
   *  distribution itself rather than just the flagged outliers. */
  file_stats: CASModuleHealthFileStat[];
}

export interface CASParadigmConformance {
  paradigm: string;
  description: string;
  adoption: {
    following_count: number;
    comparable_count: number;
    adoption_rate: number;
    evidence_files: string[];
  };
  deviations: CASParadigmDeviation[];
}

export interface CASProductMapCapability {
  name: string;
  description: string;
  description_source: 'deterministic' | 'ai' | 'manual' | 'reused';
  category: 'core' | 'supporting' | 'admin' | 'internal';
  criticality: 'critical' | 'high' | 'medium' | 'low';
  journeys: Array<{ id: string; name: string }>;
  entities: string[];
  tests_present: boolean;
  risk_level: 'low' | 'medium' | 'high';
}

export interface CASProductMapJourney {
  id: string;
  name: string;
  kind: 'user-facing' | 'system' | 'scheduled';
  criticality: 'critical' | 'high' | 'medium' | 'low';
  boundaries: string[];
  tests: number;
}

export interface CASProductMap {
  identity: {
    name: string;
    domain: string;
    /** Human-readable rendering of `domain` (kebab-case slug -> Title Case
     *  words) for a leadership/onboarding reader — see product-map.ts's
     *  humanizeDomainSlug. Purely mechanical, never a synonym/fabrication;
     *  `domain` itself stays the stable machine-comparable slug. Omitted
     *  when there is no domain to humanize. */
    domain_label?: string;
    // Comprehension provenance is AI-only (docs/cas/DETERMINISM-BOUNDARY.md).
    // Left UNSET until AI runs — never coerced to 'deterministic' on empty
    // output. ('deterministic' remains in the union only for legacy/reused rows.)
    domain_source?: 'deterministic' | 'ai' | 'ai-refined' | 'reused';
    description: string;
    description_source?: 'deterministic' | 'ai' | 'manual' | 'reused';
    unanalyzed_languages: Array<{ name: string; files: number; share_of_source: number }>;
    nested_repositories?: CASNestedRepository[];
  };
  capabilities: CASProductMapCapability[];
  journeys: {
    total: number;
    user_facing: number;
    system: number;
    scheduled: number;
    top: CASProductMapJourney[];
  };
  data: {
    entities: number;
    sensitive: string[];
    exposure_highlights: Array<{
      entity: string;
      sensitive_fields: string[];
      unguarded_paths: number;
      non_auth_guarded_paths?: number;
      external_transfer: boolean;
      external_recipients: string[];
    }>;
  };
  conventions: {
    paradigms: Array<{
      paradigm: string;
      description: string;
      adoption_rate: number;
      following_count: number;
      comparable_count: number;
    }>;
    open_deviations: { error: number; warning: number; info: number };
  };
  health: {
    status?: 'healthy' | 'watch' | 'at-risk' | 'critical';
    score?: number;
    tests: { total: number; passing: number; failing: number; coverage_percentage?: number };
    implementation: {
      complete: number;
      partial: number;
      stubs: number;
      not_implemented: number;
      deprecated: number;
      health_score?: number;
    };
    top_risks: Array<{ name: string; level: 'low' | 'medium' | 'high'; type: string; recommendation: string }>;
  };
  /**
   * Runtime topology — the infra->code join produced by infra-topology-linker.ts,
   * surfaced per deployable so get_product_map describes the RUNNING system, not
   * just the source tree. Purely additive and evidence-based: present only when
   * the analysis actually carries infra topology edges (DEPLOYS, EXPOSES,
   * ROUTES_TO, PROVISIONS_CHANNEL/DATABASE/STORAGE, RUNTIME_DEPENDS_ON). Absent
   * for repos with no infra-as-code, so non-infra consumers are unchanged.
   */
  runtime_topology?: CASProductMapRuntimeTopology;
  coverage_caveats: string[];
}

export interface CASProductMapRuntimeTopology {
  /** Total infra->code topology edges backing the per-deployable buckets below. */
  edge_count: number;
  /** One entry per deployable that participates in at least one topology edge. */
  deployables: CASProductMapDeployableTopology[];
  /**
   * The deployable-to-deployable communication graph, drawn deterministically
   * from the communication-seams pass (Camp-B structural facts). Each edge is a
   * real seam between two components with its per-modality counts, so the
   * topology surfaces HOW deployables talk (sync/async/passive) and how much,
   * not just the sparse infra RUNTIME_DEPENDS_ON links. Present only when the
   * analysis carried a deployable-level seam inventory.
   */
  communication?: CASProductMapCommunicationGraph;
}

export interface CASProductMapCommunicationGraph {
  /** Total classified seams underlying this graph, by modality. */
  counts: { sync: number; async: number; passive: number; total: number };
  /** Component-to-component edges (deployable-to-deployable, or to an external
   *  target like `external_api`/an SDK), each with its dominant modality and
   *  per-modality seam counts. Sorted by total seams descending. */
  edges: CASProductMapCommunicationEdge[];
}

export interface CASProductMapCommunicationEdge {
  /** Component that initiates / writes (a deployable name, module, or repo). */
  source: string;
  /** Component that serves / reads, or the external target. */
  target: string;
  /** Distinct modalities carried on this edge. */
  modalities: ('sync' | 'async' | 'passive')[];
  sync: number;
  async: number;
  passive: number;
  total: number;
}

export interface CASProductMapDeployableTopology {
  /** Deployable name (from the DEPLOYS/EXPOSES edge attributes). */
  name: string;
  /** Container images / build contexts that ship this deployable (DEPLOYS). */
  deploys: string[];
  /** Ports/services fronting this deployable (EXPOSES), e.g. 'port:8080' or a service name. */
  exposes: string[];
  /** HTTP routes served by this deployable's front-ends (ROUTES_TO). */
  routes: string[];
  /** Messaging channels this deployable provisions/uses at runtime (PROVISIONS_CHANNEL). */
  channels: string[];
  /** Databases/data entities this deployable provisions (PROVISIONS_DATABASE). */
  databases: string[];
  /** Buckets/tables/functions/stores this deployable provisions (PROVISIONS_STORAGE). */
  storage: string[];
  /** Peer deployables this one depends on at runtime (RUNTIME_DEPENDS_ON). */
  depends_on: string[];
}

export interface CASCategories {
  [level: string]: {
    [category: string]: {
      name?: string;
      types?: string[];
      common_patterns?: string[];
      parent_categories?: string[];
      description?: string;
      frameworks?: string[];
      languages?: string[];
      parent_types?: string[];
    };
  };
}

export interface CASTag {
  name: string;
  category?: string;
  nodes?: string[];
  color?: string;
  metadata?: Record<string, any>;
}

export interface CASIndex {
  by_type?: Record<string, string[]>;
  by_name?: Record<string, string[]>;
  by_perspective?: Record<string, string[]>;
  entry_points?: string[];
  exit_points?: string[];
  external_services?: string[];
  [key: string]: any;
}

export interface CASExternalService {
  id: string;
  name: string;
  type: string;
  purpose?: 'consumption' | 'production' | 'bidirectional';
  description?: string;
  endpoint?: string;
  provider?: string;
  usage_pattern?: {
    frequency?: string;
    criticality?: string;
    operations?: string[];
  };
  connected_nodes?: string[];
  entry_points?: string[];
  exit_points?: string[];
  configuration?: Record<string, any>;
  monitoring?: {
    health_check?: string;
    metrics?: string[];
  };
  cost?: {
    model?: string;
    estimated_monthly?: string;
  };
}

export interface CASCrossRepositoryLink {
  id: string;
  type: 'api' | 'library' | 'shared-schema' | 'message-contract' | 'shared-database';
  source_repository?: {
    url?: string;
    node_ids?: string[];
    path?: string;
  };
  target_repository?: {
    url?: string;
    node_ids?: string[];
    path?: string;
  };
  connection?: {
    protocol?: string;
    endpoint?: string;
    method?: string;
    contract?: string;
    package_name?: string;
    version?: string;
    broker?: string;
    exchange?: string;
    routing_key?: string;
    message_schema?: string;
  };
  metadata?: {
    verified?: boolean;
    last_sync?: string;
    breaking_changes?: boolean;
    confidence?: number;
    evidence?: CASFactEvidence[];
  };
}

export interface CASFactEvidence {
  kind: 'source-location' | 'analyzer' | 'configuration' | 'dependency' | 'route' | 'runtime-signal' | 'naming' | 'graph';
  source: string;
  file?: string;
  line?: number;
  excerpt?: string;
  confidence: number;
}

export interface CASAnalysisFact {
  id: string;
  subject_type: 'node' | 'edge' | 'entry_point' | 'exit_point' | 'external_service' | 'workflow' | 'capability' | 'runtime_link' | 'repository_link';
  subject_id: string;
  fact_type: 'definition' | 'relationship' | 'entry' | 'exit' | 'workflow' | 'capability' | 'runtime-correlation' | 'cross-repository';
  claim: string;
  confidence: number;
  produced_by: string;
  evidence: CASFactEvidence[];
}

export interface CASRuntimeStaticLink {
  id: string;
  kind: 'entry-point' | 'exit-point' | 'call-chain' | 'external-service' | 'telemetry-hook';
  static_id: string;
  runtime_signal: string;
  telemetry_status: 'observed' | 'instrumentable' | 'not-instrumented';
  confidence: number;
  instrumentation_points: string[];
  evidence: CASFactEvidence[];
}

export interface CASSecurityContext {
  id: string;
  name: string;
  type?: 'authorization' | 'authentication' | 'encryption';
  scope?: {
    node_ids?: string[];
    entry_points?: string[];
    paths?: string[];
  };
  requirements?: {
    authentication?: {
      required?: boolean;
      methods?: string[];
      multi_factor?: boolean;
    };
    authorization?: {
      roles?: string[];
      permissions?: string[];
      policy?: string;
    };
    data_protection?: {
      encryption_at_rest?: boolean;
      encryption_in_transit?: boolean;
      pii_handling?: string;
      audit_logging?: boolean;
    };
  };
  compliance?: {
    standards?: string[];
    data_residency?: string;
    retention_policy?: string;
  };
  threats?: {
    owasp_top_10?: string[];
    mitigations?: string[];
  };

  // v1.7.0 Per-Node Security Context additions
  node_id?: string;
  trust_level?: 'untrusted' | 'partially-trusted' | 'trusted';
  security_relevant?: boolean;
  security_relevance_reason?: string;
  required_protections?: string[];
  actual_protections?: string[];
  protection_gaps?: string[];
}

export interface CASTestCoverage {
  summary?: {
    total_coverage?: number;
    lines_covered?: number;
    lines_total?: number;
    branches_covered?: number;
    branches_total?: number;
    functions_covered?: number;
    functions_total?: number;
  };
  by_level?: Record<string, {
    coverage?: number;
    test_count?: number;
    assertion_count?: number;
  }>;
  by_component?: Record<string, {
    coverage?: number;
    untested_nodes?: string[];
  }>;
  test_relationships?: Array<{
    test_id?: string;
    tested_nodes?: string[];
    test_type?: string;
    assertions?: number;
    coverage_contribution?: number;
  }>;
}

/**
 * A structured, self-discovered coverage gap — a concrete thing this analysis
 * pass encountered but does not (yet) understand. See analyzer/core/coverage-gaps.ts
 * for the collection logic and rationale.
 */
export type CASCoverageGapKind =
  | 'unknown-dependency'
  | 'low-extraction-ratio'
  | 'zero-entry-points'
  | 'unhandled-node-type';

export interface CASCoverageGap {
  kind: CASCoverageGapKind;
  /** Short human-readable statement of the gap. */
  evidence: string;
  file?: string;
  severity: 'low' | 'medium' | 'high';
  /** Machine-stable key for aggregation across repos (e.g. the dep name, the
   *  node-type string, or the codebase_type for zero-entry-point gaps). */
  key?: string;
  /** Extra structured detail specific to `kind` (counts, ratios, etc). */
  detail?: Record<string, unknown>;
}

export interface CASLibrary {
  id: string;
  name: string;
  version?: string;
  type?: 'production' | 'development' | 'peer' | 'optional';
  category?: string;
  package_manager?: string;
  description?: string;
  usage_patterns?: Array<{
    pattern?: string;
    occurrences?: number;
    example_nodes?: string[];
    functions_used?: string[];
  }>;
  size?: {
    bundle_size?: string;
    gzipped_size?: string;
    tree_shakeable?: boolean;
  };
  security?: {
    vulnerabilities?: number;
    last_audit?: string;
    license?: string;
    license_compatible?: boolean;
  };
  usage_statistics?: {
    import_count?: number;
    usage_frequency?: string;
    critical_path?: boolean;
    performance_impact?: string;
  };
  related_libraries?: string[];
  alternative_libraries?: string[];
  migration_complexity?: string;
  connected_nodes?: string[];
  optimization_opportunities?: Array<{
    type?: string;
    potential_savings?: string;
    recommendation?: string;
  }>;
  replacement_feasibility?: {
    native_alternatives?: number;
    smaller_alternatives?: string[];
    effort_estimate?: string;
  };
  metadata?: {
    installation_date?: string;
    last_updated?: string;
    auto_updatable?: boolean;
    breaking_changes_risk?: string;
  };
}

/**
 * Full declared-dependency manifest — a Camp-B structural FACT (see
 * CASOutput.dependency_manifest). Every declared dependency name across every
 * manifest file in the repo, with the manifest that declared it and the scope.
 * Raw facts only: no meaning, category, or interpretation is attached here.
 */
export interface CASDependencyManifest {
  /** Manifest files scanned, project-relative (e.g. "package.json",
   *  "blockchains/package.json", "requirements.txt"), sorted. */
  manifests: string[];
  /** Deduped dependency names across all manifests, sorted, each with the
   *  ecosystem, declaring manifest(s), scope(s), and declared version range
   *  when the manifest records one. */
  dependencies: CASDeclaredDependency[];
  /** Count of distinct dependency names (== dependencies.length; convenience). */
  total: number;
}

/**
 * Closed vocabulary for what PURPOSE a detected framework serves (Tier 2
 * §6.2 GAP). Deliberately small and structural: each value corresponds to a
 * distinguishable pattern in what the framework's own contribution produced
 * (entry/exit point kinds, decorator semantic categories) — never a per-
 * framework-name lookup. 'other' is the honest fallback when no structural
 * signal fires, rather than a guess.
 */
export const FRAMEWORK_ROLES = [
  'web', 'orm', 'di', 'test', 'build', 'queue', 'observability', 'other',
] as const;
export type CASFrameworkRole = typeof FRAMEWORK_ROLES[number];

export interface CASFrameworkIdentity {
  /** Framework display name, as already carried by technologies.frameworks. */
  name: string;
  /** Declared version, when a dependency_manifest entry's name matched this
   *  framework (npm/pypi/maven/gradle/cargo/go/nuget/composer/pub). Absent
   *  when no manifest join was possible (e.g. no manifest file found). */
  version?: string;
  /** Ecosystem the version join came from, when version is present. */
  ecosystem?: CASDeclaredDependency['ecosystem'];
  role: CASFrameworkRole;
  /** 0-1: how much of the role signal was structural vs. absent. 1.0 means
   *  every entry/exit point produced by this framework's contribution agreed
   *  on one role; lower means a mixed or thin signal. */
  role_confidence: number;
  /** Human-readable citation of the structural signal used, e.g. "produced
   *  entry points of type http,route (analyzer: express)" or "no framework
   *  analyzer contribution matched; role left as 'other'". */
  role_evidence: string;
}

/**
 * Closed vocabulary for what a third-party dependency DOES (Tier 2 §6.3
 * GAP — the missing input behind the integrations-as-capabilities defect).
 * Intentionally small; 'other'/'unknown' are honest fallbacks, never
 * omitted in favor of a guess.
 */
export const DEPENDENCY_ROLE_KINDS = [
  'http-client', 'database-driver', 'orm', 'cache', 'message-broker',
  'observability', 'auth', 'realtime', 'graphql-client', 'workflow',
  'other',
] as const;
export type CASDependencyRoleKind = typeof DEPENDENCY_ROLE_KINDS[number];

export interface CASDependencyRole {
  /** Matches CASDeclaredDependency.name exactly. */
  name: string;
  ecosystem: CASDeclaredDependency['ecosystem'];
  role: CASDependencyRoleKind;
  /** 0-1 confidence. Exit-point-grounded evidence (this exact dependency
   *  produced a typed call-shaped exit point) scores higher than a
   *  known-package-list match with no call evidence found in this repo. */
  confidence: number;
  /** Citations: exit point ids and/or which library analyzer's own
   *  detection list matched this package name — never a bare assertion. */
  evidence: string[];
  source: 'exit-point-evidence' | 'known-package-list';
}

export interface CASDeclaredDependency {
  /** Raw package name exactly as declared (e.g. "ccxt", "web3",
   *  "@solana/web3.js", "requests"). No normalization of meaning. */
  name: string;
  /** Package ecosystem the declaring manifest belongs to. */
  ecosystem: 'npm' | 'pypi' | 'cargo' | 'go' | 'maven' | 'gradle' | 'nuget' | 'composer' | 'pub' | 'unknown';
  /** Declared version / range when the manifest records one (npm/cargo/pypi). */
  version?: string;
  /** Dependency scope(s) this name was declared under, across manifests. */
  scopes: Array<'runtime' | 'dev' | 'peer' | 'optional' | 'build'>;
  /** Manifest file(s) that declared this dependency, project-relative, sorted. */
  declared_in: string[];
}

export interface CASAnalyzerContribution {
  analyzer_id: string;
  analyzer_name: string;
  analyzer_version?: string;
  analyzer_type?: 'language' | 'framework' | 'library' | 'pattern';
  version?: string;
  contribution_type: 'language' | 'framework' | 'library' | 'pattern';
  confidence?: number;
  depends_on?: string[];
  nodes_created?: number;
  edges_created?: number;
  /** Distinct source files (by node.source.file) that produced this contribution's nodes. Not an AST-node count. */
  files_created?: number;
  nodes_contributed?: number;
  edges_contributed?: number;
  capabilities?: string[];
  analysis_scope?: {
    files_analyzed?: number;
    files_skipped?: number;
    patterns_detected?: string[];
  };
  contributed_categories?: string[];
  contributed_entry_points?: number;
  contributed_exit_points?: number;
  execution_time?: string;
  execution_time_ms?: number;
  cache_status?: 'disabled' | 'hit' | 'miss' | 'invalidated' | 'coalesced';
  memory_usage?: string;
  provided_perspectives?: string[];
  errors?: string[];
  warnings?: string[];
  framework_specific?: Record<string, any>;
  library_specific?: Record<string, any>;
  application_type?: string;
  project_name?: string;
  project_version?: string;
  frameworks_detected?: Record<string, boolean>;
  crates?: Record<string, Record<string, boolean>>;
}

export interface CASProgressiveLevels {
  total_levels: number;
  level_definitions?: Array<{
    level: number;
    name?: string;
    description?: string;
    node_count?: number;
    recommended_for?: string[];
    example_nodes?: string[];
    time_to_understand?: string;
    contains?: {
      categories?: string[];
      entry_points?: string;
      exit_points?: string;
      key_connections?: string;
    };
  }>;
  query_patterns?: {
    level_specific?: {
      description?: string;
      example?: string;
      use_case?: string;
    };
    level_range?: {
      description?: string;
      example?: string;
      use_case?: string;
    };
    discover_levels?: {
      description?: string;
      example?: string;
      response?: string;
    };
    category_with_level?: {
      description?: string;
      example?: string;
      use_case?: string;
    };
    children_progressive?: {
      description?: string;
      example?: string;
      use_case?: string;
    };
  };
  consumer_recommendations?: {
    mcp_servers?: {
      initial_load?: string;
      on_demand?: string;
      benefit?: string;
      adaptive?: string;
    };
    ui_visualization?: {
      overview_mode?: string;
      detail_mode?: string;
      debug_mode?: string;
      benefit?: string;
    };
    documentation_tools?: {
      architecture_docs?: string;
      api_docs?: string;
      implementation_docs?: string;
      benefit?: string;
    };
  };
  level_strategy?: {
    flexible_depth?: string;
    minimum_levels?: number;
    maximum_levels?: string;
    common_range?: string;
    examples?: Record<string, string>;
  };
}

export interface CASConfiguration {
  environment_variables?: Array<{
    name: string;
    required?: boolean;
    default?: any;
    description?: string;
    used_by?: string[];
    sensitive?: boolean;
  }>;
  config_files?: Array<{
    path?: string;
    format?: string;
    environment_specific?: boolean;
    schema?: string;
  }>;
  feature_flags?: Array<{
    name?: string;
    enabled?: boolean;
    rollout_percentage?: number;
    affected_nodes?: string[];
  }>;
  required_services?: Array<{
    service?: string;
    version?: string;
    optional?: boolean;
  }>;
}

export interface CASRuntime {
  deployment?: {
    type?: string;
    orchestration?: string;
    scaling?: {
      min_instances?: number;
      max_instances?: number;
      auto_scaling?: boolean;
      scaling_metric?: string;
    };
  };
  performance?: {
    startup_time?: string;
    memory_baseline?: string;
    memory_peak?: string;
    cpu_baseline?: string;
    cpu_peak?: string;
    concurrent_requests?: number;
    request_duration_p50?: string;
    request_duration_p95?: string;
    request_duration_p99?: string;
  };
  dependencies?: {
    runtime?: string;
    system_libraries?: string[];
    external_services?: string[];
  };
  monitoring?: {
    health_check?: string;
    readiness_check?: string;
    metrics_endpoint?: string;
    logging?: {
      level?: string;
      format?: string;
      destinations?: string[];
    };
  };
  instrumentation?: {
    instrumentable_entry_points: string[];
    instrumentable_exit_points: string[];
    observed_call_chains: string[];
    missing_runtime_coverage: string[];
  };
}

export interface CASAnalysisError {
  severity: 'error' | 'warning' | 'info';
  code: string;
  message: string;
  file?: string;
  line?: number;
  analyzer?: string;
  recoverable?: boolean;
  suggestion?: string;
}

export interface CASValidation {
  schema_version?: string;
  schema_url?: string;
  validation_errors?: string[];
  validation_warnings?: Array<{
    path?: string;
    message?: string;
  }>;
  completeness?: {
    nodes_with_location?: number;
    edges_with_metadata?: number;
    documented_nodes?: number;
  };
  graph_integrity?: {
    total_edges: number;
    dangling_edges: number;
    duplicate_ids?: {
      nodes: number;
      edges: number;
      entry_points: number;
      exit_points: number;
    };
    connected_nodes: number;
    orphaned_nodes: number;
    entry_points_with_handlers: number;
    exit_points_with_sources: number;
    runtime_links_with_instrumentation: number;
    facts_with_evidence: number;
    relationship_coverage_score: number;
  };
}

export interface CASAnalyzer {
  getAnalyzerName(): string;
  getSupportedLanguages(): string[];
  getSupportedFrameworks(): string[];
  analyze(projectPath: string): Promise<CASContribution>;
  enhance?(existingAnalysis: CASOutput, projectPath: string): Promise<CASContribution>;
}

export interface CASContribution {
  nodes?: CASNode[];
  edges?: CASEdge[];
  entry_points?: CASEntryPoint[];
  exit_points?: CASExitPoint[];
  behaviors?: CASBehavior[];
  patterns?: CASPattern[];
  libraries?: CASLibrary[];
  external_services?: CASExternalService[];
  test_coverage?: CASTestCoverage;
  analyzer_metadata: CASAnalyzerContribution;
  categories?: Partial<CASCategories>;
  tags?: CASTag[];
  perspectives?: CASPerspective[];
  provided_perspectives?: string[];
  method_calls?: CASMethodCall[];
  call_chains?: CASCallChain[];
}

export interface CASMergeStrategy {
  nodeConflictResolution: 'merge' | 'replace' | 'keep-both';
  edgeConflictResolution: 'merge' | 'replace' | 'keep-both';
  metadataConflictResolution: 'merge' | 'replace' | 'prefer-specialized';
  priority: string[];
}

export class CASNodeBuilder {
  private node: Partial<CASNode> = {};

  constructor(id: string, name: string, type: string) {
    this.node = { id, name, type };
  }

  withLevel(level: number, levelName?: string): this {
    this.node.level = level;
    if (levelName) this.node.level_name = levelName;
    return this;
  }

  withCategory(category: string, subcategories?: string[]): this {
    this.node.category = category;
    if (subcategories) this.node.subcategories = subcategories;
    return this;
  }

  withSource(source: Partial<CASNode['source']>): this {
    this.node.source = { ...this.node.source, ...source };
    return this;
  }

  withMetadata(metadata: Partial<CASNode['metadata']>): this {
    this.node.metadata = { ...this.node.metadata, ...metadata };
    return this;
  }

  withParentChild(parent?: string, children?: string[]): this {
    if (parent) this.node.parent = parent;
    if (children) this.node.children = children;
    return this;
  }

  withParent(parent?: string): this {
    if (parent) this.node.parent = parent;
    return this;
  }

  withDescription(description: string): this {
    this.node.description = description;
    return this;
  }

  withTags(tags: string[]): this {
    this.node.tags = tags;
    return this;
  }

  withSignature(signature: Partial<CASNode['signature']>): this {
    this.node.signature = { ...this.node.signature, ...signature };
    return this;
  }

  withDocumentation(documentation?: CASDocumentation): this {
    if (documentation) this.node.documentation = documentation;
    return this;
  }

  withComments(comments?: CASComment[]): this {
    if (comments) this.node.comments = comments;
    return this;
  }

  withTodos(todos?: CASTodo[]): this {
    if (todos) this.node.todos = todos;
    return this;
  }

  withImplementationStatus(status?: CASImplementationStatus): this {
    if (status) this.node.implementation_status = status;
    return this;
  }

  withAnalyzers(analyzers: string[], primaryAnalyzer?: string): this {
    this.node.analyzers = analyzers;
    if (primaryAnalyzer) {
      this.node.primaryAnalyzer = primaryAnalyzer;
    } else if (analyzers.length > 0) {
      this.node.primaryAnalyzer = analyzers[0];
    }
    return this;
  }

  withPerspective(perspectiveId: string, perspective: CASNodePerspective): this {
    if (!this.node.perspectives) {
      this.node.perspectives = {};
    }
    this.node.perspectives[perspectiveId] = perspective;
    return this;
  }

  build(): CASNode {
    if (!this.node.id || !this.node.name || !this.node.type) {
      throw new Error('CAS node must have id, name, and type');
    }
    return this.node as CASNode;
  }
}

export class CASEdgeBuilder {
  private edge: Partial<CASEdge> = {};

  constructor(id: string, source: string, target: string, type: string) {
    this.edge = { id, source, target, type };
  }

  withCategory(category: string): this {
    this.edge.category = category;
    return this;
  }

  withMetadata(metadata: Partial<CASEdge['metadata']>): this {
    this.edge.metadata = { ...this.edge.metadata, ...metadata };
    return this;
  }

  build(): CASEdge {
    if (!this.edge.id || !this.edge.source || !this.edge.target || !this.edge.type) {
      throw new Error('CAS edge must have id, source, target, and type');
    }
    return this.edge as CASEdge;
  }
}

export function generateNodeId(type: string, filePath: string, name: string): string {
  const normalizedPath = filePath
    .replace(/[^a-zA-Z0-9]/g, '_')
    .toLowerCase()
    .substring(0, 50);

  const normalizedName = name
    .replace(/[^a-zA-Z0-9_]/g, '_')
    .substring(0, 50);

  const crypto = require('crypto');
  const hash = crypto
    .createHash('sha256')
    .update(filePath + name)
    .digest('hex')
    .substring(0, 8);

  return `${type}_${normalizedPath}_${normalizedName}_${hash}`;
}

export function generateEdgeId(source: string, target: string, type: string): string {
  const crypto = require('crypto');
  const hash = crypto
    .createHash('sha256')
    .update(source + target + type)
    .digest('hex')
    .substring(0, 8);

  return `edge_${type}_${hash}`;
}

export interface CASDocumentation {
  id?: string;
  format?: 'jsdoc' | 'javadoc' | 'xml_doc' | 'docstring' | 'rustdoc' | 'godoc' | 'phpdoc' | 'typedoc' | 'other';
  type?: 'jsdoc' | 'javadoc' | 'xmldoc' | 'docstring' | 'rustdoc' | 'godoc' | 'phpdoc' | 'typedoc' | 'other' | 'django_docstring' | 'express_documentation' | 'fastapi_documentation' | 'flask_documentation' | 'laravel_documentation' | 'spring_boot_documentation';
  raw: string;
  summary?: string;
  description?: string;
  parameters?: Array<{
    name: string;
    type?: string;
    description?: string;
    optional?: boolean;
    default_value?: string;
  }>;
  returns?: {
    type?: string;
    description?: string;
  };
  return_info?: {
    type?: string;
    description?: string;
  };
  throws?: Array<{
    type?: string;
    description?: string;
  }>;
  exceptions?: Array<{
    type?: string;
    description?: string;
  }>;
  examples?: Array<{
    title?: string;
    code: string;
    language?: string;
  }>;
  tags?: Array<{
    tag: string;
    value: string;
    metadata?: Record<string, any>;
  }>;
  remarks?: string;
  framework_docs?: {
    swagger?: {
      summary?: string;
      description?: string;
      tags?: string[];
      operation_id?: string;
    };
    graphql?: {
      description?: string;
      deprecated?: boolean;
      deprecation_reason?: string;
    };
    django?: {
      view_type?: string;
      template?: string;
      form_class?: string;
      model?: string;
      field_help_texts?: Record<string, any>;
    };
    express?: {
      middleware?: string[];
      route_params?: string[];
      query_params?: string[];
      routes?: Record<string, any>;
    };
    fastapi?: {
      path_operation_id?: string;
      dependencies?: string[];
      status_code?: number;
      response_model?: string;
      field_descriptions?: Record<string, any>;
    };
    flask?: {
      route?: string;
      methods?: string[];
      endpoint?: string;
      decorators?: string[];
    };
    laravel?: {
      route_name?: string;
      middleware?: string[];
      controller?: string;
      action?: string;
    };
    spring_boot?: {
      mapping?: string;
      method?: string;
      params?: string[];
      consumes?: string[];
      produces?: string[];
    };
  };
  location: {
    start_line: number;
    end_line: number;
  };
}

export interface CASComment {
  id: string;
  type: 'single-line' | 'multi-line' | 'inline' | 'block' | 'docstring' | 'blade-comment';
  style: '//' | '#' | '--' | '/* */' | '<!-- -->' | 'other' | '"""' | '{{-- --}}';
  text: string;
  purpose?: 'explanation' | 'todo' | 'warning' | 'note' | 'hack' | 'clarification' | 'disabled-code' | 'other';
  location: {
    file: string;
    line: number;
    end_line?: number;
    column?: number;
    relative_to?: 'above' | 'inline' | 'below';
  };
  context?: {
    preceding_code?: string;
    following_code?: string;
    scope?: string;
    scope_id?: string;
  };
  markers?: {
    is_todo?: boolean;
    is_fixme?: boolean;
    is_hack?: boolean;
    is_warning?: boolean;
    is_note?: boolean;
    is_question?: boolean;
    is_important?: boolean;
    is_deprecated?: boolean;
    custom_markers?: string[];
  };
}

export interface CASTodo {
  id: string;
  type: 'TODO' | 'FIXME' | 'HACK' | 'NOTE' | 'WARNING' | 'XXX' | 'OPTIMIZE' | 'REFACTOR';
  text: string;
  priority?: 'low' | 'medium' | 'high' | 'critical';
  assignee?: string;
  created_date?: string;
  due_date?: string;
  category?: 'bug' | 'feature' | 'refactor' | 'performance' | 'security' | 'documentation' | 'test' | 'general';
  location: {
    file: string;
    line: number;
    node_id?: string;
    context?: string;
  };
  context?: {
    function_name?: string;
    class_name?: string;
    estimated_effort?: string;
    related_issue?: string;
  };
  classification?: {
    category?: 'bug' | 'feature' | 'refactor' | 'performance' | 'security' | 'documentation' | 'test' | 'general';
    technical_debt?: boolean;
    blocking?: boolean;
  };
  metadata?: Record<string, any>;
}

export interface CASImplementationStatus {
  status: 'complete' | 'partial' | 'stub' | 'not-implemented' | 'deprecated' | 'experimental';
  indicators: {
    has_todo_markers: boolean;
    has_not_implemented_exceptions: boolean;
    has_stub_returns: boolean;
    has_placeholder_code: boolean;
    has_hardcoded_values: boolean;
    has_commented_out_code: boolean;
    // Angular-specific indicators
    has_placeholder_template?: boolean;
    has_empty_methods?: boolean;
    has_console_logs?: boolean;
    has_mock_data?: boolean;
    has_deprecated_markers?: boolean;
  } | string[];
  confidence?: number;
  completeness?: {
    estimated_percentage?: number;
    missing_features?: string[];
    implemented_features?: string[];
  };
  deprecation?: {
    is_deprecated: boolean;
    deprecated_since?: string;
    removal_version?: string;
    replacement?: string;
    migration_guide?: string;
  };
  experimental?: {
    is_experimental: boolean;
    stability_level?: 'unstable' | 'experimental' | 'beta' | 'stable';
    expected_stable_version?: string;
  };
}

// v1.5.0 Method Call Structure
export interface CASMethodCall {
  id: string;
  caller_node: string;
  target_node?: string;
  call_details: {
    method_name: string;
    signature?: string;
    location: {
      file: string;
      line: number;
      column: number;
    };
    call_type: 'direct' | 'method' | 'constructor' | 'abstract' | 'interface' | 'callback' | 'hook' | 'dynamic';
    resolution_type: 'static' | 'dynamic' | 'polymorphic' | 'external' | 'unresolved';
  };
  execution_context: {
    is_async: boolean;
    is_conditional: boolean;
    is_in_loop: boolean;
    is_recursive: boolean;
    call_depth: number;
    conditional_depth: number;
    loop_depth: number;
    enclosing_function?: string;
    enclosing_class?: string;
  };
  arguments?: Array<{
    position: number;
    type?: string;
    value?: string;
    is_literal: boolean;
    is_variable: boolean;
  }>;
  external_details?: {
    library: string;
    module?: string;
    is_builtin: boolean;
    is_sdk: boolean;
    exit_point_id?: string;
  };
  framework_semantics?: {
    framework: string;
    decorator_type?: string;
    semantic_meaning?: string;
    route_info?: {
      method: string;
      path: string;
      parameters?: string[];
    };
  };
  performance_hints: {
    is_hot_path: boolean;
    is_potential_bottleneck: boolean;
    estimated_frequency?: number;
    is_critical_path?: boolean;
  };
  metadata?: Record<string, any>;
}

export interface CASCallChain {
  id: string;
  chain_type: 'entry-to-exit' | 'circular' | 'recursive' | 'dead-end' | 'hot-path' | 'critical-path';
  entry_point: {
    node_id: string;
    method_name: string;
    entry_point_id?: string;
  };
  exit_point?: {
    node_id?: string;
    method_name: string;
    exit_point_id?: string;
  };
  call_path: Array<{
    call_id: string;
    node_id: string;
    method_name: string;
    depth: number;
    execution_branch?: string;
  }>;
  characteristics: {
    total_calls: number;
    max_depth: number;
    has_external_calls: boolean;
    has_database_calls: boolean;
    has_async_calls: boolean;
    is_circular: boolean;
    is_recursive: boolean;
    complexity_score: number;
  };
  business_context?: {
    user_action?: string;
    business_process?: string;
    feature_area?: string;
  };
  risk_analysis: {
    risk_level: 'low' | 'medium' | 'high' | 'critical';
    risk_factors: string[];
    bottlenecks?: Array<{
      node_id: string;
      method_name: string;
      reason: string;
      impact: 'low' | 'medium' | 'high';
    }>;
  };

  // v1.7.0 Enhancements
  criticality?: 'critical' | 'high' | 'medium' | 'low';
  criticality_factors?: string[];
  runtime_stats?: {
    traffic_volume: 'very-high' | 'high' | 'medium' | 'low';
    avg_latency_ms?: number;
    error_rate_percent?: number;
    last_observed?: string;
  };
  test_coverage?: {
    covered: boolean;
    coverage_percentage?: number;
    test_ids?: string[];
    gaps?: string[];
  };

  metadata?: Record<string, any>;
}

// Legacy support - keep for backward compatibility
export interface CASCallGraph {
  calls?: Array<{
    target_id: string;
    target_name: string;
    target_type: 'function' | 'method' | 'constructor' | 'api' | 'external';
    call_type: 'direct' | 'async' | 'callback' | 'event' | 'delegate';
    location: {
      line: number;
      column?: number;
    };
    arguments?: Array<{
      type?: string;
      value?: any;
      is_literal?: boolean;
    }>;
    is_recursive?: boolean;
    in_loop?: boolean;
    in_try_catch?: boolean;
    condition?: string;
  }>;
  called_by?: Array<{
    source_id: string;
    source_name: string;
    source_type: string;
    location: {
      file: string;
      line: number;
    };
  }>;
  call_chain_depth?: number;
  is_entry_point?: boolean;
  is_exit_point?: boolean;
  is_hot_path?: boolean;
  total_calls_made?: number;
  total_calls_received?: number;
  decorators?: Array<{
    name: string;
    type: string;
    arguments?: Record<string, any>;
    provides?: string[];
  }>;
  async_context?: {
    is_async: boolean;
    is_generator: boolean;
    is_observable: boolean;
    returns_promise: boolean;
    await_count?: number;
    parallel_operations?: boolean;
  };
}

export interface CASArchitectureSummary {
  system_type: string;
  total_files: number;
  total_lines?: number;
  architectural_patterns?: CASArchitecturalPatternSummary[];
  architectural_inventory?: CASArchitecturalInventory;
  pattern_balance?: CASPatternBalance;
  layers: {
    presentation?: {
      controllers?: number;
      guards?: number;
      middleware?: number;
      endpoints?: number;
      components?: number;
      pages?: number;
    };
    business?: {
      services?: number;
      providers?: number;
      use_cases?: number;
      handlers?: number;
    };
    data?: {
      repositories?: number;
      entities?: number;
      migrations?: number;
      models?: number;
    };
    infrastructure?: {
      modules?: number;
      configs?: number;
      utilities?: number;
    };
  };
  api_surface?: {
    total_endpoints: number;
    by_auth: {
      authenticated: number;
      public: number;
    };
    by_method: Record<string, number>;
  };
  external_dependencies?: {
    databases?: Array<{
      type: string;
      via?: string;
      entities?: number;
    }>;
    caches?: Array<{
      type: string;
      used_for?: string[];
    }>;
    ai_services?: Array<{
      name: string;
      models?: string[];
    }>;
    external_apis?: Array<{
      name: string;
      purpose?: string;
    }>;
  };
  security?: {
    auth_strategy?: string;
    protected_endpoints?: number;
    oauth_providers?: string[];
    guards?: string[];
  };
}

export interface CASArchitecturalPatternSummary {
  name: string;
  category: 'application-architecture' | 'presentation' | 'business-logic' | 'data-access' | 'integration' | 'object-lifecycle' | 'anti-pattern';
  confidence: number;
  evidence: string[];
  node_ids: string[];
  guidance: string;
}

export interface CASArchitecturalInventory {
  models: string[];
  views: string[];
  controllers: string[];
  view_models: string[];
  services: string[];
  repositories: string[];
  clients: string[];
  mediators: string[];
  unit_of_work: string[];
  singletons: string[];
  scripts: string[];
  packages: string[];
}

export interface CASPatternBalance {
  status: 'balanced' | 'under-patterned' | 'over-patterned' | 'mixed';
  detected_count: number;
  primary_patterns?: string[];
  conflicting_patterns?: string[];
  rationale?: string;
  risks: string[];
  recommendations: string[];
}

export interface CASSystemHealth {
  score: number;
  status: 'healthy' | 'watch' | 'at-risk' | 'critical';
  summary: string;
  risk_areas: CASSystemHealthRiskArea[];
  coherence: {
    status: 'coherent' | 'mixed' | 'drifting' | 'fragmented';
    paradigm_count: number;
    primary_paradigms: string[];
    conflicting_paradigms: string[];
    naming_convention_violations: number;
    dependency_injection_violations: number;
    module_boundary_violations: number;
    duplication_signals: number;
  };
  remediation: {
    immediate: string[];
    agent_rules: string[];
    validation_tools: string[];
  };
}

export interface CASSystemHealthRiskArea {
  id: string;
  type:
    | 'complexity'
    | 'duplication'
    | 'paradigm-drift'
    | 'naming-drift'
    | 'dependency-injection-drift'
    | 'module-boundary-drift'
    | 'implementation-gap'
    | 'test-gap'
    | 'runtime-coverage-gap'
    | 'pattern-balance';
  severity: 'low' | 'medium' | 'high' | 'critical';
  title: string;
  description: string;
  affected_files?: string[];
  affected_nodes?: string[];
  evidence: string[];
  recommendation: string;
  agent_guidance: string;
}

export interface CASRouteTableEntry {
  method: string;
  path: string;
  controller: string;
  handler: string;
  auth: boolean;
  guards?: string[];
  middleware?: string[];
  source_node?: string;
  description?: string;
}

export interface CASDatabaseSchema {
  orm?: string;
  entities: CASDatabaseEntity[];
  relationships_summary: string[];
}

export interface CASDatabaseEntity {
  name: string;
  table?: string;
  source_file?: string;
  fields: CASDatabaseField[];
  relationships: CASDatabaseRelationship[];
}

export interface CASDatabaseField {
  name: string;
  type: string;
  primary?: boolean;
  unique?: boolean;
  nullable?: boolean;
  default?: string;
  column?: string;
}

export interface CASDatabaseRelationship {
  type: 'OneToOne' | 'OneToMany' | 'ManyToOne' | 'ManyToMany';
  target: string;
  field: string;
  inverse_field?: string;
  join_table?: string;
}

export interface CASDecorator {
  id: string;
  target_node: string;

  decorator_info: {
    name: string;
    type: 'method' | 'class' | 'property' | 'parameter';
    framework: string;
    source_location: {
      file: string;
      line: number;
      column: number;
    };
  };

  semantic_meaning: {
    category: 'routing' | 'validation' | 'security' | 'lifecycle' | 'injection' | 'configuration' | 'other';
    behavior: string;
    affects_runtime: boolean;
  };

  parameters?: Array<{
    name: string;
    value: any;
    type: string;
  }>;

  routing_info?: {
    method: string;
    path: string;
    parameters: string[];
    guards?: string[];
    middleware?: string[];
  };

  security_info?: {
    authentication_required: boolean;
    roles?: string[];
    permissions?: string[];
  };

  metadata?: Record<string, any>;
}

export interface Dependencies {
  manager: string;
  lock_file?: string;
  packages: Array<{
    name: string;
    version: string;
    direct: boolean;
    license?: string;
    repository?: string;
    vulnerabilities?: string[];
  }>;
}

export interface DisclosureHints {
  default_perspective?: string;
  important_nodes?: string[];
  suggested_paths?: Array<{
    name: string;
    description?: string;
    nodes: string[];
  }>;
  summaries?: Array<{
    level: number;
    node_count: number;
    perspective: string;
    description?: string;
  }>;
}

export interface CASDocumentationSummary {
  total_documented_nodes: number;
  documentation_coverage: number;

  by_type: {
    functions: { documented: number; total: number; coverage: number };
    classes: { documented: number; total: number; coverage: number };
    interfaces: { documented: number; total: number; coverage: number };
    modules: { documented: number; total: number; coverage: number };
  };

  by_documentation_type: Record<string, number>;

  quality_metrics: {
    average_description_length: number;
    parameters_documented: number;
    returns_documented: number;
    examples_provided: number;
    deprecated_items: number;
  };

  missing_documentation: Array<{
    node_id: string;
    node_name: string;
    node_type: string;
    importance: 'low' | 'medium' | 'high';
    reason: string;
  }>;
}

export interface CASTodoSummary {
  total_todos: number;
  total_fixmes: number;
  total_hacks: number;
  total_warnings: number;

  by_priority: {
    critical: number;
    high: number;
    medium: number;
    low: number;
  };

  by_category: Record<string, number>;

  technical_debt_items: number;
  blocking_items: number;

  hotspots: Array<{
    file: string;
    todo_count: number;
    types: string[];
  }>;

  age_analysis?: {
    old_todos: Array<{
      id: string;
      age_days?: number;
      text: string;
    }>;
  };
}

export interface CASImplementationHealth {
  complete_implementations: number;
  partial_implementations: number;
  stubs: number;
  not_implemented: number;
  deprecated: number;
  experimental: number;

  health_score: number;

  risk_areas: Array<{
    node_id: string;
    node_name: string;
    risk_type: 'incomplete' | 'deprecated' | 'unstable' | 'high-todo-density';
    risk_level: 'low' | 'medium' | 'high';
    recommendation: string;
  }>;

  deprecation_timeline?: Array<{
    node_id: string;
    node_name: string;
    deprecated_since: string;
    removal_version?: string;
  }>;
}

// v1.6.0 Test Structures

export interface TestMetadata {
  test_type: 'unit' | 'integration' | 'e2e' | 'acceptance' | 'performance' | 'visual' | 'smoke' | 'bdd';
  test_style: 'procedural' | 'bdd' | 'property-based' | 'snapshot' | 'parameterized';
  priority?: 'critical' | 'high' | 'medium' | 'low';
  tags?: string[];
  uses_mocks: boolean;
  is_async: boolean;
  timeout_ms?: number;
  framework: string;

  bdd_context?: {
    feature?: string;
    scenario?: string;
    given?: string[];
    when?: string[];
    then?: string[];
  };

  parameterization?: {
    data_source: 'inline' | 'fixture' | 'external';
    parameter_count: number;
    cases: number;
  };
}

export interface CASTestSuite {
  id: string;
  name: string;
  file_path: string;
  test_type: 'unit' | 'integration' | 'e2e' | 'acceptance';
  framework: string;

  tests: CASTestCase[];
  hooks?: CASTestHook[];
  fixtures?: string[];
  mocks?: string[];

  coverage?: {
    nodes_tested: string[];
    coverage_percentage?: number;
  };

  metadata?: {
    parallel?: boolean;
    timeout_ms?: number;
    retries?: number;
    skip_reason?: string;
  };
}

export interface CASTestCase {
  id: string;
  name: string;
  description?: string;
  test_type: 'unit' | 'integration' | 'e2e' | 'acceptance' | 'bdd';

  assertions?: CASAssertion[];
  mocks_used?: string[];
  targets?: string[];

  bdd_steps?: Array<{
    type: 'given' | 'when' | 'then' | 'and' | 'but';
    text: string;
    implementation_id?: string;
  }>;

  parameterized?: {
    parameters: Array<{ name: string; values: any[] }>;
    case_count: number;
  };

  status: {
    skipped: boolean;
    focused: boolean;
    flaky: boolean;
  };

  source?: {
    file: string;
    line: number;
    end_line?: number;
  };
}

export interface CASTestHook {
  id: string;
  type: 'beforeAll' | 'afterAll' | 'beforeEach' | 'afterEach' | 'setup' | 'teardown';
  name?: string;
  source?: {
    file: string;
    line: number;
  };
}

export interface CASAssertion {
  id: string;
  type: 'equality' | 'truthiness' | 'exception' | 'mock-call' | 'snapshot' | 'type-check' | 'custom';
  description?: string;
  target?: string;
  expected_value?: string;
  source?: {
    file: string;
    line: number;
  };
}

export interface CASMock {
  id: string;
  name: string;
  type: 'mock' | 'stub' | 'spy' | 'fake';
  target_node?: string;
  framework: string;

  implementation?: {
    return_value?: string;
    implementation_fn?: string;
    call_tracking: boolean;
  };

  used_by?: string[];
}

export interface CASFixture {
  id: string;
  name: string;
  type: 'factory' | 'fixture' | 'builder' | 'seed-data';
  file_path: string;

  generates?: string;
  dependencies?: string[];
  used_by?: string[];
}

export interface CASNodeTestCoverage {
  covered: boolean;
  coverage_percentage?: number;
  tested_by?: string[];
  untested_branches?: Array<{
    line: number;
    condition: string;
  }>;
}

export interface CASTestSummary {
  total_tests: number;
  by_type: {
    unit: number;
    integration: number;
    e2e: number;
    acceptance: number;
    bdd: number;
    other: number;
  };
  by_status: {
    passing: number;
    failing: number;
    skipped: number;
    flaky: number;
  };
  coverage: {
    status?: 'measured' | 'not-measured';
    overall_percentage?: number;
    by_layer?: Record<string, number>;
  };
  mocks: {
    total: number;
    by_target_type?: Record<string, number>;
  };
  fixtures: {
    total: number;
    factories?: number;
    seed_data?: number;
  };
}

// v1.7.0 Intent Inference

export interface CASIntent {
  node_id: string;
  inferred_purpose?: string;
  inferred_constraints?: string[];
  architectural_decision?: {
    decision: string;
    rationale?: string;
    evidence: IntentEvidence[];
  };
  workaround_indicator?: {
    is_workaround: boolean;
    workaround_for?: string;
    expected_resolution?: string;
  };
  confidence: 'high' | 'medium' | 'low';
}

export interface IntentEvidence {
  type: 'commit_message' | 'pr_description' | 'code_comment' |
        'pattern_deviation' | 'naming_convention';
  source: string;
  excerpt: string;
  confidence_contribution: number;
}

// v1.7.0 Flow Summary

export interface CASFlowSummary {
  total_critical_flows: number;
  by_criticality: Record<string, number>;
  untested_critical_flows: string[];
  high_error_rate_flows: string[];
}

// v1.7.0 Change Risk

export interface CASChangeRisk {
  node_id: string;
  risk_level: 'critical' | 'high' | 'medium' | 'low';
  risk_factors: ChangeRiskFactor[];

  downstream_impact: {
    direct_callers: string[];
    transitive_callers: string[];
    affected_call_chains: string[];
    affected_entry_points: string[];
  };

  test_protection: {
    has_direct_tests: boolean;
    has_integration_tests: boolean;
    test_ids?: string[];
    untested_callers?: string[];
  };

  stability_context: {
    recent_churn: boolean;
    commit_count_30d: number;
    bug_fix_density: number;
    last_refactor?: string;
  };

  recommendations?: string[];
}

export interface ChangeRiskFactor {
  factor: 'many-callers' | 'critical-path' | 'high-traffic' |
          'no-tests' | 'recent-bugs' | 'complex-logic' |
          'external-dependency' | 'security-sensitive';
  severity: 'high' | 'medium' | 'low';
  details: string;
}

export interface CASChangeRiskSummary {
  high_risk_nodes: string[];
  untested_critical_paths: string[];
  recent_hotspots: string[];
}

// v1.7.0 Data Lifecycle

export interface CASDescriptionGeneration {
  status:
    | 'deterministic_initial'
    | 'deterministic_kept'
    | 'ai_applied'
    | 'ai_rejected'
    | 'ai_skipped'
    | 'ai_failed'
    | 'reused_previous';
  attempted: boolean;
  reason?: string;
  budget_ms?: number;
  generated_at?: string;
  /** Authorship provenance of the stored text. A reused description keeps
   *  this origin while status records that no new generation occurred. */
  origin_source?: 'deterministic' | 'ai' | 'manual';
  /**
   * Set when a prior AI-generated description was carried forward across a
   * full re-analysis that ran without AI, so the text was not re-validated
   * against the latest state of the repo.
   */
  may_be_stale?: boolean;
}

/**
 * Aggregate honesty record for the entity-description LAST-stage AI pass
 * (orchestrator.ts applyAIElementDescriptions, includeEntities: true; see
 * docs/cas/DETERMINISM-BOUNDARY.md). Per-entity outcome already lives on each
 * `CASDataEntity.description_generation`; this is the roll-up so a caller can
 * answer "how much of the entity catalog actually got described, and why not
 * more" without walking every entity. Written even when coverage is partial
 * or zero — never omitted just because the number is unflattering.
 */
export interface CASEntityDescriptionCoverage {
  /** Entities eligible for description in this pass (dataEntities.length). */
  total: number;
  /** Entities that received an AI-authored description (description_source
   *  === 'ai') by the end of this pass. */
  described: number;
  /** Entities the pass actually sent to the AI provider (vs. skipped before
   *  ever being attempted, e.g. because the wall-clock budget ran out before
   *  their batch started). */
  attempted: number;
  /** Effective wall-clock budget for this pass, in ms (see
   *  KLAURO_AI_ELEMENT_DESCRIPTION_BUDGET_MS / the evidence-scaled default). */
  budget_ms: number;
  /** Effective batch size used (see KLAURO_AI_ELEMENT_DESCRIPTION_BATCH_SIZE
   *  / the evidence-scaled default). */
  batch_size: number;
  /** Entities were ordered by evidence richness (lineage + relation +
   *  capability + journey signal) before batching, so a budget cutoff drops
   *  the least-connected entities first, not an arbitrary suffix. */
  priority_ordered: boolean;
  /** Why coverage stopped short of `total`, when it did. Absent when
   *  `described === total`. */
  stopped_reason?: string;
}

export interface CASAnalysisPhase {
  id: string;
  name: string;
  priority: number;
  status: 'complete' | 'partial' | 'skipped' | 'deferred';
  purpose: 'visualization' | 'agent-development' | 'deep-context' | 'ai-enrichment' | 'runtime';
  default_phase: boolean;
  description: string;
  outputs: string[];
  agent_value: string;
  visualization_value: string;
  can_run_later: boolean;
  requires_ai?: boolean;
  generated_at?: string;
  notes?: string[];
  /** Wall-clock start of the orchestrator work this catalog phase describes,
   *  aggregated from the underlying per-phase timing records (earliest start
   *  among the matched phases). Absent when the phase did not run in this
   *  analysis (e.g. `deferred-element-descriptions`, which is on-demand only). */
  started_at?: string;
  /** Summed wall-clock duration (ms) of the underlying phases this catalog
   *  entry describes. Instrumentation only — does not affect what gets
   *  analyzed, only what gets reported about how long it took. */
  duration_ms?: number;
}

/**
 * Compact per-run timing breakdown, attached to `CASOutput.timings`. Built
 * from the SAME per-phase wall-clock measurements the orchestrator already
 * takes for its internal debug logging (`KLAURO_DEBUG_ANALYSIS_TIMINGS`) and
 * the analysis-run log (run-log.ts) — this just makes that data visible on
 * the CAS itself so a stuck/slow analysis can be attributed without shelling
 * into `~/.klauro/logs/analysis-runs.jsonl`. Instrumentation only.
 */
export interface CASAnalysisTimings {
  /** Total wall-clock ms from the start of orchestration to when this block
   *  was computed (initial synchronous landing, or again after deferred AI
   *  enrichment completes). */
  total_ms: number;
  /** CPU consumed by the isolated analysis worker, excluding network/provider
   *  wait. This is the efficiency measure used by hosted performance gates. */
  cpu_total_ms?: number;
  cpu_user_ms?: number;
  cpu_system_ms?: number;
  /** cpu_total_ms / total_ms. Values above 1 mean the run used multiple cores
   *  on average; a value near 1 means one core was saturated for the run. */
  average_cpu_cores?: number;
  /** Coarsest stage buckets that already exist as function-call boundaries in
   *  the orchestrator's main path: scan (analyzer detection), parse (language
   *  + framework/library analyzers), graph (relationship/index/architecture
   *  building), decorators (node-level enrichment passes), ai_enrichment (the
   *  AI interpretation pass), save (embedding + final metadata). */
  stages?: Record<string, number>;
  /** CPU milliseconds attributed to the same stage buckets. Unlike wall time,
   * provider/network wait contributes zero here, exposing repeated scans and
   * graph work that consume hosted compute even when phases overlap. */
  cpu_stages?: Record<string, number>;
  /** analyzer_id -> execution_time_ms, lifted from `analyzer_contributions`
   *  (already measured per-analyzer; not re-measured here). */
  analyzers?: Record<string, number>;
}

/**
 * Kind of a data entity, derived deterministically from framework-analyzer
 * evidence on the node — never from the entity's name or casing.
 *  - `persisted-entity`  ORM/@Entity/table-mapped durable state. REQUIRES cited
 *                        persistence evidence (`kind_evidence`) — an ORM
 *                        decorator/attribute/base class, a migration, a schema
 *                        definition, a table mapping, or a repository/DAO
 *                        reference. A shape selected only by its LOCATION (a
 *                        type under an `entities/` directory) is never
 *                        persisted on that basis alone.
 *  - `api-response`      controller return shape / API response — the terminal-entity kind.
 *  - `request-dto`       inbound contract — @Body / validation DTO / request schema.
 *  - `domain-shape`      a field-carrying domain type with NO persistence and no
 *                        route/api binding: real, named honestly, and excluded
 *                        from the ERD's entity set (it has no table to draw).
 *  - `value-object`      field-only shape, no persistence, no route/api binding.
 */
export type CASDataEntityKind =
  | 'persisted-entity'
  | 'api-response'
  | 'request-dto'
  | 'domain-shape'
  | 'value-object';

export interface CASDataEntity {
  id: string;
  name: string;
  schema_source?: string;
  description?: string;
  description_source?: 'deterministic' | 'ai' | 'manual' | 'reused';
  description_generation?: CASDescriptionGeneration;

  /**
   * Deterministic structural kind derived from framework evidence (never from the
   * entity name). Camp-B fact. See CASDataEntityKind.
   */
  kind?: CASDataEntityKind;
  /**
   * `framework-evidence` may only be claimed when `kind_evidence` cites the
   * decorator/attribute/mapping that proves it. When the kind came from the
   * selection path's shape alone (no discriminating framework fact), this is
   * `shape-inference` — an honest label, not a downgrade of the entity.
   */
  kind_source?: 'framework-evidence' | 'shape-inference';
  /**
   * Citation for `kind` when `kind_source` is `framework-evidence`: the actual
   * decorator, attribute, subcategory, table mapping, migration, or
   * repository/DAO reference the classification read. Mandatory for
   * `persisted-entity` — an uncitable persistence claim is not evidence.
   */
  kind_evidence?: string;

  fields?: Array<{
    name: string;
    type: string;
    is_sensitive: boolean;
    validation?: string[];
    /**
     * True when this field IS a relation (see `relations`) rather than a plain
     * scalar column. The field stays listed — the underlying column is real
     * and callers still need its name/type — but it must not read as scalar
     * state when a relation declaration or entity-typed declaration proves
     * otherwise.
     */
    is_relation?: boolean;
  }>;

  lifecycle: {
    created_by: string[];
    read_by: string[];
    updated_by: string[];
    deleted_by: string[];
  };

  /**
   * Relations to OTHER entities, evidence-gated (see
   * analyzer/core/entity-relations.ts). `kind` separates a DATA relation (an
   * ORM association or a typed composition — the ERD/blast-radius content)
   * from a STRUCTURAL one (interface/trait/superclass composition). Both are
   * carried here so a consumer never has to guess which it is looking at, and
   * so a structural edge can never masquerade as the entity's data model.
   * `evidence` cites the decorator/attribute/edge/type that proves the
   * relation; a field whose NAME merely looks like a foreign key produces no
   * entry.
   */
  relations?: Array<{
    target_name: string;
    relation_type: string;
    kind: 'data' | 'structural';
    cardinality?: '1:1' | '1:N' | 'N:1' | 'N:M';
    field?: string;
    inverse_field?: string;
    owning?: boolean;
    join_table?: string;
    evidence_source: 'orm-edge' | 'orm-declaration' | 'typed-composition' | 'structural-edge';
    evidence: string;
  }>;

  transformations?: Array<{
    from_node: string;
    to_node: string;
    transformation_type: 'map' | 'filter' | 'aggregate' |
                         'enrich' | 'validate' | 'sanitize';
  }>;

  invariants?: Array<{
    description: string;
    enforced_by: string[];
    source: 'validation' | 'constraint' | 'test' | 'assertion';
  }>;
}

export interface CASDataSummary {
  entities: CASDataEntity[];
  sensitive_data_nodes: string[];
  validation_gaps: Array<{
    entity_id: string;
    missing_validation: string;
  }>;
}

// v1.8.0 Behavior-Level Invariants

export interface CASBehavioralInvariant {
  id: string;
  name: string;
  invariant_type: 'tenant-scope' | 'auth-boundary' | 'authorization' |
                  'db-constraint' | 'migration-contract' | 'test-coverage' |
                  'data-lifecycle' | 'business-rule';
  description: string;
  scope: {
    node_ids?: string[];
    entry_point_ids?: string[];
    entity_names?: string[];
    field_names?: string[];
    file_paths?: string[];
  };
  enforcement: Array<{
    source: 'code' | 'decorator' | 'database-schema' | 'migration' |
            'test' | 'configuration' | 'security-boundary' | 'naming';
    mechanism: string;
    confidence: 'enforced' | 'inferred' | 'missing';
    node_id?: string;
    file?: string;
    line?: number;
  }>;
  evidence: Array<{
    source: 'node' | 'entry_point' | 'database_schema' | 'security_boundary' |
            'test_suite' | 'migration_file' | 'source_file';
    id?: string;
    file?: string;
    line?: number;
    excerpt?: string;
  }>;
  related_tests?: string[];
  related_boundaries?: string[];
  related_entities?: string[];
  gaps?: string[];
  confidence: 'high' | 'medium' | 'low';
}

export interface CASBehavioralInvariantSummary {
  total: number;
  by_type: Record<string, number>;
  by_confidence: Record<string, number>;
  by_gap_severity?: Record<'high' | 'medium' | 'low', number>;
  enforced: number;
  inferred: number;
  missing: number;
  gaps: Array<{
    invariant_id: string;
    gap: string;
    severity: 'high' | 'medium' | 'low';
  }>;
}

// v1.7.0 Security Boundaries

export interface CASSecurityBoundary {
  id: string;
  name: string;
  boundary_type: 'authentication' | 'authorization' | 'input-validation' |
                 'output-encoding' | 'rate-limiting' | 'encryption' | 'tenant-isolation';

  enforcement_points: Array<{
    node_id: string;
    mechanism: string;
    confidence: 'enforced' | 'assumed' | 'missing';
  }>;

  trust_transition: {
    from_trust_level: 'untrusted' | 'partially-trusted' | 'trusted';
    to_trust_level: 'untrusted' | 'partially-trusted' | 'trusted';
  };

  sensitive_operations: string[];
  bypass_risks?: string[];
}

export interface CASSecuritySummary {
  boundaries: CASSecurityBoundary[];
  unprotected_sensitive_ops: string[];
  assumed_vs_enforced: {
    enforced: number;
    assumed: number;
    missing: number;
  };
}

// v1.7.0 Flow-Test Coverage

export interface CASFlowCoverage {
  call_chain_id: string;
  call_chain_name?: string;

  coverage_status: 'fully-covered' | 'partially-covered' | 'not-covered';
  coverage_percentage?: number;

  tested_segments: Array<{
    node_id: string;
    test_ids: string[];
    assertion_count: number;
  }>;

  untested_segments: Array<{
    node_id: string;
    importance: 'critical' | 'high' | 'medium' | 'low';
    reason: string;
  }>;

  test_quality: {
    has_unit_tests: boolean;
    has_integration_tests: boolean;
    has_e2e_tests: boolean;
    uses_mocks: boolean;
    mock_targets?: string[];
  };
}

export interface CASTestGap {
  gap_type: 'untested-flow' | 'untested-branch' | 'mock-only' | 'no-assertions';
  title?: string;
  description?: string;
  location: {
    node_id?: string;
    call_chain_id?: string;
    line?: number;
  };
  severity: 'critical' | 'high' | 'medium' | 'low';
  recommendation: string;
}

// v1.7.0 Temporal Stability

export interface CASTemporalStability {
  node_id: string;

  stability_score: number;
  stability_class: 'stable' | 'evolving' | 'volatile' | 'fragile';

  churn_metrics: {
    commits_30d: number;
    commits_90d: number;
    unique_authors_30d: number;
    lines_changed_30d: number;
  };

  quality_signals: {
    bug_fix_rate: number;
    refactor_frequency: 'frequent' | 'occasional' | 'rare';
    has_recent_regression: boolean;
  };

  age_context: {
    file_age_days: number;
    last_major_change?: string;
    is_legacy: boolean;
  };

  risk_correlation?: {
    high_churn_high_bugs: boolean;
    recent_refactor_unstable: boolean;
  };
}

export interface CASStabilitySummary {
  by_stability_class: Record<string, number>;
  hotspots: Array<{
    node_id: string;
    reason: string;
  }>;
  legacy_areas: string[];
}

// v1.7.0 System Capabilities

export interface SystemCapability {
  id: string;
  name: string;
  /**
   * Provenance of `name`. A capability NAME asserts what the capability DOES /
   * MEANS for consumers — that is COMPREHENSION, produced only by AI (or a
   * curated `manual` map, or `reused` incremental carry-forward), never by a
   * deterministic keyword→label template (see docs/cas/DETERMINISM-BOUNDARY.md).
   * When comprehension has not yet run, `name_source` is left UNSET and `name`
   * holds a terminal-evidence-grounded structural placeholder (see
   * `structural_label`) awaiting the AI naming pass — it is never a fabricated
   * "<Domain> Management/Analysis/…" claim about behavior.
   */
  name_source?: 'ai' | 'manual' | 'reused';
  name_generation?: CASDescriptionGeneration;
  /**
   * Deterministic FACT label for this capability: the humanized domain key
   * anchored on the terminal (api-response / persisted) entities it produces.
   * Pure Camp-B structure — used for dedup, grouping, and the structural
   * quality gates. Unlike `name`, it makes no interpretive claim about behavior
   * and is stable run-to-run. `name` may equal this before the AI naming pass.
   */
  structural_label?: string;
  description: string;
  description_source?: 'deterministic' | 'ai' | 'manual' | 'reused';
  description_generation?: CASDescriptionGeneration;
  category: 'core' | 'supporting' | 'admin' | 'internal';

  operations: Array<{
    entry_point_id: string;
    entry_point_type: string;
    action: string;
    path_or_command?: string;
    /** HTTP method/path this operation's real entry point declares
     *  (orchestrator.ts's extractTrigger, mirroring CASEntryPoint.trigger) —
     *  set only for `entry_point_type === 'http'` operations, never
     *  fabricated for CLI/event/internal ones. Route-match evidence:
     *  flow-concepts.ts's deriveCapabilityRelationships matches a flow's own
     *  outbound API exit points (e.g. an Angular UI flow's per-call
     *  HttpClient calls) against this to relate a UI flow to the backend
     *  operation it actually calls. */
    trigger?: { method?: string; path?: string };
  }>;

  related_entities: string[];
  related_domains: string[];
  criticality: 'critical' | 'high' | 'medium' | 'low';
  criticality_factors: string[];
  /**
   * Provenance of the EVIDENCE that produced this capability, used by the
   * post-AI-catalog reconciliation (see reconcileCatalogedCapabilities):
   * - 'behavior-surface': derived from a named registration surface (e.g. a
   *   200+ tool MCP server, a socket-event namespace) with no persisted-entity
   *   anchor. The AI catalog pass — which reasons from journeys/entities —
   *   systematically MISSES these, so they are re-injected if the catalog
   *   dropped them. This is the flagship-capability guarantee.
   * - 'infrastructure': the capability's only anchors are runtime/lifecycle-
   *   shaped entities with no product (persisted/api-response) evidence; it
   *   fails the purpose test and is dropped from the shipped catalog.
   */
  evidence_kind?: 'behavior-surface' | 'infrastructure';
  /**
   * A few of this candidate's own real, per-entry identifiers (registered
   * tool/command/event names — evidence, never invented) — used ONLY to
   * present a `evidence_kind: 'behavior-surface'` candidate to the AI
   * capability-catalog step by what its handlers are actually called, instead
   * of the structural `<Kind> Surface` placeholder (a mechanism noun the
   * catalog prompt's own purpose-test rule tells the model to reject on
   * sight, hiding a large flagship surface behind a name shaped like
   * plumbing). Never overwrites `name`/`structural_label` — those stay the
   * honest structural placeholder everywhere else (behavior_surfaces
   * display, dedup, merge). Absent when the surface's entries carry no
   * readable per-entry identifier.
   */
  evidence_examples?: string[];
  /**
   * Inverted M:N capability<->flow edges, one {flow_id, role, rationale} per
   * flow related to this capability — roles live on the edge, not either
   * endpoint (docs/SEMANTIC-MODEL.md). Computed once at analysis time,
   * un-capped, and persisted so query-time consumers never re-derive (and
   * mis-cap) flows per request. Must stay omitted (undefined, never []) when
   * uncomputed — callers treat absent as "uncomputed" and empty as a genuine zero.
   */
  related_flows?: Array<{ flow_id: string; role: string; rationale: string }>;
}

export interface SystemPurpose {
  primary_type: string;
  confidence: number;
  evidence: string[];
  secondary_types?: string[];
}

export interface CASWorkflow {
  id: string;
  name: string;
  description: string;
  workflow_type: 'crud' | 'process' | 'query' | 'command' | 'composite';

  entry_points: string[];
  call_chains: string[];
  exit_points: string[];

  entities_touched: string[];
  services_used: string[];

  classification: 'primary' | 'supporting' | 'internal';
  criticality: 'critical' | 'high' | 'medium' | 'low';

  dependencies: string[];
  dependents: string[];
}

export interface CASUserJourneyStep {
  node_id: string;
  name: string;
  layer: 'entry' | 'business' | 'data' | 'infrastructure';
  depth: number;
}

export interface CASUserJourneyTerminalEntity {
  entity_id?: string;
  name: string;
  access: 'created' | 'updated' | 'deleted' | 'read';
  node_id?: string;
  terminal_kind: 'entity' | 'node';
}

/**
 * What a guard or security boundary actually protects against. A
 * rate-limiting guard is not authentication; surfaces that say "guarded"
 * must carry this distinction so protection is never overstated.
 */
export type CASGuardKind = 'authentication' | 'authorization' | 'rate-limiting' | 'validation' | 'unknown';

export interface CASUserJourney {
  id: string;
  name: string;
  journey_kind: 'user-facing' | 'system' | 'scheduled';
  entry_point_id: string;
  entry: {
    type: string;
    name: string;
    method?: string;
    path_or_trigger?: string;
    handler_node_id?: string;
  };
  steps: CASUserJourneyStep[];
  terminal_effects: {
    entities_written: string[];
    entities_read: string[];
    external_services: string[];
    messages_emitted: string[];
  };
  terminal_entities: CASUserJourneyTerminalEntity[];
  security_boundaries: Array<{
    node_id?: string;
    name: string;
    mechanism: string;
    kind?: CASGuardKind;
  }>;
  tests_covering: string[];
  risk?: 'low' | 'medium' | 'high' | 'critical';
  criticality: 'critical' | 'high' | 'medium' | 'low';
  call_chain_ids: string[];
  exit_point_ids: string[];
}

export interface CASUserJourneySummary {
  total_discovered: number;
  included: number;
  by_kind: {
    'user-facing': number;
    system: number;
    scheduled: number;
  };
}

export interface CASEntityLineageAccessor {
  node_id: string;
  file?: string;
  via: string;
}

export interface CASEntityLineageExternalRecipient {
  exit_point_id: string;
  service: string;
  via_node?: string;
}

export interface CASEntityLineageBoundary {
  boundary: string;
  guarded: boolean;
  guard_kinds?: CASGuardKind[];
}

export interface CASEntityLineage {
  entity_id: string;
  entity_name: string;
  sensitive_fields: string[];
  writers: CASEntityLineageAccessor[];
  readers: CASEntityLineageAccessor[];
  external_recipients: CASEntityLineageExternalRecipient[];
  boundaries_crossed: CASEntityLineageBoundary[];
  journeys_carrying: string[];
  exposure: {
    unguarded_paths: number;
    non_auth_guarded_paths?: number;
    external_transfer: boolean;
    sensitive: boolean;
  };
}

export interface CASBehaviorDiffJourney {
  id: string;
  name: string;
  entry: string;
  entities_written: string[];
  guarded: boolean;
}

export interface CASBehaviorDiffJourneyChange {
  id: string;
  name: string;
  what: string[];
}

export interface CASBehaviorDiffUnguardedEntry {
  journey_id: string;
  name: string;
  entry: string;
  entities_written: string[];
  reason: 'lost-guard' | 'new-unguarded';
}

export interface CASBehaviorDiffCapabilityOverlap {
  new_capability: string;
  overlaps_with: string;
  shared_entities: string[];
  shared_name_tokens: string[];
}

export interface CASBehaviorDiffParadigmDeviation {
  paradigm: string;
  file: string;
  kind: string;
  detail: string;
  severity: 'info' | 'warning' | 'error';
}

export interface CASBehaviorDiff {
  journeys: {
    added: CASBehaviorDiffJourney[];
    removed: CASBehaviorDiffJourney[];
    changed: CASBehaviorDiffJourneyChange[];
  };
  security: {
    boundaries_added: string[];
    boundaries_removed: string[];
    newly_unguarded_entries: CASBehaviorDiffUnguardedEntry[];
  };
  capabilities: {
    added: Array<{ id: string; name: string }>;
    removed: Array<{ id: string; name: string }>;
    possibly_duplicated: CASBehaviorDiffCapabilityOverlap[];
  };
  lineage: {
    entities_with_new_writers: Array<{ entity_name: string; new_writers: string[] }>;
    sensitive_exposure_changes: Array<{ entity_name: string; change: string }>;
  };
  paradigms: {
    new_deviations: CASBehaviorDiffParadigmDeviation[];
    resolved_deviations: Array<{ paradigm: string; file: string; kind: string }>;
  };
  summary: {
    risk_flags: string[];
  };
}

export interface CASWorkflowDependency {
  from_workflow: string;
  to_workflow: string;
  dependency_type: 'calls' | 'reads-from' | 'requires-auth' | 'requires-entity' | 'temporal';
  strength: 'required' | 'optional';
  evidence: string[];
}

export interface CASWorkflowGraph {
  workflows: CASWorkflow[];
  dependencies: CASWorkflowDependency[];
  primary_workflow_id?: string;
  entry_workflow_id?: string;
  critical_shared_nodes: Array<{
    node_id: string;
    used_by_workflows: string[];
    criticality: 'critical' | 'high' | 'medium' | 'low';
  }>;
}

export interface CASDomainConcept {
  id: string;
  name: string;
  /**
   * DISTINCT USAGE SITES — how many separate code units, entry points and
   * entities use the term. Not a token count: a raw occurrence counter reported
   * five figures for the top term of a mid-sized repository and could not tell a
   * pervasive domain noun from a common English word.
   */
  frequency: number;
  appears_in: {
    entry_points: string[];
    entities: string[];
    nodes: string[];
  };
  classification: 'core' | 'supporting' | 'infrastructure';
  /**
   * Factual account of where the term occurs (entities / entry points / code
   * units and total occurrences). Structure, not comprehension — it reports
   * counted evidence and never asserts a meaning.
   */
  description?: string;
  /**
   * Rank key: how strongly the repository's own structure and authored text
   * single this term out, as opposed to how often it occurs. Channel breadth
   * dominates; site spread only breaks ties, logarithmically.
   */
  distinctiveness?: number;
  /**
   * WHY this term is a concept — the cited channels: a data entity it names, a
   * capability whose subject it is, an entry-point noun, recurrence across the
   * declared-type vocabulary, or authored README/manifest prose. A term with no
   * citation is not domain vocabulary, however frequent. `structural prominence`
   * appears only via the small floor that keeps type-less repositories (bare
   * scripts, bots) from reporting nothing at all.
   */
  distinctiveness_evidence?: string[];
}

export type CASArtifactType = 'app' | 'library' | 'client-sdk' | 'cli-tool' | 'boilerplate' | 'infrastructure';

export interface EnhancedSystemPurpose extends SystemPurpose {
  primary_domain: string;
  domain_source?: 'deterministic' | 'ai' | 'ai-refined' | 'reused';
  /** True when the deterministic domain won via an anchor gate or grounded
   * structural evidence. An anchored domain may only be narrowed by AI
   * (refined to a more specific child label), never replaced sideways. */
  domain_anchored?: boolean;
  /** AI domain candidates rejected by the domain authority rules. */
  domain_rejected_candidates?: Array<{ label: string; reason: string }>;
  /**
   * Capabilities whose AI description failed the grounding gate even after the
   * targeted repair pass, and therefore fell back to their deterministic
   * structural text (`description_source: 'deterministic'`). Present only when
   * at least one capability degraded — never omitted to flatter the run.
   *
   * This exists because per-capability rejection used to be FATAL to the whole
   * L5 pass: 2 bad descriptions out of 59 nulled the system description, the
   * primary domain and the other 57 capabilities. Containment plus an explicit
   * honesty record replaced that; the system narrative itself still has no
   * fallback and still fails the analysis when it cannot be grounded.
   */
  capability_description_degradations?: Array<{
    id: string;
    name: string;
    reason: string;
    /** Which remediation this needs: 'provider-unavailable' = retry / check
     *  credentials, quota and reachability; 'failed-grounding' = the model
     *  answered and the answer was rejected, so the evidence or the prompt is
     *  the problem. Conflating the two is how provider timeouts got reported as
     *  grounding failures. */
    failure_class: 'provider-unavailable' | 'failed-grounding';
  }>;
  /**
   * Capabilities whose NAME could not be AI-generated and whose deterministic
   * structural label was rejected because it was derived from a SOURCE PATH —
   * a file extension rendered as a word, filesystem geography, or an opaque
   * generated id. Each entry was either rebuilt from operation/entity evidence
   * or dropped; neither ever ships the path text.
   *
   * This exists because the un-enriched fallback used to ship those labels
   * verbatim as customer-visible capabilities, including the hosted service's
   * own storage root. Present only when at least one name degraded.
   */
  capability_name_degradations?: Array<{
    id: string;
    /** The name that shipped (rebuilt) or the rejected one (dropped). */
    name: string;
    /** The path-derived label that was refused. */
    rejected_name: string;
    reason: 'name-derived-from-source-path';
    disposition: 'rebuilt-from-evidence' | 'dropped';
  }>;
  /**
   * DESCRIPTION-VS-CAPABILITY CROSS-CHECK: the AI-authored system description
   * (`inferred_description`) and the shipped `system_capabilities` list are
   * two independent surfaces over the same evidence, and the AI catalog step
   * can silently drop a data-entity-anchored capability the description
   * itself names (measured live: a C# repo whose description centers on
   * "Device"/"Asset" shipped zero capability for either despite rich CRUD
   * entity families for both). `core_concepts` is the structural,
   * evidence-derived subject list the description was grounded from — never
   * a curated keyword table. Each entry here is a `core_concepts` subject
   * that matched a real `data_entities` record (persisted-entity/api-response
   * kind, non-empty lifecycle) with NO capability anchored on it after
   * reconciliation.
   *   - 'reinjected-from-candidate': a pre-AI deterministic candidate for
   *     this entity existed and already passed the structural-anchoring gate
   *     — it was restored into `system_capabilities` rather than fabricated.
   *   - 'no-structural-candidate': the entity is named in the description and
   *     carries product evidence, but no capability candidate ever existed
   *     for it (the anchoring gate never had anything to admit) — nothing was
   *     built; this is a visible admission that the description may be
   *     overreaching, not a silent contradiction.
   */
  description_capability_gaps?: Array<{
    entity_id: string;
    entity_name: string;
    disposition: 'reinjected-from-candidate' | 'no-structural-candidate';
    capability_id?: string;
  }>;
  /**
   * How much of the shipped capability catalog carries an AUTHORED name
   * (AI/manual/reused) versus an un-enriched deterministic placeholder. The
   * honest counterpart to a `ready` status: a catalog that is 228 placeholders
   * and 0 authored names is a degraded comprehension layer, not a result.
   */
  capability_naming_coverage?: {
    total: number;
    authored: number;
    un_enriched: number;
    path_derived_rejected: number;
  };
  /** Deterministic artifact classification: what kind of deliverable this
   * repo is (library, generated client SDK, CLI tool, boilerplate, app). */
  artifact_type?: CASArtifactType;
  secondary_domains?: Array<{ domain: string; areas: string[]; node_share: number }>;
  core_concepts: string[];
  inferred_description: string;
  description_source?: 'deterministic' | 'ai' | 'manual' | 'reused';
  description_generation?: CASDescriptionGeneration;
  /** Hash of the deterministic product-semantic facts that produced the
   * current AI comprehension. Incremental analysis compares this with the
   * next deterministic facts instead of comparing AI-curated output to raw
   * analyzer candidates. */
  ai_input_fingerprint?: string;
  primary_workflow_id?: string;
  supporting_workflow_ids: string[];
  /** Roll-up honesty record for the entity-description LAST-stage AI pass —
   *  see CASEntityDescriptionCoverage. Set whenever that pass runs (even a
   *  zero-coverage skip records why), never fabricated when the pass never
   *  ran (e.g. no data entities in this repo). */
  entity_description_coverage?: CASEntityDescriptionCoverage;
  /** Set only after every required AI stage in this analysis layer ran. */
  ai_phase_status?: 'complete';
}

export interface CASCapability {
  id: string;
  name: string;
  description: string;

  entry_points: string[];
  entry_point_summary: {
    types: string[];
    count: number;
    primary_type: string;
  };

  operations: CASOperation[];
  operation_patterns: ('crud' | 'transform' | 'query' | 'command' | 'event' | 'pipeline')[];

  entities_touched?: string[];
  services_used: string[];
  exit_points: string[];

  call_chain_ids: string[];
  complexity_profile: {
    avg_depth: number;
    max_depth: number;
    has_external_calls: boolean;
    has_database_calls: boolean;
    has_async_calls: boolean;
    branching_factor: number;
  };

  classification: 'primary' | 'supporting' | 'infrastructure';
  criticality: 'critical' | 'high' | 'medium' | 'low';

  signals: {
    domain_concept_score: number;
    centrality_score: number;
    coverage_score: number;
    complexity_score: number;
    total_score: number;
  };

  depends_on: CASCapabilityDependency[];
  depended_by: string[];
}

export interface CASOperation {
  id: string;
  name: string;
  pattern: 'create' | 'read' | 'update' | 'delete' | 'action' | 'query' | 'transform';

  entry_point_id?: string;
  call_chain_ids: string[];
  implementing_nodes: string[];

  trigger?: {
    type: string;
    method?: string;
    path?: string;
    command?: string;
    event_name?: string;
  };
}

export interface CASCapabilityDependency {
  from_capability: string;
  to_capability: string;

  dependency_type: 'requires' | 'uses' | 'shares-data' | 'triggers' | 'cascade';
  strength: 'required' | 'common' | 'optional';

  evidence: {
    shared_services: string[];
    shared_entities?: string[];
    shared_nodes: string[];
    call_count?: number;
  };

  description: string;
}

/**
 * MATERIALIZED FLOW RECORD — the referent every `flow_id` in the CAS points at.
 *
 * Flows are derived (computeFlowConcepts) from the ranked terminal call chains
 * plus entry-point-rooted chains, but until this collection existed they were
 * never persisted: `system_capabilities[].related_flows`, `behavior_surfaces
 * []. related_flows` and every `flow::…::stepN` id referenced flows that
 * resolved to NOTHING in the stored CAS. This is the resolution target, and
 * `flow_graph.flows` is its single canonical home.
 *
 * Deliberately a COMPACT record, not the full FlowConcept: steps, contracts and
 * step graphs stay derived on demand by `get_flow_concepts` (persisting them
 * would multiply CAS size for data the query layer rebuilds anyway). Everything
 * here is evidence carried straight off the derived flow — nothing synthesized.
 */
export interface CASFlowRef {
  /** Canonical flow id. `flow::<call-chain-id>` for a terminal-chain-anchored
   *  flow, `flow::<entry-point-id>` for an entry-point-rooted one — one scheme
   *  per flow, minted once in flow-concepts.ts and never re-derived. */
  flow_id: string;
  name: string;
  intent: string;
  /** Entry point (or root node) this flow starts at. */
  entry_point: string;
  /** Call chain this flow was anchored to, when it is chain-anchored. Absent
   *  for entry-point-rooted flows (their chain dead-ends). */
  call_chain_id?: string;
  /** Primary capability, mirroring FlowConcept.capability_id. */
  capability_id?: string;
  /** Every capability related to this flow (the M:N inverse of
   *  `system_capabilities[].related_flows`). */
  capability_ids?: string[];
  /** Criticality of the anchoring call chain — the same rank-based value
   *  `flow_summary.by_criticality` counts. Absent when there is no chain. */
  criticality?: 'critical' | 'high' | 'medium' | 'low';
  /** Number of derived steps; the step ids are `<flow_id>::step<0..n-1>`. */
  step_count: number;
  terminus?: { kind: string; produces: string };
}

export interface CASFlowGraph {
  capabilities: CASCapability[];
  dependencies: CASCapabilityDependency[];
  /**
   * Every flow referenced anywhere in the CAS. Optional only for backward
   * compatibility with CAS documents produced before it existed; the analyzer
   * always populates it, and a referential-integrity invariant test asserts
   * that no `flow_id` reference dangles.
   */
  flows?: CASFlowRef[];

  topology: {
    root_capabilities: string[];
    leaf_capabilities: string[];
    critical_path: string[];
    max_depth: number;
  };

  primary_flow: {
    core_capability_id: string;
    value_chain: string[];
    supporting_capabilities: string[];
    infrastructure_capabilities: string[];
  };

  layers: CASFlowLayer[];

  system_insights: {
    detected_patterns: string[];
    primary_entry_type: string;
    data_flow_type: string;
  };
}

// v2.0.0 is the recursive-CAS major: one structure that nests via sub-CAS
// nodes (docs/cas/SPECIFICATION.md §0), plus CASNode.role/role_source/
// role_evidence carrying the closed NODE_ROLES vocabulary. Greenfield rename —
// no compatibility path for pre-2.0.0 analyses; they are re-analysed.
// v2.1.0: added module_health (CASModuleHealth) — file-level size/churn/
// fan-in/mixed-concern outlier surface, additive-only, no field removed or
// retyped, no compatibility break with 2.0.0.
export const CAS_VERSION = '2.1.0';

export interface CASFlowLayer {
  layer_number: number;
  layer_name: string;
  capabilities: string[];
  layer_type: 'entry' | 'business' | 'data' | 'infrastructure';
}

// =============================================================================
// INCREMENTAL ANALYSIS TYPES (v1.8.0)
// =============================================================================

export const INCREMENTAL_STATE_VERSION = '1.0.0';
export const FULL_REBUILD_THRESHOLD = 0.50;

export interface IncrementalState {
  version: string;
  projectPath: string;
  lastFullAnalysis: string;
  lastAnalysisTimestamp: number;
  gitCommitHash?: string;
  files: Record<string, FileAnalysisRecord>;
  analyzerVersions: Record<string, string>;
  analyzerRegistryFingerprint?: string;
  config?: {
    rebuildThreshold?: number;
    watchDebounceMs?: number;
    maxPropagationDepth?: number;
  };
}

export interface FileAnalysisRecord {
  filePath: string;
  contentHash: string;
  mtimeMs: number;
  lastAnalyzed: string;
  analyzerId: string;
  nodeIds: string[];
  edgeIds: string[];
  entryPointIds: string[];
  exitPointIds: string[];
  importedFiles: string[];
  exportedSymbols: string[];
}

export interface FileAnalysisResult {
  filePath: string;
  contentHash: string;
  mtimeMs: number;
  nodes: CASNode[];
  edges: CASEdge[];
  entryPoints: CASEntryPoint[];
  exitPoints: CASExitPoint[];
  imports: string[];
  exports: string[];
}

export interface ChangeSet {
  added: string[];
  modified: string[];
  deleted: string[];
  affectedFiles: string[];
  affectedNodeIds: Set<string>;
  requiresFullRebuild: boolean;
  reason?: string;
  detectionMethod: 'mtime' | 'git' | 'hash' | 'hybrid';
}

export interface ChangeHistoryEntry {
  id: string;
  timestamp: string;
  gitCommitHash?: string;
  gitCommitMessage?: string;
  author?: string;
  source: 'human' | 'ai' | 'automated' | 'unknown';
  aiSessionId?: string;
  aiProvider?: string;

  changes: {
    files: FileChange[];
    nodes: NodeChange[];
    edges: EdgeChange[];
    entryPoints: EntryPointChange[];
    exitPoints: ExitPointChange[];
  };

  semanticSummary?: string;
  intent: ChangeIntent;

  impact: ImpactAnalysis;
  suggestedActions: SuggestedAction[];
  breakingChanges: BreakingChange[];
  minimumTestSet: string[];
}

export interface FileChange {
  path: string;
  type: 'added' | 'modified' | 'deleted' | 'renamed' | 'moved';
  oldPath?: string;
  linesAdded: number;
  linesRemoved: number;
  hunks?: DiffHunk[];
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  content: string;
}

export interface NodeChange {
  nodeId: string;
  nodeName: string;
  nodeType: string;
  file: string;
  changeType: 'added' | 'modified' | 'deleted' | 'moved' | 'renamed';
  oldNodeId?: string;
  semanticChange?: string;
  diff?: {
    before: string;
    after: string;
  };
}

export interface EdgeChange {
  edgeId: string;
  source: string;
  target: string;
  edgeType: string;
  changeType: 'added' | 'deleted' | 'modified';
}

export interface EntryPointChange {
  entryPointId: string;
  name: string;
  changeType: 'added' | 'deleted' | 'modified';
  details?: string;
}

export interface ExitPointChange {
  exitPointId: string;
  name: string;
  changeType: 'added' | 'deleted' | 'modified';
  details?: string;
}

export interface ChangeIntent {
  type: 'bug-fix' | 'feature' | 'refactor' | 'performance' | 'security' | 'docs' | 'test' | 'chore' | 'unknown';
  confidence: number;
  evidence: string[];
}

export interface SuggestedAction {
  type: 'run-test' | 'update-docs' | 'review-security' | 'update-api-version' | 'notify-consumers';
  priority: 'low' | 'medium' | 'high' | 'critical';
  description: string;
  targets: string[];
}

export interface BreakingChange {
  type: 'signature-change' | 'removed-export' | 'type-change' | 'behavior-change';
  nodeId: string;
  description: string;
  affectedConsumers: string[];
  suggestedMigration?: string;
}

export interface ImpactAnalysis {
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  confidence: number;

  affectedEntryPoints: Array<{
    id: string;
    name: string;
    path?: string;
    impactType: 'direct' | 'transitive';
    distance: number;
  }>;

  affectedCallChains: Array<{
    id: string;
    name?: string;
    criticality?: string;
    affectedNodes: string[];
  }>;

  affectedConsumers: Array<{
    nodeId: string;
    file: string;
    usageType: 'import' | 'call' | 'extend' | 'implement';
  }>;

  criticalPathsAffected: boolean;
  securitySensitive: boolean;
  dataFlowAffected: boolean;

  testCoverage: {
    directTests: string[];
    integrationTests: string[];
    uncoveredChanges: string[];
    suggestedTests: string[];
  };

  documentation: {
    affectedDocs: string[];
    outdatedComments: string[];
  };
}

export interface ChangeReport {
  timestamp: string;
  previousAnalysis: string;
  currentAnalysis: string;

  summary: {
    filesAdded: number;
    filesModified: number;
    filesDeleted: number;
    nodesAdded: number;
    nodesModified: number;
    nodesDeleted: number;
    edgesAdded: number;
    edgesModified: number;
    edgesDeleted: number;
  };

  impact: ImpactAnalysis;
  semantic_impact?: ChangeSemanticImpact;

  details: {
    files?: FileChange[];
    addedNodes: Array<{ id: string; name: string; type: string; file: string }>;
    modifiedNodes: Array<{ id: string; name: string; type?: string; file?: string; changes: string[] }>;
    deletedNodes: Array<{ id: string; name: string; type: string; file?: string }>;
    addedEdges: Array<{ id?: string; source: string; target: string; type: string }>;
    deletedEdges: Array<{ id?: string; source: string; target: string; type: string }>;
    addedEntryPoints?: Array<{ id: string; name: string }>;
    modifiedEntryPoints?: Array<{ id: string; name: string; details?: string }>;
    deletedEntryPoints?: Array<{ id: string; name: string }>;
    addedExitPoints?: Array<{ id: string; name: string }>;
    deletedExitPoints?: Array<{ id: string; name: string }>;
  };

  changeHistory?: ChangeHistoryEntry[];
}

export interface ChangeSemanticImpact {
  affected_workflows: Array<{ id: string; name: string; reason: string }>;
  affected_capabilities: Array<{ id: string; name: string; reason: string }>;
  affected_data_entities: Array<{ id: string; name: string; reason: string }>;
  affected_runtime_links: Array<{ id: string; runtime_signal: string; reason: string }>;
  changed_contracts: Array<{ id: string; type: 'entry-point' | 'exit-point' | 'repository-link'; name: string }>;
  risk_reasons: string[];
}

export interface AnalysisConfidence {
  overall: number;
  staleness: 'fresh' | 'recent' | 'stale' | 'very-stale';
  lastAnalysis: string;
  timeSinceAnalysis: number;

  perFile: Record<string, {
    confidence: number;
    reason: string;
  }>;

  perNode: Record<string, {
    confidence: number;
    factors: string[];
  }>;

  recommendations: Array<{
    action: 'reanalyze' | 'reanalyze-file' | 'reanalyze-module';
    target?: string;
    reason: string;
    priority: 'low' | 'medium' | 'high';
  }>;
}

export interface ContextBundle {
  tokenCount: number;
  priority: 'essential' | 'important' | 'supplementary';

  core: {
    targetNode: CASNode;
    signature?: string;
    documentation?: string;
    immediateContext?: string;
  };

  related?: {
    callers: CASNode[];
    callees: CASNode[];
    siblings: CASNode[];
  };

  patterns?: {
    appliedPatterns: string[];
    conventions: string[];
    antiPatterns: string[];
  };

  history?: {
    recentChanges: ChangeHistoryEntry[];
    changeVelocity: 'stable' | 'active' | 'volatile';
  };

  similar?: Array<{
    node: CASNode;
    similarity: number;
    reason: string;
  }>;

  truncated: boolean;
  omitted: string[];
}

export interface PreFlightAssessment {
  feasibility: 'safe' | 'caution' | 'risky' | 'dangerous';
  impact: ImpactAnalysis;

  conflicts: Array<{
    type: 'recent-change' | 'in-progress' | 'pattern-violation' | 'convention-violation';
    description: string;
    changeId?: string;
    severity: 'info' | 'warning' | 'error';
  }>;

  suggestions: Array<{
    type: 'use-existing' | 'follow-pattern' | 'consider-alternative' | 'update-related';
    description: string;
    reference?: string;
    code?: string;
  }>;

  requiredUpdates: Array<{
    file: string;
    nodeId?: string;
    reason: string;
    automated: boolean;
  }>;

  testStrategy: {
    existingTests: string[];
    newTestsNeeded: string[];
    suggestedTestPattern?: string;
  };

  estimatedEffort: 'trivial' | 'small' | 'medium' | 'large';
}

export interface MinimumTestSet {
  required: Array<{
    testId: string;
    testName: string;
    file: string;
    reason: string;
    coversNodes: string[];
  }>;

  recommended: Array<{
    testId: string;
    testName: string;
    reason: string;
    priority: number;
  }>;

  optional: Array<{
    testId: string;
    testName: string;
    reason: string;
  }>;

  coverage: {
    coveredNodes: string[];
    uncoveredNodes: string[];
    coveragePercent: number;
  };

  estimatedRunTime: number;
  fullSuiteRunTime: number;
  savingsPercent: number;
}

export interface AnalysisTimeline {
  entries: TimelineEntry[];
  span: { start: string; end: string };
  resolution: 'minute' | 'hour' | 'day' | 'week';
}

export interface TimelineEntry {
  timestamp: string;
  type: 'analysis' | 'change' | 'milestone';

  analysisId?: string;
  nodeCount?: number;
  duration?: number;

  changeId?: string;
  summary?: string;
  impactLevel?: 'low' | 'medium' | 'high';

  milestone?: 'release' | 'branch' | 'merge' | 'tag';
  label?: string;
}

export interface HeatMapData {
  type: 'churn' | 'bugs' | 'complexity' | 'coverage' | 'staleness';
  resolution: 'file' | 'module' | 'node';

  data: Array<{
    id: string;
    value: number;
    raw: number;
    label: string;
  }>;

  scale: {
    min: number;
    max: number;
    median: number;
  };

  hotSpots: Array<{
    id: string;
    value: number;
    reason: string;
  }>;
}

export interface ChangeAggregate {
  key: string;
  label: string;

  counts: {
    changes: number;
    filesChanged: number;
    nodesAdded: number;
    nodesModified: number;
    nodesDeleted: number;
    linesAdded: number;
    linesRemoved: number;
  };

  impact: {
    avgRisk: number;
    maxRisk: 'low' | 'medium' | 'high' | 'critical';
    criticalChanges: number;
  };

  trend: 'increasing' | 'stable' | 'decreasing';
  velocity: number;
}

export interface WatchStatus {
  watchId: string;
  projectPath: string;
  active: boolean;
  startedAt: string;
  lastEvent?: string;
  pendingChanges: number;
  analysisInProgress: boolean;
  error?: string;
}

export interface CrossRepoLink {
  id: string;
  sourceRepo: string;
  targetRepo: string;
  linkType: 'api-call' | 'shared-db' | 'message-queue' | 'import' | 'submodule';

  apiEndpoint?: string;
  apiConsumers?: string[];

  sharedTables?: string[];

  publishedMessages?: string[];
  consumedMessages?: string[];
}

export interface CrossRepoImpact {
  changeId: string;
  affectedRepos: Array<{
    repo: string;
    linkType: string;
    affectedNodes: string[];
    severity: 'info' | 'warning' | 'breaking';
  }>;
}

export interface AnalysisLockStatus {
  locked: boolean;
  holder?: {
    pid: number;
    startedAt: string;
    operation: string;
  };
  queuedOperations: number;
}

/**
 * Deployable Evidence: per-artifact facts about what in this codebase can
 * actually be built, run, or shipped — composed from evidence already
 * extracted by other analyzers (container topology, distribution artifacts,
 * framework entry points) plus targeted manifest/CI reads. See
 * packages/analyzer-core/src/analyzer/core/deployable-evidence.ts.
 */
export interface DeployableEvidence {
  root_path: string;        // dir owning this candidate (build context / manifest dir / crate dir)
  name: string;
  tier: 1 | 2 | 3;          // 1=ship declaration, 2=runnable entry, 3=package identity
  kind: 'container' | 'compose-service' | 'k8s' | 'serverless' | 'installer' | 'ci-deploy' | 'bin' | 'server-entry' | 'package' | 'build-image';
  evidence: string[];       // concrete: file paths, manifest keys, port bindings
  ships_paths?: string[];   // Tier-1 only: what this artifact packages/COPYs/bundles (membership names, e.g. bin/crate names)
  ports?: number[];
  entrypoint_member?: string; // Tier-1 only: which of ships_paths is the primary/ENTRYPOINT of a multi-member bundle
  /** Container-kind only: the Dockerfile's own `FROM` base image references
   *  (registry/tag included, as written), extracted as a structured field so
   *  CAS-level consolidation (deployable-evidence.ts's build-stage-exclusion
   *  pass) can cross-reference "is this Dockerfile used as a base by another
   *  Dockerfile in this repo" without re-parsing the file — the human-
   *  readable `FROM ...` line stays in `evidence` too. */
  base_images?: string[];
  /** Tier-2/3 only: name of the Tier-1 ship unit this candidate is bundled
   *  into, set by evidence-gated bundling resolution (see
   *  resolveEvidenceBundling in deployable-evidence.ts) when a sibling
   *  Tier-1 row's `ships_paths` positively names this candidate — never set
   *  on absence of evidence alone (SPEC-DEPLOYABLE-DETECTION.md §3/§4). This
   *  lets a single-codebase `deployable_evidence` result carry membership
   *  directly, independent of the multi-repo workspace resolver
   *  (apps/mcp-server/src/cross-codebase-analysis.ts's SystemApplication
   *  layer performs the equivalent resolution again for the cross-codebase
   *  case, setting its own `bundled_into` on SystemApplication).
   */
  bundled_into?: string;
}
