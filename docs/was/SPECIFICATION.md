# Workspace Analysis Specification (WAS)

**Version:** 1.0.0
**Status:** Superseded by `docs/analysis-scope/SPECIFICATION.md` 2.0.0. Retained for the compatibility mapping defined there (§12); not the current specification for new analyses.

## 1. Purpose

The Workspace Analysis Specification (WAS) defines the product/system-level analysis generated after all associated projects, repositories, folders, or codebases have completed CAS analysis. CAS is the repo-level truth layer. WAS is the composition layer that connects those CAS outputs into a workspace map.

WAS MUST NOT require source-code reads. If a Workspace analysis cannot identify a deployable, interface, dependency, runtime surface, or integration from CAS outputs alone, the missing fact is a CAS analyzer gap.

## 2. Analysis Order

1. Run CAS analysis for each associated project/repo/codebase.
2. Validate each CAS output is current enough and contains required repo-level facts.
3. Generate WAS from those completed CAS outputs.
4. Run the default AI enrichment pass for the whole-workspace description, whole-workspace domains, and primary capabilities. If AI is unavailable, WAS MUST mark the narrative as degraded rather than presenting deterministic text as complete.
5. Lazily generate deeper AI descriptions for entities, critical flows, deployables, interfaces, and other drilldowns as requested.

Workspace analysis is generated last. It composes, matches, scores, explains, and reports relationships across CAS outputs; it does not replace project analysis.

## 3. Workspace Inputs

```typescript
interface WASInput {
  project_id: string;
  codebase_id: string;
  repo_path: string;
  cas_analysis_id: string;
  cas_version: string;
  cas_generated_at: string;
}
```

Inputs MAY come from:

- A folder workspace that includes every nested repo/folder analysis.
- A hosted workspace entity with manually connected git repos.
- A manually defined workspace with linked local folders/repos.

Workspace builders MUST honor repo/project exclusion policy before CAS and WAS are generated. Local folders MAY use `.klauroignore` and `.klaurorc` `source.exclude` entries to exclude generated workspaces, archived tools, dependency trees, or intentionally irrelevant repos. MCP/API callers MAY also pass one-off workspace exclude patterns for ad hoc inspection. Exclusions change the input set; WAS MUST NOT pretend excluded projects exist. Product surfaces that trigger Workspace analysis SHOULD report skipped inputs and matched exclusion policy outside the WAS artifact so users and agents can distinguish "not connected" from "intentionally excluded."

## 4. Root Structure

```typescript
interface WorkspaceAnalysis {
  analysis_kind: 'workspace';
  spec_version: '1.0.0';
  was_version: '1.0.0';
  id: string;
  name: string;
  generated_at: string;

  inputs: WASInput[];
  codebase_count: number;
  codebases: WorkspaceProject[];
  projects: WorkspaceProject[];               // Alias of `codebases`
  applications: WorkspaceDeployable[];         // Full drilldown inventory, including internal/package surfaces
  deployables: WorkspaceDeployable[];          // Canonical workspace-level deployables exposed in the overview
  distribution_units: WorkspaceDistributionUnit[];
  composition: WorkspaceCompositionProfile;
  interfaces: WorkspaceInterface[];
  runtime_components: WorkspaceRuntimeComponent[];
  runtime_links: WorkspaceRuntimeLink[];
  runtime_topology: {
    components: WorkspaceRuntimeComponent[];
    links: WorkspaceRuntimeLink[];
  };
  ownership: Record<string, WorkspaceOwnership>;
  environments: WorkspaceEnvironment[];
  infrastructure_overlay: WorkspaceInfrastructureOverlay;
  application_links: WorkspaceApplicationLink[]; // deployable-to-deployable links (superset of integration_links)
  integration_links: WorkspaceIntegrationLink[]; // Interface-to-interface links (HTTP/SDK/message/stream/passive)
  shared_code_rollup: WorkspaceSharedCodeRollup[]; // Monorepo shared-library consumer/blast-radius rollup — see §5.1
  data_flow_paths: WorkspaceDataFlowPath[];
  workspace_capabilities: WorkspaceCapability[];
  workspace_workflows: WorkspaceWorkflow[];
  workspace_domains: WorkspaceDomain[];
  workspace_entities: WorkspaceEntity[];
  workspace_entity_paths: WorkspaceEntityPath[];
  health: WorkspaceHealth;
  risk_areas: WorkspaceRiskArea[];
  priority_work_items: WorkspaceRiskArea[];    // risk_areas re-ranked for "what to fix first"
  activity: WorkspaceActivitySummary;
  telemetry: WorkspaceTelemetrySummary;
  system_insights: WorkspaceInsight[];
  inferred_insights: WorkspaceInsight[];       // Alias of `system_insights`
  links: WorkspaceIntegrationLink[];           // Superset link list backing `integration_links`/`application_links`
  unmatched_interfaces: WorkspaceUnmatchedInterface[];
  workspace_narrative: WorkspaceNarrative;
  ai_enrichment: WorkspaceAiProviderMetadata;
  detail_views: WorkspaceDetailViews;
  validation: WorkspaceValidation;
  quality_flags: WorkspaceQualityFlag[];
  // Deterministic, evidence-based complexity score (never AI, never a keyword
  // table — every subscore's inputs are already-named CAS/WAS facts). Absent
  // (not zero-filled) when the workspace has no member codebases to score.
  workspace_complexity?: WorkspaceComplexity;
  summary: WorkspaceSummary;
}
```

There is no `deterministic_narrative` field. `WorkspaceNarrative` (the single `workspace_narrative` field) is comprehension and MUST be AI-authored or explicitly marked degraded — see docs/cas/DETERMINISM-BOUNDARY.md. A prior draft of this specification listed a `deterministic_narrative` field alongside it; that field was retired and MUST NOT be emitted.

## 5. Core Objects

`WorkspaceProject` represents one completed CAS input. It SHOULD include project name, path, system type, language/framework/package summaries, CAS graph counts, and CAS analysis id.

`WorkspaceDeployable` represents an app, API, worker, service, package, SDK, CLI, runtime service, or codebase-level surface. It MUST be derived from CAS facts such as workspace manifests, package metadata, app folders, binary entry points, Docker/Kubernetes/Compose topology, routes, entry points, exit points, or deployment metadata. WAS SHOULD keep internal helper scripts, build/check commands, shared base images, generic compose base services, and passive data/core packages out of the level-one deployable list unless they are first-class product/runtime surfaces.

`WorkspaceDistributionUnit` represents a repo-level CAS `distribution_units` fact lifted into the workspace map. It SHOULD surface when multiple deployables/components ship, install, or release together, such as a desktop tray app plus daemon, a mobile app plus extension, a server bundle, or a container/deployment unit. WAS MUST keep the member deployables separate and connectable; the distribution unit is a grouping/packaging fact, not a replacement for process-level topology.

`WorkspaceCompositionProfile` explains what kind of workspace Klauro found. Some workspaces are interconnected runtime systems where an app talks to another app through APIs, messages, streams, or passive data. Others are composed application architectures where multiple libraries/packages/SDKs combine into one full application without much app-to-app runtime communication. Others are hybrids, pure library collections, or disconnected collections. WAS MUST expose this profile so MCP/API/UI callers know whether to retrieve or render a system map, architecture/package composition map, both, or a simple inventory.

`WorkspaceInterface` represents a provided or consumed surface: HTTP API, SDK/package, message, stream, or passive shared data. It MUST preserve role, mode, endpoint/topic/package/resource key, source CAS refs, and evidence.

`WorkspaceIntegrationLink` connects interfaces across deployables and projects. Links MUST include source/target deployables, source/target projects, kind, mode, confidence, and evidence. Cross-repo HTTP links MUST NOT be inferred from a relative route alone. If a consumer endpoint names a concrete host or service alias, the target provider MUST match that host/alias before route-shape compatibility can create a link.

`WorkspaceRuntimeComponent` represents deployed/runtime/infrastructure surfaces from CAS facts such as Docker, Docker Compose, Kubernetes, Terraform, CI/CD, and package/deployment manifests. Runtime dependencies MUST carry a usage status: `source-backed` when source-level calls/SDK/data/messaging evidence exists, `topology-only` when only deployment/config wiring exists, or `declared` when present but not linked. Redis, Postgres, MinIO, NLBs, ECS services, EC2 instances, security groups, and similar infrastructure belong here even when they are not application deployables.

`WorkspaceEnvironment` groups runtime and infrastructure facts by environment. It MUST be derived from runtime, deployment, infrastructure, container, compose, Kubernetes, Terraform, CloudFormation, CI/CD, or deployment-manifest CAS facts. WAS MUST NOT populate environment groups from ordinary source files merely because a path contains words such as `internal`, `demo`, or `production`; those details remain repo-local CAS context unless they describe runtime/deployment topology. Environment objects SHOULD expose provider and environment type when inferable, such as AWS production/staging/internal environments or local Docker Compose environments.

`WorkspaceInfrastructureOverlay` is the workspace-level infrastructure lens over runtime topology. It SHOULD group infrastructure by environment/provider, map runtime resources back to deployables where CAS evidence supports the mapping, identify shared resources, and preserve unmapped infrastructure as gaps instead of dropping it. The overlay MUST distinguish `source-backed`, `topology-only`, and `declared` infrastructure usage so agents do not treat provisioned-but-unused resources as product behavior.

`WorkspaceInsight` is a higher-order interpretation of deterministic links, such as UI/API pairing, broker service, relay/fallback path, MCP/agent control surface, or declared-but-unused infrastructure. Insights MUST cite evidence and confidence.

`WorkspaceNarrative.product_value_summary` is the required one-sentence explanation of the product or business job the workspace appears to serve, derived from deterministic WAS facts and AI-enriched by the default summary pass. It MUST NOT invent revenue, customers, compliance posture, or market claims. `WorkspaceNarrative.description` is the longer whole-system explanation of how the main deployables and dependencies fit together. `WorkspaceNarrative` and `ai_enrichment` MUST expose the provider/model provenance for generated text, such as `deepinfra`, `azure-openai`, `openai-compatible`, `openai`, `anthropic`, or `fallback`, plus the narrative model and structured model when known.

`WorkspaceHealth`, `WorkspaceRiskArea`, `WorkspaceActivitySummary`, and `WorkspaceTelemetrySummary` describe the whole-workspace operating picture. They SHOULD include risk severity, high-priority work items, analysis trust, change rate, contributors when available, telemetry/instrumentation status, and follow-up MCP calls. These objects do not replace repo-level CAS risks or runtime facts; they select and connect them at workspace level.

`WorkspaceCapability`, `WorkspaceWorkflow`, and `workspace_domains` describe whole-system capabilities and flows. They MUST be built from repo-level CAS capabilities, workflows, domains, deployables, and links. Workspace workflows MUST expose `confidence` and `evidence_quality` so agents can distinguish source-backed flows from package-declared, topology-backed, route-shape-inferred, or name-inferred guidance. A UI/API name pairing, matching folder name, or config-looking file is not source-backed usage unless the repo-level CAS contains a concrete consumer/provider relationship, endpoint, host/alias, package dependency, message, stream, shared-data, or runtime fact that supports the claim. Their default descriptions are AI-required enrichment over deterministic evidence; if AI enrichment is unavailable, they MUST carry degraded provenance instead of pretending deterministic fallback text is complete.

WAS MUST use repo-level terminal and near-terminal CAS facts to separate core business/product behavior from supporting and infrastructure behavior. Terminal facts include CAS user journey `terminal_entities`, `terminal_effects`, flow graph `leaf_capabilities`, `primary_flow.core_capability_id`, value-chain capabilities, persisted or externally emitted end effects, and entities one or two layers upstream of those end effects. Whole-workspace domains, capabilities, workflows, and entities SHOULD expose `semantic_role`, `terminal_score`, and `terminal_evidence` when terminal evidence affects ranking. High-degree infrastructure, framework setup, build tooling, or generic backend provisioning MUST NOT outrank terminal business capabilities merely because it is central or noisy. The terminal evidence belongs in WAS only as a cross-repo ranking/explanation signal; authoritative repo-local readers, writers, tests, invariants, and implementation details remain in CAS.

`WorkspaceEntity` and `WorkspaceEntityPath` are workspace-level indexes over repo-level CAS entities, data lineage, workflows, capabilities, and cross-repo flows. They MUST NOT duplicate every repo-local entity field or lifecycle detail. Entity paths SHOULD include source, target, ordered steps, `step_count`, `confidence`, `evidence_quality`, and `next_mcp_calls`. Path descriptions MUST be honest about whether the path is source-backed, topology-backed, route-shape inferred, or name/capability inferred. They SHOULD answer "which projects mention this entity concept?", "which workflows/capabilities carry it?", "does it cross a service boundary?", and "which repo-level CAS tool should I call next?" The authoritative field list, constraints, readers, writers, tests, and invariants remain in each repo's CAS.

### 5.1 Shared-Code Rollup (monorepo workspaces)

`shared_code_rollup` composes a cross-deployable view of a shared library/package inside a monorepo workspace: which deployables consume it, how much they use it, and — where derivable from CAS import specifiers — which exported symbols each consumer actually imports. It MUST be built from facts already computed in the same pass (deployable/package application rows, sdk-install application links, and CAS `import` node specifiers); it MUST NOT run a new source-level analysis pass of its own.

```typescript
interface WorkspaceSharedCodeRollup {
  id: string;
  lib_application_id: string;
  lib_name: string;
  project_id: string;
  path_hint: string;
  consumer_count: number;
  total_usage_count: number;
  consumers: Array<{
    deployable_id: string;
    deployable_name: string;
    project_id: string;
    usage_count: number;
    consumed_symbols: string[];
    evidence_quality: WorkspaceLinkEvidenceQuality;
  }>;
  consumed_surface: string[];
  surface_derivable: boolean;
  blast_radius: Array<{ symbol: string; consumer_deployable_ids: string[]; consumer_count: number }>;
  evidence: string[];
}
```

`blast_radius` MUST be derivable per-symbol only when the underlying CAS exposes named-import specifiers for the consumer; when a consumer's import is a bare/namespace import with no resolvable symbol list, `surface_derivable` MUST be `false` and `consumed_surface` MUST be empty rather than guessed.

### 5.2 Workspace Complexity

`workspace_complexity` is a deterministic, evidence-based complexity score — never AI, never a keyword table. Every subscore is read straight off already-computed CAS/WAS facts (graph size, entry/exit surface, communication-seam modality counts, dependency fan-out, entity/capability/deployable counts, runtime-link density, DAS-promotion fraction). The same input always produces the same score.

```typescript
interface ComplexitySubscore {
  score: number;                    // 0-100
  inputs: Record<string, number>;   // Named evidence values this subscore averaged
}

interface CodebaseComplexity {
  codebase_id: string;
  composite: number;                // Mean of the four subscores below, unweighted
  subscores: {
    size: ComplexitySubscore;       // Log-scaled node + edge counts
    coupling: ComplexitySubscore;   // External dependency fan-out + internal edge density
    surface: ComplexitySubscore;    // Entry/exit points + active (sync/async) communication seams
    topology: ComplexitySubscore;   // Deployable/entity/capability breadth
  };
  computed_from: string[];          // Exact fact names this score was computed from
}

interface WorkspaceComplexity {
  composite: number;                       // 60% member-average + 40% cross-repo factors
  member_average_composite: number;
  subscores: {
    application_surface: ComplexitySubscore;    // Log-scaled deployable-application count
    runtime_link_density: ComplexitySubscore;   // Log-scaled resolved cross-repo runtime link count
    das_verified_fraction: ComplexitySubscore;  // % of applications confirmed by DAS promotion (source_das_unit_id set)
  };
  members: Array<{ codebase_id: string; composite: number; subscores: CodebaseComplexity['subscores'] }>;
  computed_from: string[];
}
```

`composite` weightings (per-codebase subscores unweighted; workspace 60/40 member-average/cross-repo split) are documented defaults, not fitted constants — there is no labeled-complexity corpus to calibrate against yet. Absent (never zero-filled) when the workspace has no member codebases to score.

## 6. Retrieval Detail Levels

WAS MUST support progressive retrieval for MCP/API callers. Detail levels are about payload size and task fit; they do not change the underlying analysis facts.

- `overview`: a compact level-one map. It includes projects, deployables, simple deployable-to-deployable connections with `sync`, `async`, `passive`, or `stream` mode, major external/runtime dependencies such as Postgres or Redis, primary capabilities, workflows, top workspace entity concepts, and isolated deployables. This layer should answer questions like "which app talks to which app, by what mode, what data concepts matter, and what major shared infrastructure exists?"
- `connections`: the overview plus integration links, runtime links, inferred insights, and bounded unmatched interfaces.
- `evidence`: the overview plus interfaces, full integration links, runtime topology, data-flow paths, workspace entity paths, insights, unmatched interfaces, and validation.
- `full`: the complete Workspace analysis artifact.

The overview layer is the default human/API map. It MUST include `composition` so clients can decide whether the primary presentation should be app-to-app system topology or package/library architecture. For agent context injection, MCP SHOULD expose an additional task-scoped Workspace agent context derived from WAS. The context MUST NOT introduce new graph facts; it only selects and compresses existing WAS facts for a task. It SHOULD include selected surfaces with explicit `deployable` and `surface_kind` fields, source-backed runtime connections separately from package/code dependencies and inferred candidates, external dependency usage (`source-backed`, `topology-only`, `declared`), isolated surfaces, token-budget estimates compared with full WAS injection, validation rules, an `agent_should_read_next` list, and follow-up repo-level MCP calls.

Agents SHOULD only request deeper levels when a task requires evidence, contract details, runtime topology, or unresolved interface investigation.

Not every deployable in a workspace is expected to connect. A marketing website, reference repo, one-off migration tool, archived experiment, or standalone admin utility may be part of the workspace while having no current integration link. WAS MUST report those deployables as isolated with a reason instead of manufacturing weak links to make the graph look complete.

## 6.1 Audience Views

WAS consumers may retrieve the same facts through different lenses:

- CEO/product view: whole-system description, value drivers, domains, primary capabilities, major customer/user surfaces, external dependencies, and business-critical risks.
- Senior engineer/DOE view: topology, deployment environments, ownership, integration contracts, data-flow paths, risk/blast radius, stale inputs, and unresolved interfaces.
- New engineer view: what to read first, how the apps fit together, which repos own which surfaces, common workflows, and drilldown links into CAS.
- AI agent view: compact workspace context with selected surfaces, explicit deployable flags, source-backed runtime links, package/code dependencies marked separately from runtime behavior, topology-only dependencies, risk/idiom/validation guidance, and exact repo-level MCP calls.

These views are retrieval profiles. They MUST NOT create separate truths or infer repo-local implementation facts in WAS.

## 7. Required Semantics

- WAS MUST be reproducible from CAS outputs only.
- WAS MUST preserve project/repo/codebase analysis as independent and equally important.
- WAS MUST not infer repo-local frameworks, entities, capabilities, idioms, or node graphs. Those belong in CAS.
- WAS SHOULD connect deployables through APIs, SDK/package dependencies, messages, streams, passive data, runtime topology, and configuration-derived service references.
- WAS MUST classify the workspace composition as `interconnected-system`, `composed-application-architecture`, `hybrid-system-and-architecture`, `library-collection`, or `disconnected-collection`. Runtime links and broker/control-plane insights favor system maps; SDK/package/library links favor architecture maps; mixed evidence favors both.
- WAS MUST distinguish source-backed usage from topology-only declarations. Docker/Compose/Terraform/CI evidence can prove what is provisioned or wired, but it MUST NOT by itself claim source-level product usage.
- WAS MUST surface critical source-backed external dependencies even when they appear as SDKs rather than endpoints, including auth providers, payment providers, telemetry vendors, cloud SDKs, and messaging/runtime SDKs.
- WAS SHOULD expose infrastructure overlays and environments from CAS runtime topology. Terraform/AWS/GCP/Azure/Kubernetes/Docker/Compose facts should be retrievable through runtime topology and evidence detail levels, with environment hints when CAS provides them.
- WAS MUST report isolated deployables explicitly instead of forcing every app/service/site to connect. Isolated deployables are valid product facts and MAY be the correct result.
- WAS SHOULD identify known gaps as unmatched interfaces instead of silently omitting them.
- WAS SHOULD describe business/product value only from available CAS/WAS evidence and SHOULD mark low-confidence claims.
- AI enrichment is required for every default CAS/WAS analysis at the system/workspace level. Overall descriptions, domains, and primary capabilities MUST be AI-generated or AI-reviewed from deterministic evidence in the default summary pass. If AI cannot run, the artifact MUST expose `source: ai-required-degraded`, `ai_required: true`, `generation_pass: default-summary`, provider provenance, and a degraded reason. Deeper entity, critical-flow, deployable, interface, and node descriptions MAY be generated lazily. Individual function/node descriptions MAY remain optional/manual.
- AI text MUST reference deterministic evidence and MUST NOT create new graph facts.
- WAS MUST expose freshness/trust. Agents and APIs must be able to tell whether all CAS inputs are current, stale, missing required facts, or only partially trustworthy.
- WAS MUST support drilldown without duplicating repo-local details. Workspace objects should include stable project ids, deployable ids, interface ids, repo paths, and next MCP calls that point back to repo-level CAS tools.
- WAS SHOULD expose CAS distribution units at overview and evidence levels when they affect how agents should plan changes. A member deployable change SHOULD prompt agent guidance to inspect installer, release, service, desktop-entry, signing, or deployment artifacts before finalizing.
- WAS SHOULD expose workspace entity concepts and paths when repo-level CAS provides data entities, workflows, capabilities, lineage, or cross-repo flow evidence. Entity paths MUST cite repo-level CAS lineage/workflow/capability facts and SHOULD include `get_data_lineage` drilldown calls.
- When a member CAS has promoted to a Deployable-Analysis Workspace (docs/das/SPECIFICATION.md), WAS MUST consume that CAS's DAS units directly as the source of the corresponding `WorkspaceDeployable` entries' capabilities, flows, entities, and seams, carrying both the owning CAS's `codebase_id` and the DAS unit id (`source_das_unit_id`) — the three-hop provenance `workspace -> CAS (codebase_id) -> DAS (unit)`. When a member CAS has NOT promoted, WAS MUST fall back to building the `WorkspaceDeployable` from `deployable_evidence` and whole-CAS facts. This fallback MUST be silent to the schema: `WorkspaceDeployable` gains only the optional `source_das_unit_id` field and every other field is populated identically regardless of provenance.

### 7.1 Invariants

- **Reproducibility.** WAS MUST be derivable from the member CAS outputs alone — never a source-code read of its own. `WorkspaceValidation.source_code_read_required` MUST be `false`.
- **Deployable identity stability.** A `SystemApplication`/`WorkspaceDeployable` id MUST be derived deterministically from its identity-collision-guarded construction (see `cross-codebase-analysis.ts`'s `buildApplications`), never freshly minted per analysis run — re-analyzing an unchanged workspace MUST yield the same deployable ids.
- **No fabricated links.** Cross-repo HTTP links MUST NOT be inferred from a relative route alone; a consumer endpoint naming a concrete host or service alias MUST match that host/alias before route-shape compatibility can create a link. `evidence_quality` on every link/workflow/entity-path MUST honestly reflect its strongest supporting evidence tier (`source-backed` > `package-declared` > `topology-backed` > `route-shape-inferred` > `name-inferred`), never upgraded to make a payload look more confident.
- **Isolated is valid.** WAS MUST NOT manufacture a weak link to avoid reporting a deployable as isolated, and validation MUST NOT fail a workspace solely for having zero integration links.
- **Comprehension provenance.** `workspace_narrative`, `WorkspaceDomain.description`, `WorkspaceCapability.description`, and `WorkspaceWorkflow` descriptions MUST carry `source`/`description_source` of `ai` or `ai-required-degraded` — never `deterministic`. There is no deterministic workspace narrative (see docs/cas/DETERMINISM-BOUNDARY.md); a `deterministic_narrative` field MUST NOT be emitted.
- **Complexity determinism.** `workspace_complexity` and each member `CodebaseComplexity` MUST be computed with no AI call, no randomness, and no timestamp in the formula — the same CAS/WAS facts MUST always produce the same score.

## 8. Acceptance Examples (workspace shapes)

A conforming Workspace analysis should be able to express:

- an admin UI uses/administers the admin API; a client UI uses the user API.
- an MCP API is an agent or machine-to-machine control surface when CAS exposes MCP routes/modules/decorators.
- a workspace whose repos expose peer-to-peer/holepunch runtime facts plus a relay/coordinator service should express both the direct client/coordinator/agent P2P flows and the coordinator relay/fallback when CAS exposes those interface and runtime facts.
- a unit that receives agent/device messages and calls API surfaces is a broker.
- Redis can be reported as declared-but-unused when deployment/config facts exist but no source-level usage facts exist.
- a family of related UI/sync/link apps should be connected by concrete API, MCP, WebSocket, SDK, message, or runtime evidence.
- Klauro should dogfood itself by connecting MCP server, analyzer-core, marketing/deployable surfaces, hosted analyzer/runtime components, and stored analysis artifacts where CAS exposes those facts.

## 9. Validation

```typescript
interface WorkspaceValidation {
  conforms_to_was: boolean;
  missing_required_sections: string[];
  cas_inputs_validated: Array<{
    project_id: string;
    cas_analysis_id: string;
    status: 'valid' | 'stale' | 'missing-required-facts';
    missing_facts: string[];
  }>;
  relationship_coverage: {
    deployables_with_interfaces: number;
    unmatched_interface_count: number;
    linked_modes: Record<'sync' | 'async' | 'passive' | 'stream', number>;
  };
}
```

WAS validation fails when the workspace output is missing projects, deployables, runtime topology, unmatched interface reporting, evidence, summary, health, or narrative fields. WAS validation MUST NOT fail only because a workspace has zero integration links or zero interfaces; single-service, standalone, and disconnected workspaces are valid shapes when accurately reported.

Validation and truth quality are separate gates. Schema conformance answers "is this a WAS artifact?" Truth quality answers "is this current, source-backed, AI-enriched at the required level, and useful enough for agent use?"

## 10. MCP Contract

The MCP/API surface should include:

- `resolve_workspace_analysis`: select the best WAS for a path or set of paths.
- `get_workspace_summary`: retrieve compact narrative, capabilities, domains, health, risk, activity, telemetry, and freshness.
- `get_workspace_agent_context`: retrieve compact task-scoped workspace context for agents before cross-repo exploration.
- `get_workspace_freshness`: compare WAS inputs against current CAS analyses.
- `validate_was_contract`: score WAS contract conformance, freshness, and required AI enrichment.
- `get_workspace_health`, `get_workspace_risk_context`, `get_workspace_capability_map`, and `get_workspace_workflow`: retrieve focused whole-workspace views with repo-level drilldown calls.
- Repo-level `get_agent_context`, `get_idiom_aware_agent_context`, `open_agent_workbench`, and `preflight_agent_change` should accept an optional workspace analysis id so agents can carry WAS context while editing a specific CAS-backed project.
