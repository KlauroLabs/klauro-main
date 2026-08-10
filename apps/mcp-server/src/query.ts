import type {
  CASOutput, CASNode, CASEdge, CASEntryPoint, CASExitPoint,
  CASCallChain, CASMethodCall, CASDecorator, CASIntent,
  CASChangeRisk, ChangeRiskFactor, CASTemporalStability, CASFlowCoverage,
  CASTestSuite, ChangeHistoryEntry, ChangeAggregate, HeatMapData, ImpactAnalysis,
} from '../../../packages/analyzer-core/src/types/cas.types';
import { diffBehavior } from '../../../packages/analyzer-core/src/analyzer/core/behavior-diff';
import { ReachabilityIndex, reachabilityEdgePairs } from '../../../packages/analyzer-core/src/analyzer/core/reachability-index';
import { detectCommunities } from '../../../packages/analyzer-core/src/analyzer/core/community-detection';
import { findNearClones } from '../../../packages/analyzer-core/src/analyzer/core/minhash-clone-detection';
import { isAuthenticationGuardName } from '../../../packages/analyzer-core/src/analyzer/core/guard-classification';
import { buildProductMap, humanizeDomainSlug } from '../../../packages/analyzer-core/src/analyzer/core/product-map';
import { RISKABLE_NODE_TYPES } from '../../../packages/analyzer-core/src/analyzer/core/orchestrator';
import { buildTerminalSignal } from '../../../packages/analyzer-core/src/analyzer/core/terminal-signal';
import { selectProductFrameworkNames, analyzerTypeMap } from '../../../packages/analyzer-core/src/analyzer/core/framework-comprehension';
import { computeFlowConcepts, rankStoredFlowRefs, attachTelemetryToFlows, telemetryForNode, computeCapabilityTelemetry, unexercisedFlows, applyFlowRoleToCapabilityRelationships, type ComputeFlowConceptsOptions, type RuntimeMetricLike } from '../../../packages/analyzer-core/src/analyzer/core/flow-concepts';
import { computeSemanticCoverage, toCompactSemanticCoverage, type SemanticCoverage } from '../../../packages/analyzer-core/src/analyzer/core/semantic-coverage';
import { computeFlowStructuralLinks, computeConflictBehavioralLinks } from '../../../packages/analyzer-core/src/analyzer/core/structural-cross-links';
import type { CASProductMap } from '../../../packages/analyzer-core/src/types/cas.types';
import { buildSystemFitSummary, buildCommunicationSeamSummary } from './context-fabric';
import {
  buildDomainConceptIndex,
  buildEntityRelationIndex,
  classifyEntityRole,
  classifyFlowRole,
  type SemanticRole,
} from './semantic-roles';
import {
  displayJourneySteps,
  guardPhraseForBoundaries,
  journeyDetailMarkdown,
  journeyHeadline,
  journeyListMarkdown,
  journeyStepPhrase,
  journeyTitle,
  storedJourneyNameHeadline,
  storedJourneyNameParts,
} from './journey-presentation';
import {
  loadChangeHistory,
  getChangeHistoryEntry,
  listAnalysisSnapshots,
  loadAnalysisSnapshot,
  getAnalysisAt as getStorageAnalysisAt,
  compareCasVersions,
  describeAnalysisVersion,
} from './storage';

export const PILLAR_ATTESTED_CAS_VERSION = '1.11.0';

export function analysisVersionNotice(
  cas: CASOutput,
  featureLabel: string,
  attestedSince: string = PILLAR_ATTESTED_CAS_VERSION
): string | undefined {
  const stored = cas.cas_version || '0.0.0';
  if (compareCasVersions(stored, attestedSince) >= 0) return undefined;
  return `This analysis (cas_version ${stored}) predates ${featureLabel}, which is guaranteed from CAS ${attestedSince}. Re-run analyze_codebase on this project to generate it.`;
}

/**
 * Cheap orient capsule (progressive disclosure, task-3): a near-zero-token
 * index of WHAT Klauro knows about this system and WHICH tool pulls each
 * dimension. Reports availability + a count per dimension WITHOUT any heavy
 * content, so a caller learns what is pullable before spending tokens. This is
 * the "map" — the dimension tools (get_route_table, get_cicd_pipelines, …) are
 * the "detail" pulled on demand. Distinct from get_system_overview's
 * system_fit (a seams+topology narrative); this is a pure pullable-index.
 */
export function buildOrientCapsule(cas: CASOutput) {
  const nodes = cas.nodes || [];
  const countType = (type: string) => nodes.filter(node => node.type === type).length;
  const seams = cas.communication_seams;
  const topology = (cas.product_map as any)?.runtime_topology;
  const dimension = (available: boolean, count: number, tool: string) => ({ available, count, tool });

  return {
    system: cas.system?.name,
    // `domain` is the PRODUCT domain and nothing else. It used to silently fall
    // back to system_purpose.primary_type — a structural artifact label — under
    // the same key, so the capsule could confidently report a domain in the very
    // same payload where primary_domain was null and get_product_map said
    // "unknown" (2026-07-27 comprehension audit). An agent reading the two
    // together could not tell which was true. Absence is now reported as
    // absence, with the provenance beside it, and the structural type keeps its
    // own name.
    domain: cas.enhanced_system_purpose?.primary_domain || null,
    domain_source: cas.enhanced_system_purpose?.domain_source || null,
    system_type: cas.system_purpose?.primary_type || null,
    // Each dimension: is it present, how many items, and the tool that pulls it.
    dimensions: {
      entry_points: dimension((cas.entry_points?.length || 0) > 0, cas.entry_points?.length || 0, 'get_entry_points'),
      routes: dimension((cas.route_table?.length || 0) > 0, cas.route_table?.length || 0, 'get_route_table'),
      exit_points: dimension((cas.exit_points?.length || 0) > 0, cas.exit_points?.length || 0, 'get_exit_points'),
      communication_seams: dimension(Boolean(seams), seams?.seams?.length || 0, 'get_communication_seams'),
      cicd_pipelines: dimension(countType('ci_pipeline') > 0, countType('ci_pipeline'), 'get_cicd_pipelines'),
      runtime_topology: dimension(Boolean(topology?.deployables?.length), topology?.deployables?.length || 0, 'get_product_map'),
      runtime_node_metrics: dimension(
        (cas.runtime_static_links?.length || 0) > 0,
        cas.runtime_static_links?.length || 0,
        'get_runtime_observations',
      ),
      data_entities: dimension((cas.data_entities?.length || 0) > 0, cas.data_entities?.length || 0, 'get_data_entities'),
      capabilities: dimension((cas.system_capabilities?.length || 0) > 0, cas.system_capabilities?.length || 0, 'get_summary'),
      // Behavior/registration surfaces (mcp_tool/rpc/command/event/message
      // engines) — navigation, not product purpose (docs/SEMANTIC-MODEL.md).
      // Structurally separate from `capabilities`: never core, never ranked,
      // never in top_capabilities, but still a real pullable dimension so
      // agents can find e.g. "the 207-tool MCP surface" without it crowding
      // out domain capabilities.
      behavior_surfaces: dimension((cas.behavior_surfaces?.length || 0) > 0, cas.behavior_surfaces?.length || 0, 'get_system_overview'),
      tests: dimension((cas.test_suites?.length || 0) > 0, cas.test_suites?.length || 0, 'get_test_summary'),
    },
    hint: 'Availability + counts only — call the named tool to pull each dimension. Heavy content is intentionally omitted from this capsule.',
  };
}

/**
 * Last-resort domain-entity surfacing for CAS shapes where the data-entity
 * extraction produced nothing but language analyzers DID type real domain
 * entities as nodes (type 'entity'/'model' or an 'entity' subcategory).
 * Mirrors buildDataEntities' kind-filter semantics: only analyzer-asserted
 * entity kinds count — plain structs/classes/DTO-shaped nodes are NOT
 * inflated in, and abstract shapes stay excluded.
 */
function entityKindNodeNames(nodes: CASOutput['nodes']): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const node of nodes || []) {
    if (node.subcategories?.includes('abstract')) continue;
    const type = String(node.type || '');
    const isEntityKind = type === 'entity' || type === 'model' || Boolean(node.subcategories?.includes('entity'));
    if (!isEntityKind) continue;
    const key = String(node.name || '').toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    names.push(node.name);
  }
  return names;
}

export function buildSummary(cas: CASOutput, opts: { detail?: 'compact' | 'full'; excludeSeams?: boolean } = {}) {
  const detail = opts.detail || 'compact';
  const nodesByType: Record<string, number> = {};
  for (const n of cas.nodes) {
    nodesByType[n.type] = (nodesByType[n.type] || 0) + 1;
  }

  const entryPointsByType: Record<string, number> = {};
  for (const ep of cas.entry_points || []) {
    entryPointsByType[ep.type] = (entryPointsByType[ep.type] || 0) + 1;
  }

  const techs = cas.system?.technologies;
  const inventory = cas.architecture_summary?.architectural_inventory;
  const primaryDomain = cas.enhanced_system_purpose?.primary_domain || null;
  const productTech = productTechSignals(cas);
  const versionInfo = describeAnalysisVersion(cas.cas_version);
  // Runtime opt-out: skip computing the seam summary when seams are excluded
  // (a real compute/token saving, not a blanked field).
  const seamSummary = opts.excludeSeams ? null : buildCommunicationSeamSummary(cas);

  // compact mode (default) drops the static, per-repo-invariant analysis_phases
  // prose (identical on every call, ~40% of the full payload per
  // docs/SPEC-RESPONSE-BUDGET.md) and trims architectural_patterns to
  // name/confidence/category (no guidance sentence) and a shorter slice.
  // full restores today's shape byte-for-byte.
  const architecturalPatterns = detail === 'full'
    ? cas.architecture_summary?.architectural_patterns?.slice(0, 12).map(pattern => ({
        name: pattern.name,
        confidence: pattern.confidence,
        category: pattern.category,
        guidance: pattern.guidance,
      })) || []
    : cas.architecture_summary?.architectural_patterns?.slice(0, 6).map(pattern => ({
        name: pattern.name,
        confidence: pattern.confidence,
        category: pattern.category,
      })) || [];

  return {
    name: cas.system?.name,
    type: cas.system?.type,
    // Client-derived (git shortlog/log at snapshot-build time, see
    // apps/mcp-server/src/remote-source.ts deriveRepoFacts) and stamped onto
    // cas.system server-side (remote-analyzer-service.ts stampRepoFacts).
    // Powers the app's Contributors / Codebase age stat cards
    // (apps/app/src/pages/codebase/CodebaseStats.tsx). Omitted (not a
    // zero/empty object) when the client could not derive it.
    ...(cas.system?.repo_facts ? { repo_facts: cas.system.repo_facts } : {}),
    cas_version: versionInfo.stored_version,
    // Content-production time of THIS analysis (set by the orchestrator when it
    // actually (re)computes; a no-op incremental preserves the prior value).
    // This is the release-gate freshness marker: it is the ONLY summary field
    // that reflects when the served content was produced. layers_ready.generated_at
    // now tracks the same instant, but analysis_timestamp is the canonical,
    // always-present source and is surfaced here at a stable, readable path so
    // GET /api/projects/{id}/analysis exposes freshness without the caller
    // digging into the layers ladder.
    analysis_timestamp: cas.analysis_timestamp || null,
    analysis_version_status: versionInfo.status,
    analysis_version_notice: versionInfo.status === 'older-compatible'
      ? `This analysis was produced by cas_version ${versionInfo.stored_version}; the server is at ${versionInfo.current_version}. Re-run analyze_codebase to populate fields added since (user journeys, data lineage, paradigm conformance, product map).`
      : undefined,
    // Primary source is the byte-ranked language mix (system.technologies.languages,
    // computed from real source bytes on disk so the true primary language sorts
    // first — see orchestrator.extractTechnologies). productTech (per-node product
    // signals) is only a fallback for the rare case where technologies is empty;
    // it is NOT byte-ranked and previously mis-ordered TypeScript behind trailing
    // markup files.
    languages: techs?.languages?.length ? techs.languages.map(l => l.name) : productTech.languages,
    frameworks: productTech.frameworks.length ? productTech.frameworks : techs?.frameworks?.map(f => f.name) || [],
    // Honesty about scope: nested git repositories under this root are
    // EXCLUDED from the analysis (deliberate submodule-ish boundary in the
    // walker — orchestrator.getNestedRepoIgnorePatterns). A wrapper repo whose
    // real code lives in nested repos must not present a handful of top-level
    // infra files as "the codebase" with no signal that the bulk was skipped
    // (live audit 2026-07-14: a benchmarked repo served 41 nodes with its
    // nested app/ui sub-repos silently missing).
    ...(techs?.nested_repositories?.length
      ? {
          nested_repositories_excluded: {
            count: techs.nested_repositories.length,
            repositories: techs.nested_repositories.map(repo => ({
              path: repo.path,
              ...(repo.primary_language ? { primary_language: repo.primary_language } : {}),
              source_files: repo.source_files,
            })),
            note: 'These nested git repositories were NOT analyzed as part of this codebase. Analyze each one separately (analyze_codebase on its path) or as a workspace (run_workspace_analysis) for full coverage.',
          },
        }
      : {}),
    primary_domain: primaryDomain,
    // Human-readable rendering of primary_domain for a leadership/onboarding
    // reader — see product-map.ts's humanizeDomainSlug. primary_domain itself
    // stays the stable kebab-case slug other tooling compares against.
    ...(humanizeDomainSlug(primaryDomain) ? { primary_domain_label: humanizeDomainSlug(primaryDomain) } : {}),
    description: cas.enhanced_system_purpose?.inferred_description || null,
    description_source: cas.enhanced_system_purpose?.description_source || null,
    // Honest terminal AI-comprehension state. 'error' means the L5 pass RAN
    // and FAILED (model call or grounding gate threw) — comprehension is
    // AI-only, so description stays null with no deterministic substitute.
    // Surfaced here so a reader (customer or validator) sees a
    // degraded-but-final analysis instead of inferring forever-pending from
    // description_source: null. Omitted when the marker is absent (legacy
    // stores / synchronous path).
    ...(cas.ai_enrichment ? { ai_enrichment: cas.ai_enrichment } : {}),
    ...(cas.ai_enrichment === 'error' && cas.ai_enrichment_error
      ? { ai_enrichment_error: cas.ai_enrichment_error }
      : {}),
    ...(detail === 'full' ? { analysis_phases: cas.analysis_phases || [] } : {}),
    architecture_type: cas.architecture_summary?.system_type || null,
    architectural_patterns: architecturalPatterns,
    pattern_balance: cas.architecture_summary?.pattern_balance || null,
    architectural_inventory_counts: inventory ? Object.fromEntries(
      Object.entries(inventory).map(([key, values]) => [key, Array.isArray(values) ? values.length : 0])
    ) : {},
    nodes: cas.nodes.length,
    nodes_by_type: nodesByType,
    edges: cas.edges.length,
    entry_points: cas.entry_points?.length || 0,
    entry_points_by_type: entryPointsByType,
    // The product's domain entities live in cas.data_entities (the full Camp-B
    // entity extraction — DTOs, domain shapes, ORM models, etc.). cas.database_schema
    // is a much narrower ORM/DDL-only view (e.g. 3 @Entity classes) that is NOT the
    // domain-entity surface the summary is meant to convey — reading it here reported
    // "3 entities" for a 202-entity codebase. Surface data_entities; fall back to the
    // database_schema names when the fuller extraction is absent; finally fall back
    // to entity-kind NODES: some repo shapes (e.g. Rust + shell + TS mixes) parse
    // real domain entities as type 'entity'/'model' nodes yet produce an empty
    // data_entities extraction, which mis-reported "0 entities" for codebases whose
    // own description names concrete entities.
    database_entities: (cas.data_entities?.length
      ? cas.data_entities.map(e => e.name)
      : cas.database_schema?.entities?.length
        ? cas.database_schema.entities.map(e => e.name)
        : entityKindNodeNames(cas.nodes)) || [],
    capabilities: cas.system_capabilities?.length || cas.flow_graph?.capabilities.length || 0,
    top_capabilities: cas.system_capabilities?.length
      ? [...cas.system_capabilities]
        .filter(c => c.category !== 'internal')
        .sort((a, b) => {
          const order = { critical: 0, high: 1, medium: 2, low: 3 };
          // Plumbing never leads: supporting/admin capabilities rank strictly
          // below core, whatever their criticality — a summary whose #1
          // capability is profile/session/config upkeep misrepresents what
          // the product was built for.
          const categoryRank = (capability: any) => capability.category === 'core' ? 0 : 1;
          const domainBias = (capability: any) =>
            primaryDomain && capability.related_domains?.some((domain: string) => domain.includes(primaryDomain) || primaryDomain.includes(domain))
              ? 0
              : 1;
          return categoryRank(a) - categoryRank(b) ||
            domainBias(a) - domainBias(b) ||
            order[a.criticality] - order[b.criticality] ||
            b.operations.length - a.operations.length;
        })
        .slice(0, 10)
        .map(c => c.name)
      : cas.flow_graph ? [...cas.flow_graph.capabilities]
        .sort((a, b) => b.signals.total_score - a.signals.total_score)
        .slice(0, 10)
        .map(c => c.name) : [],
    // NAVIGATION TIER, not purpose (SURFACES ARE NOT CAPABILITIES —
    // docs/SEMANTIC-MODEL.md purpose test): registration/behavior surfaces
    // (command / event-subscriber / message-handler / mcp_tool engines) are
    // listed separately, unranked, and never mixed into capabilities /
    // top_capabilities counts — agents use them to FIND handlers, not to
    // learn what the product is for. Omitted when the repo has none.
    ...(cas.behavior_surfaces?.length ? {
      behavior_surfaces: cas.behavior_surfaces.map(surface => ({
        name: surface.structural_label || surface.name,
        entry_points: surface.operations?.length || 0,
      })),
    } : {}),
    analyzers: cas.analyzer_contributions.map(c => c.analyzer_name),
    errors: cas.analysis_errors?.length || 0,
    // Compact communication-seam one-liner (N sync / N async / N passive) so the
    // FIRST orient call surfaces the integration shape. Omitted when no seams.
    ...(seamSummary ? { communication_seams: { headline: seamSummary.headline, counts: seamSummary.counts, level: seamSummary.level } } : {}),
    // Cheap orient capsule: the pullable-dimension index (availability + counts +
    // the tool that pulls each), so the FIRST orient call teaches what is
    // available at near-zero tokens without any heavy content.
    orient_capsule: buildOrientCapsule(cas),
    // Progressive-layering ladder (task #112): present only on a CAS produced
    // via the layered/progressive entrypoint (analyzeProjectLayered). Absent
    // on the plain analyze_codebase path, where every layer lands in one shot
    // and is implicitly complete — omitted rather than a fabricated "all
    // ready" so callers can tell "not layered" apart from "layered and done".
    ...(cas.layers_ready ? { layers_ready: cas.layers_ready } : {}),
    // Compact coverage projection: rollup ratios + unmapped counts only (the
    // full unmapped lists live in get_semantic_coverage).
    // Must stay under the L0 <2s budget gate: computeFlowConcepts is too slow
    // on a large flow set, so this field is only inlined when the flow set is
    // small enough to stay well under budget. Above that guard, omit it rather
    // than fabricate a partial/capped ratio — callers fall back to
    // get_semantic_coverage's full uncapped compute.
    ...(() => {
      const entryCount = cas.entry_points?.length || 0;
      const nodeCount = cas.nodes?.length || 0;
      // ~2.5ms/entry-point measured; 400 EPs ≈ ~1s, comfortably inside the budget.
      if (entryCount > 400 || nodeCount > 15000) {
        return { semantic_coverage_available: 'call get_semantic_coverage, or GET /api/projects/{id}/semantic-coverage over HTTP (omitted from summary: flow set too large to compute within the orient latency budget)' as const };
      }
      try {
        const flows = computeFlowConcepts(cas);
        return { semantic_coverage: toCompactSemanticCoverage(computeSemanticCoverage(cas, flows)) };
      } catch {
        return {};
      }
    })(),
    ...(detail === 'compact' ? { detail: 'compact' as const } : {}),
  };
}

/**
 * getSemanticCoverage — the dedicated read tool payload (docs/SEMANTIC-MODEL.md
 * "Coverage invariants"). The three rollup ratios PLUS the full honest unmapped
 * lists (reachable code with no step, orphan steps, capability-less flows), each
 * capped for response budget with an explicit omitted count. Deterministic and
 * evidence-only — measured over the SAME full flow set get_flow_coverage uses
 * (computeFlowConcepts, no cap) so the ratios reflect the true rollup, not a
 * browse-capped slice.
 */
export function getSemanticCoverage(cas: CASOutput): SemanticCoverage {
  const flows = computeFlowConcepts(cas);
  return computeSemanticCoverage(cas, flows);
}

export interface SystemOverviewFilter {
  /** Omit runtime/telemetry fields (runtime, runtime_static_links_count). */
  excludeRuntime?: boolean;
  /** Omit the communication-seams portion of the dynamic system_fit view. */
  excludeSeams?: boolean;
  /** Omit the runtime-topology portion of the dynamic system_fit view. */
  excludeTopology?: boolean;
}

export function getSystemOverview(cas: CASOutput, opts: SystemOverviewFilter = {}) {
  const techs = cas.system?.technologies;
  const productTech = productTechSignals(cas);
  // "How it fits" — the vertical tying entry points -> deployables (bundled
  // ship-units collapsed) -> infra topology -> communication seams + CAP flags.
  // Additive: omitted entirely when none of those layers are present.
  // Runtime opt-out: system_fit is the seams+topology dynamic view, so skip
  // computing it when both are excluded (a real compute/token saving).
  const systemFit = opts.excludeSeams && opts.excludeTopology ? null : buildSystemFitSummary(cas);
  // Runtime opt-out: omit runtime/telemetry fields entirely for a pure static
  // view. Default keeps today's shape byte-for-byte.
  // Split so the include case preserves the original key order exactly
  // (runtime, validation, runtime_static_links_count) — byte-for-byte with the
  // pre-opt-out shape.
  const runtimeField = opts.excludeRuntime ? {} : { runtime: cas.runtime || null };
  const runtimeLinksField = opts.excludeRuntime
    ? {}
    : { runtime_static_links_count: cas.runtime_static_links?.length || 0 };
  return {
    name: cas.system?.name,
    type: cas.system?.type,
    description: cas.system?.description,
    languages: productTech.languages.length
      ? productTech.languages.map(name => ({ name }))
      : techs?.languages?.map(l => ({ name: l.name, percentage: l.percentage })) || [],
    frameworks: productTech.frameworks.length
      ? productTech.frameworks.map(name => ({ name }))
      : techs?.frameworks?.map(f => ({ name: f.name, version: f.version })) || [],
    databases: techs?.databases || [],
    system_purpose: cas.system_purpose ? {
      primary_type: cas.system_purpose.primary_type,
      confidence: cas.system_purpose.confidence,
      evidence: cas.system_purpose.evidence?.slice(0, 5),
    } : null,
    enhanced_system_purpose: cas.enhanced_system_purpose ? {
      primary_domain: cas.enhanced_system_purpose.primary_domain,
      inferred_description: cas.enhanced_system_purpose.inferred_description,
      description_source: cas.enhanced_system_purpose.description_source,
      description_generation: cas.enhanced_system_purpose.description_generation,
      core_concepts: cas.enhanced_system_purpose.core_concepts?.slice(0, 10),
    } : null,
    analysis_phases: cas.analysis_phases || [],
    architecture_summary: cas.architecture_summary ? {
      system_type: cas.architecture_summary.system_type,
      total_files: cas.architecture_summary.total_files,
      layers: cas.architecture_summary.layers,
      architectural_patterns: cas.architecture_summary.architectural_patterns?.slice(0, 20),
      architectural_inventory: cas.architecture_summary.architectural_inventory,
      pattern_balance: cas.architecture_summary.pattern_balance,
    } : null,
    system_health: cas.system_health || null,
    capabilities_count: cas.system_capabilities?.length || 0,
    system_capabilities: cas.system_capabilities?.slice(0, 25).map(capability => ({
      id: capability.id,
      name: capability.name,
      description: capability.description,
      description_source: capability.description_source,
      description_generation: capability.description_generation,
      category: capability.category,
      criticality: capability.criticality,
      operation_count: capability.operations?.length || 0,
      related_entities: capability.related_entities,
      related_domains: capability.related_domains,
    })) || [],
    // Behavior/registration surfaces (mcp_tool/rpc/command/event/message
    // engines) — the navigation tier, NOT product-purpose capabilities
    // (docs/SEMANTIC-MODEL.md). Deliberately separate from system_capabilities
    // so a surface can never rank/outrank a domain capability, while
    // remaining fully browsable in full-detail get_summary.
    behavior_surfaces_count: cas.behavior_surfaces?.length || 0,
    behavior_surfaces: cas.behavior_surfaces?.slice(0, 25).map(surface => ({
      id: surface.id,
      name: surface.name,
      structural_label: surface.structural_label,
      description: surface.description,
      operation_count: surface.operations?.length || 0,
      related_entities: surface.related_entities,
      related_domains: surface.related_domains,
    })) || [],
    repository_links: cas.repository_links || cas.cross_repository_links || [],
    disclosure: cas.disclosure || null,
    configuration: cas.configuration || null,
    ...runtimeField,
    validation: cas.validation || null,
    ...runtimeLinksField,
    analysis_facts_count: cas.analysis_facts?.length || 0,
    codebase_idioms_count: cas.codebase_idioms?.length || 0,
    idiom_summary: cas.idiom_summary || null,
    levels: cas.progressive_levels?.level_definitions?.map(l => ({
      level: l.level,
      name: l.name,
      node_count: l.node_count,
    })) || [],
    analyzers: cas.analyzer_contributions?.map(c => ({
      name: c.analyzer_name,
      nodes: c.nodes_contributed || c.nodes_created || 0,
      edges: c.edges_contributed || c.edges_created || 0,
    })) || [],
    errors: cas.analysis_errors?.length || 0,
    error_summary: cas.analysis_errors?.slice(0, 5).map(e => ({
      severity: e.severity,
      message: e.message,
    })) || [],
    ...(systemFit ? { system_fit: systemFit } : {}),
  };
}

function trimEdge(e: CASEdge) {
  return {
    id: e.id,
    source: e.source,
    target: e.target,
    type: e.type,
    metadata: e.metadata ? {
      weight: e.metadata.weight,
      confidence: e.metadata.confidence,
      async: e.metadata.async,
      conditional: e.metadata.conditional,
      attributes: e.metadata.attributes,
    } : undefined,
  };
}

function normalizeFilePathForMatch(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/^\.\//, '');
}

function pathsReferToSameFile(left: string, right: string): boolean {
  const normalizedLeft = normalizeFilePathForMatch(left);
  const normalizedRight = normalizeFilePathForMatch(right);

  return normalizedLeft === normalizedRight ||
    normalizedLeft.endsWith(`/${normalizedRight}`) ||
    normalizedRight.endsWith(`/${normalizedLeft}`);
}

function splitCamelCase(str: string): string[] {
  return str
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[-_./]/g, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

function matchesWordBoundary(name: string, queryWords: string[]): boolean {
  const nameWords = splitCamelCase(name);
  return queryWords.every(qw => nameWords.some(nw => nw.includes(qw)));
}

const SEARCH_STOPWORDS = new Set([
  'a', 'an', 'the', 'of', 'on', 'in', 'to', 'for', 'with', 'and', 'or', 'is',
  'are', 'that', 'this', 'where', 'do', 'we', 'from', 'into', 'until', 'by',
  'before', 'given', 'as', 'at', 'it', 'its', 'their', 'your', 'be', 'has',
]);

function searchTokens(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_\-./]/g, ' ')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function nodeSearchableText(node: CASNode): string {
  return [
    node.name,
    node.qualified_name ?? '',
    node.description ?? '',
    node.documentation?.raw ?? '',
    (node.comments ?? []).map(comment => comment.text).join(' '),
  ].join(' ');
}

const SEARCH_TYPE_PRIORITY: Record<string, number> = {
  class: 0, service: 0, controller: 0, module: 0, gateway: 0,
  function: 1, method: 1, custom_hook: 1, functional_component: 1, react_page: 1,
  entity: 2, repository: 2, guard: 2, middleware: 2, interceptor: 2, dto: 2,
  variable: 3, constant_util: 3, property: 3, function_util: 3,
  import: 4,
};

function searchTypeRank(type: string): number {
  return SEARCH_TYPE_PRIORITY[type] ?? 3;
}

// Lower is better, matching the sort convention below. 0 = exact name or
// qualified_name match, 1 = name starts with the query, 2 = name contains it
// anywhere, 3 = the match came only from qualified_name/description text.
function nameMatchRank(node: CASNode, queryLower: string): number {
  const nameLower = node.name.toLowerCase();
  if (nameLower === queryLower || node.qualified_name?.toLowerCase() === queryLower) return 0;
  if (nameLower.startsWith(queryLower)) return 1;
  if (nameLower.includes(queryLower)) return 2;
  return 3;
}

function nodeLanguageSignal(node: CASNode): string {
  // Language analyzers do not all stamp a single `metadata.language` field: the
  // TypeScript/JavaScript analyzer (the dominant source in a JS/TS repo) stamps
  // `metadata.isTypeScript` + `metadata.extension` and leaves `language` unset,
  // while only the breadth/tree-sitter analyzers set `metadata.language`. Reading
  // `metadata.language` alone therefore silently drops TypeScript and surfaces
  // only the trailing markup/shell files (the historic `[shell,html,css,glimmer]`
  // summary that hid a 99.9%-TypeScript codebase). Derive the label from whichever
  // reliable signal the producing analyzer actually set.
  // `isTypeScript`/`extension` are stamped at analysis time by the TS/JS analyzer
  // but are not part of the declared CASNode metadata shape, so read them off a
  // widened view rather than the typed surface.
  const meta = (node.metadata || {}) as Record<string, unknown>;
  const explicit = String(meta.language || '').trim();
  if (explicit) return normalizeTechLabel(explicit);
  if (meta.isTypeScript === true) return 'TypeScript/JavaScript';
  const ext = String(meta.extension || '').trim().toLowerCase().replace(/^\./, '');
  if (ext === 'ts' || ext === 'tsx' || ext === 'js' || ext === 'jsx' || ext === 'mjs' || ext === 'cjs') {
    return 'TypeScript/JavaScript';
  }
  return '';
}

function productTechSignals(cas: CASOutput): { languages: string[]; frameworks: string[] } {
  const languages = new Set<string>();
  for (const node of cas.nodes || []) {
    if (!isPrimaryProductNodeForQuery(node)) continue;
    const language = nodeLanguageSignal(node);
    if (language) languages.add(language);
  }
  // Frameworks go through the SAME comprehension gate the orchestrator uses to
  // seed the description (framework-analyzer + product-path + application-surface),
  // so summary.frameworks — the field the description cites — no longer reports
  // adapter shims (django/fastapi from an SDK) or library category labels
  // ("authentication and authorization") as frameworks the system is built with.
  const frameworks = selectProductFrameworkNames(
    cas.nodes || [],
    analyzerTypeMap(cas.analyzer_contributions || []),
    node => isPrimaryProductNodeForQuery(node as CASNode),
    10,
  ).filter(name => !isTestFramework(name)).map(normalizeTechLabel);
  return {
    languages: Array.from(languages).filter(Boolean).slice(0, 8),
    frameworks: Array.from(new Set(frameworks)).filter(Boolean).slice(0, 10),
  };
}

function normalizeTechLabel(value: string): string {
  const lower = value.toLowerCase();
  if (lower === 'typescript' || lower === 'javascript') return 'TypeScript/JavaScript';
  if (lower === 'dart') return 'Dart/Flutter';
  if (lower === 'csharp' || lower === 'c#') return 'C#';
  return value;
}

function isTestFramework(value: string): boolean {
  return /\b(jest|vitest|mocha|cypress|playwright|pytest|xunit|junit)\b/i.test(value);
}

function isPrimaryProductNodeForQuery(node: CASNode): boolean {
  if (node.metadata?.is_test || node.metadata?.is_generated) return false;
  const normalized = (node.source?.file || node.name || '').replace(/\\/g, '/').toLowerCase();
  if (!normalized) return true;
  if (/(^|\/)(node_modules|dist|build|coverage|vendor|vendors|generated|fixtures?|__fixtures__|__mocks__)(\/|$)/.test(normalized)) return false;
  if (/(^|\/)(__tests__|tests?|spec|e2e|cypress|playwright)(\/|$)/.test(normalized)) return false;
  if (/\.(test|spec|stories|story)\.[a-z0-9]+$/.test(normalized)) return false;
  if (/^legacy\//.test(normalized)) return false;
  return true;
}

export function searchNodes(
  cas: CASOutput,
  query: string,
  opts: { type?: string; category?: string; level?: number; limit?: number } = {}
) {
  const limit = opts.limit || 25;
  const queryLower = query.toLowerCase();
  const queryWords = queryLower.split(/\s+/).filter(Boolean);
  const isMultiWord = queryWords.length > 1;
  const contentWords = queryWords.filter(
    word => word.length > 1 && !SEARCH_STOPWORDS.has(word)
  );

  const exact: CASNode[] = [];
  const overlapping: Array<{ node: CASNode; overlap: number }> = [];

  for (const node of cas.nodes) {
    if (opts.type && node.type !== opts.type) continue;
    if (opts.category && node.category !== opts.category) continue;
    if (opts.level !== undefined && node.level !== opts.level) continue;

    const directMatch = node.name.toLowerCase().includes(queryLower) ||
      (node.qualified_name && node.qualified_name.toLowerCase().includes(queryLower)) ||
      (node.description && node.description.toLowerCase().includes(queryLower));
    const camelMatch = isMultiWord && (
      matchesWordBoundary(node.name, queryWords) ||
      (node.qualified_name ? matchesWordBoundary(node.qualified_name, queryWords) : false)
    );

    if (directMatch || camelMatch) {
      exact.push(node);
      continue;
    }

    if (contentWords.length > 0) {
      const tokens = new Set(searchTokens(nodeSearchableText(node)));
      let overlap = 0;
      for (const word of contentWords) {
        if (tokens.has(word)) overlap += 1;
      }
      if (overlap > 0) overlapping.push({ node, overlap });
    }
  }

  // Within the exact bucket, put true symbol-name matches ahead of
  // description/qualified-name substring hits: a node named exactly
  // "buildSummary" should rank above some unrelated node whose description
  // merely happens to mention "build summary" or share its type priority.
  exact.sort((a, b) => nameMatchRank(a, queryLower) - nameMatchRank(b, queryLower)
    || searchTypeRank(a.type) - searchTypeRank(b.type));
  overlapping.sort(
    (a, b) => b.overlap - a.overlap || searchTypeRank(a.node.type) - searchTypeRank(b.node.type)
  );

  const ranked = [...exact, ...overlapping.map(entry => entry.node)];

  return ranked.slice(0, limit).map(n => ({
    id: n.id,
    name: n.name,
    type: n.type,
    qualified_name: n.qualified_name,
    category: n.category,
    level: n.level,
    level_name: n.level_name,
    file: n.source?.file,
    line: n.source?.line,
    description: n.description,
    tags: n.tags,
  }));
}

export function getNode(cas: CASOutput, nodeId: string) {
  const node = cas.nodes.find(n => n.id === nodeId);
  if (!node) return null;

  const incomingEdges = cas.edges.filter(e => e.target === nodeId).map(trimEdge);
  const outgoingEdges = cas.edges.filter(e => e.source === nodeId).map(trimEdge);
  const relatedEntryPoints = (cas.entry_points || []).filter(ep =>
    ep.source_node === nodeId || ep.handler?.node_id === nodeId || ep.connected_nodes?.includes(nodeId)
  );
  const relatedExitPoints = (cas.exit_points || []).filter(ep =>
    ep.source_node === nodeId || ep.connected_nodes?.includes(nodeId)
  );
  const decorators = (cas.decorators || []).filter(d => d.target_node === nodeId);
  const intent = (cas.intents || []).find(i => i.node_id === nodeId);
  const changeRisk = (cas.change_risks || []).find(r => r.node_id === nodeId);
  const stability = (cas.temporal_stability || []).find(s => s.node_id === nodeId);

  const children = node.children
    ? cas.nodes.filter(n => node.children!.includes(n.id)).map(n => ({
        id: n.id, name: n.name, type: n.type, level: n.level,
      }))
    : [];

  return {
    ...node,
    incoming_edges: incomingEdges,
    outgoing_edges: outgoingEdges,
    entry_points: relatedEntryPoints,
    exit_points: relatedExitPoints,
    decorators,
    intent,
    change_risk: changeRisk,
    stability,
    resolved_children: children,
  };
}

export function getFileNodes(cas: CASOutput, filePath: string, projectPath?: string) {
  const normalizedPath = filePath.replace(/\\/g, '/');
  const fileNodes = cas.nodes.filter(n =>
    n.source?.file && n.source.file.replace(/\\/g, '/').endsWith(normalizedPath)
  );

  const nodeIds = new Set(fileNodes.map(n => n.id));
  const internalEdges = cas.edges.filter(e =>
    nodeIds.has(e.source) && nodeIds.has(e.target)
  ).map(trimEdge);

  // Empty result is ambiguous: a wrong path vs. a real file that simply isn't in
  // the analyzed revision (e.g. it lives on an unmerged worktree branch). When the
  // file DOES exist on disk but has no analyzed nodes, say so explicitly and stamp
  // the analyzed revision — this is exactly the trust-then-verify gap agents hit.
  let hint: string | undefined;
  if (fileNodes.length === 0) {
    const rev = cas.system?.repository;
    const revStamp = rev?.commit || rev?.branch ? ` (analysis @ ${[rev?.branch, rev?.commit?.slice(0, 8)].filter(Boolean).join('/')})` : '';
    let onDisk = false;
    if (projectPath) {
      try { onDisk = require('fs').existsSync(require('path').resolve(projectPath, filePath)); } catch { /* ignore */ }
    }
    hint = onDisk
      ? `0 nodes — this file exists in the working tree but is not present in the analyzed revision${revStamp}; your working tree may differ. Re-analyze the current branch to include it.`
      : `0 nodes — no analyzed file matches "${filePath}"${revStamp}. Check the path, or the file may not be in the analyzed revision.`;
  }

  return {
    nodes: fileNodes.map(n => ({
      id: n.id, name: n.name, type: n.type, category: n.category,
      level: n.level, line: n.source?.line, end_line: n.source?.end_line,
      description: n.description, parent: n.parent, children: n.children,
    })),
    edges: internalEdges,
    ...(hint ? { hint, analyzed_revision: cas.system?.repository } : {}),
  };
}

export function getEntryPoints(cas: CASOutput, opts: { type?: string; limit?: number; offset?: number } = {}) {
  let points = cas.entry_points || [];
  if (opts.type) points = points.filter(ep => ep.type === opts.type);
  const total = points.length;
  const limit = opts.limit || 50;
  const offset = opts.offset || 0;
  return { total, offset, limit, entry_points: points.slice(offset, offset + limit) };
}

export function getExitPoints(cas: CASOutput, opts: { type?: string; limit?: number; offset?: number } = {}) {
  let points = cas.exit_points || [];
  if (opts.type) points = points.filter(ep => ep.type === opts.type);
  const total = points.length;
  const limit = opts.limit || 50;
  const offset = opts.offset || 0;
  return { total, offset, limit, exit_points: points.slice(offset, offset + limit) };
}

export function getCommunicationSeams(
  cas: CASOutput,
  opts: { modality?: 'sync' | 'async' | 'passive'; level?: 'node' | 'deployable' | 'workspace'; limit?: number; offset?: number } = {},
) {
  const seamsResult = cas.communication_seams;
  if (!seamsResult) {
    return {
      analysis_version_notice: analysisVersionNotice(cas, 'communication seams'),
      total: 0,
      inventory: { level: 'node', counts: { sync: 0, async: 0, passive: 0, total: 0 }, component_seams: [] },
      seams: [],
    };
  }
  const level = opts.level || 'node';
  const inventory =
    level === 'deployable' && seamsResult.deployable_inventory
      ? seamsResult.deployable_inventory
      : seamsResult.inventory;
  let seams = seamsResult.seams;
  if (opts.modality) seams = seams.filter(s => s.modality === opts.modality);
  const total = seams.length;
  const limit = opts.limit || 50;
  const offset = opts.offset || 0;
  return {
    total,
    offset,
    limit,
    level,
    // System-level breakdown of every classified seam.
    inventory,
    seams: seams.slice(offset, offset + limit),
  };
}

export function getRouteTable(cas: CASOutput, opts: { limit?: number; offset?: number; method?: string } = {}) {
  let routes = cas.route_table || [];
  if (opts.method) routes = routes.filter((r: any) => r.method?.toUpperCase() === opts.method!.toUpperCase());
  const total = routes.length;
  const limit = opts.limit || 50;
  const offset = opts.offset || 0;
  return { total, offset, limit, routes: routes.slice(offset, offset + limit) };
}

/**
 * First-class read surface for the CI/CD facts the CiPipelineAnalyzer already
 * emitted into the CAS graph. It does NOT recompute anything: it assembles the
 * pipeline -> stage/job -> step -> trigger -> deploy-target hierarchy plus the
 * inter-job DAG purely from the stored `ci_pipeline` / `ci_stage` / `ci_job` /
 * `ci_step` / `deploy_target` nodes, the `contains` / `depends_on` /
 * `deploys_to` edges, and the pipeline entry points. Mirrors getRouteTable /
 * getEntryPoints: a cheap map first (paginated pipelines with counts), heavy
 * detail (every step's command/action/env/secret refs) pulled on demand.
 */
export function getCicdPipelines(
  cas: CASOutput,
  opts: { provider?: string; deployOnly?: boolean; limit?: number; offset?: number } = {},
) {
  const nodes = cas.nodes || [];
  const edges = cas.edges || [];
  const nodesById = new Map(nodes.map(node => [node.id, node]));

  const attrs = (node: CASNode | undefined): Record<string, any> =>
    (node?.metadata as any)?.attributes || {};

  // contains: parent -> child (pipeline->stage/job, stage->job, job->step)
  // deploys_to: step -> deploy_target
  // depends_on: job -> job (the DAG) and stage -> stage (ordering)
  const containsChildren = new Map<string, string[]>();
  const deploysTo = new Map<string, string[]>();
  const dependsOn = new Map<string, Array<{ target: string; reason?: string; dependency?: string }>>();
  for (const edge of edges) {
    if (edge.type === 'contains') {
      (containsChildren.get(edge.source) || containsChildren.set(edge.source, []).get(edge.source)!).push(edge.target);
    } else if (edge.type === 'deploys_to') {
      (deploysTo.get(edge.source) || deploysTo.set(edge.source, []).get(edge.source)!).push(edge.target);
    } else if (edge.type === 'depends_on') {
      const meta = (edge.metadata as any) || {};
      (dependsOn.get(edge.source) || dependsOn.set(edge.source, []).get(edge.source)!).push({
        target: edge.target,
        reason: meta.reason,
        dependency: meta.dependency,
      });
    }
  }

  const childNodesOfType = (parentId: string, type: string): CASNode[] =>
    (containsChildren.get(parentId) || [])
      .map(id => nodesById.get(id))
      .filter((node): node is CASNode => Boolean(node) && node!.type === type);

  const buildStep = (step: CASNode) => {
    const a = attrs(step);
    const deployTargets = (deploysTo.get(step.id) || [])
      .map(id => nodesById.get(id)?.name || id)
      .filter(Boolean);
    return {
      id: step.id,
      name: step.name,
      file: step.source?.file,
      line: step.source?.line,
      command: a.command,
      action: a.action,
      deploy_target: a.deploy_target,
      env_refs: a.env_refs || [],
      secret_refs: a.secret_refs || [],
      ...(deployTargets.length ? { deploys_to: deployTargets } : {}),
    };
  };

  const buildJob = (job: CASNode) => {
    const a = attrs(job);
    const deps = (dependsOn.get(job.id) || [])
      .map(dep => ({ job: nodesById.get(dep.target)?.name || dep.target, node_id: dep.target, evidence: dep.dependency }))
      .filter(dep => nodesById.get(dep.node_id)?.type === 'ci_job');
    return {
      id: job.id,
      name: job.name,
      file: job.source?.file,
      line: job.source?.line,
      stage: a.stage,
      environment: a.environment,
      needs: a.needs || [],
      requires: a.requires || [],
      rules: a.rules || [],
      env_refs: a.env_refs || [],
      secret_refs: a.secret_refs || [],
      depends_on: deps,
      steps: childNodesOfType(job.id, 'ci_step').map(buildStep),
    };
  };

  const pipelineNodes = nodes.filter(node => node.type === 'ci_pipeline');
  let pipelines = pipelineNodes.map(pipeline => {
    const a = attrs(pipeline);
    const provider = a.provider as string | undefined;
    const jobs = childNodesOfType(pipeline.id, 'ci_job').map(buildJob);
    const stages = childNodesOfType(pipeline.id, 'ci_stage').map(stage => {
      const sa = attrs(stage);
      return {
        id: stage.id,
        name: stage.name,
        file: stage.source?.file,
        line: stage.source?.line,
        jobs: (sa.jobs || []).map((id: string) => nodesById.get(id)?.name || id),
      };
    });
    // Triggers live on pipeline entry points (type pipeline/schedule) whose
    // container (source_node) is this pipeline node.
    const triggers = (cas.entry_points || [])
      .filter(ep => ep.source_node === pipeline.id)
      .map(ep => ({
        type: ep.type,
        event: ep.trigger?.event || ep.name,
        schedule: ep.trigger?.schedule,
        file: ep.handler?.file || (ep.metadata as any)?.file,
        line: ep.handler?.line || (ep.metadata as any)?.line,
      }));
    // Fall back to the trigger events recorded on the pipeline node itself
    // (always present) when no entry point resolved to this pipeline.
    const triggerFallback = triggers.length ? triggers : (a.triggers || []).map((event: string) => ({ type: 'pipeline', event }));
    // Job DAG: edges among this pipeline's jobs only.
    const jobIds = new Set(jobs.map(job => job.id));
    const dag = jobs.flatMap(job =>
      (dependsOn.get(job.id) || [])
        .filter(dep => jobIds.has(dep.target))
        .map(dep => ({ from: job.name, to: nodesById.get(dep.target)?.name || dep.target })),
    );
    const deployTargets = jobs
      .flatMap(job => job.steps)
      .flatMap(step => step.deploys_to || [])
      .filter((value, index, arr) => arr.indexOf(value) === index);
    return {
      id: pipeline.id,
      name: pipeline.name,
      provider,
      file: pipeline.source?.file,
      triggers: triggerFallback,
      stage_count: stages.length,
      job_count: jobs.length,
      step_count: jobs.reduce((sum, job) => sum + job.steps.length, 0),
      deploy_targets: deployTargets,
      job_dag: dag,
      stages,
      jobs,
    };
  });

  if (opts.provider) pipelines = pipelines.filter(p => p.provider === opts.provider);
  if (opts.deployOnly) pipelines = pipelines.filter(p => p.deploy_targets.length > 0);

  const total = pipelines.length;
  const limit = opts.limit || 20;
  const offset = opts.offset || 0;
  const providers = Array.from(new Set(pipelineNodes.map(p => attrs(p).provider).filter(Boolean)));

  return {
    analysis_version_notice: total === 0 ? analysisVersionNotice(cas, 'first-class CI/CD pipeline facts') : undefined,
    total,
    offset,
    limit,
    providers,
    inventory: {
      pipelines: total,
      jobs: pipelines.reduce((sum, p) => sum + p.job_count, 0),
      steps: pipelines.reduce((sum, p) => sum + p.step_count, 0),
      deploy_targets: nodes.filter(node => node.type === 'deploy_target').length,
    },
    pipelines: pipelines.slice(offset, offset + limit),
  };
}

export function getExternalServices(cas: CASOutput) {
  return cas.external_services || [];
}

export function getCallers(cas: CASOutput, nodeId: string, maxDepth: number = 2, limit: number = 50) {
  const visited = new Set<string>();
  // Tracks node ids already pushed into `callers` (independent of `visited`,
  // which gates *traversal from* a node). A node can be reached both via a
  // graph edge and via a method_call record at the same depth (e.g. a normal
  // call edge plus a duplicate method-call record for the same call site) —
  // without this set the same caller would be pushed twice.
  const pushed = new Set<string>();
  const callers: Array<{ node_id: string; name: string; type: string; depth: number; via: string }> = [];
  const nodesById = new Map(cas.nodes.map(node => [node.id, node]));
  const incomingEdges = new Map<string, typeof cas.edges>();
  for (const edge of cas.edges) {
    if (!incomingEdges.has(edge.target)) incomingEdges.set(edge.target, []);
    incomingEdges.get(edge.target)!.push(edge);
  }
  const incomingMethodCalls = new Map<string, NonNullable<CASOutput['method_calls']>>();
  for (const methodCall of cas.method_calls || []) {
    if (!methodCall.target_node) continue;
    if (!incomingMethodCalls.has(methodCall.target_node)) incomingMethodCalls.set(methodCall.target_node, []);
    incomingMethodCalls.get(methodCall.target_node)!.push(methodCall);
  }

  function traverse(currentId: string, depth: number) {
    if (depth > maxDepth || visited.has(currentId) || callers.length >= limit) return;
    visited.add(currentId);

    for (const edge of incomingEdges.get(currentId) || []) {
      if (callers.length >= limit) break;
      if (!visited.has(edge.source) && !pushed.has(edge.source)) {
        const sourceNode = nodesById.get(edge.source);
        if (sourceNode) {
          pushed.add(sourceNode.id);
          callers.push({
            node_id: sourceNode.id,
            name: sourceNode.name,
            type: sourceNode.type,
            depth,
            via: `edge:${edge.type}`,
          });
          traverse(sourceNode.id, depth + 1);
        }
      }
    }

    for (const mc of incomingMethodCalls.get(currentId) || []) {
      if (callers.length >= limit) break;
      if (mc.caller_node && !visited.has(mc.caller_node) && !pushed.has(mc.caller_node)) {
        const callerNode = nodesById.get(mc.caller_node);
        if (callerNode) {
          pushed.add(callerNode.id);
          callers.push({
            node_id: callerNode.id,
            name: callerNode.name,
            type: callerNode.type,
            depth,
            via: `method_call:${mc.call_details.method_name}`,
          });
          traverse(callerNode.id, depth + 1);
        }
      }
    }
  }

  traverse(nodeId, 1);
  return { total: callers.length, limit, truncated: callers.length >= limit, callers };
}

export function getCallees(cas: CASOutput, nodeId: string, maxDepth: number = 2, limit: number = 50) {
  const visited = new Set<string>();
  // See matching comment in getCallers: a node reachable via both a graph
  // edge and a method_call record at the same depth must only be pushed once.
  const pushed = new Set<string>();
  const callees: Array<{ node_id: string; name: string; type: string; depth: number; via: string }> = [];
  const nodesById = new Map(cas.nodes.map(node => [node.id, node]));
  const outgoingEdges = new Map<string, typeof cas.edges>();
  for (const edge of cas.edges) {
    if (!outgoingEdges.has(edge.source)) outgoingEdges.set(edge.source, []);
    outgoingEdges.get(edge.source)!.push(edge);
  }
  const outgoingMethodCalls = new Map<string, NonNullable<CASOutput['method_calls']>>();
  for (const methodCall of cas.method_calls || []) {
    if (!methodCall.caller_node) continue;
    if (!outgoingMethodCalls.has(methodCall.caller_node)) outgoingMethodCalls.set(methodCall.caller_node, []);
    outgoingMethodCalls.get(methodCall.caller_node)!.push(methodCall);
  }

  function traverse(currentId: string, depth: number) {
    if (depth > maxDepth || visited.has(currentId) || callees.length >= limit) return;
    visited.add(currentId);

    for (const edge of outgoingEdges.get(currentId) || []) {
      if (callees.length >= limit) break;
      if (!visited.has(edge.target) && !pushed.has(edge.target)) {
        const targetNode = nodesById.get(edge.target);
        if (targetNode) {
          pushed.add(targetNode.id);
          callees.push({
            node_id: targetNode.id,
            name: targetNode.name,
            type: targetNode.type,
            depth,
            via: `edge:${edge.type}`,
          });
          traverse(targetNode.id, depth + 1);
        }
      }
    }

    for (const mc of outgoingMethodCalls.get(currentId) || []) {
      if (callees.length >= limit) break;
      if (mc.target_node && !visited.has(mc.target_node) && !pushed.has(mc.target_node)) {
        const targetNode = nodesById.get(mc.target_node);
        if (targetNode) {
          pushed.add(targetNode.id);
          callees.push({
            node_id: targetNode.id,
            name: targetNode.name,
            type: targetNode.type,
            depth,
            via: `method_call:${mc.call_details.method_name}`,
          });
          traverse(targetNode.id, depth + 1);
        }
      }
    }
  }

  traverse(nodeId, 1);
  return { total: callees.length, limit, truncated: callees.length >= limit, callees };
}

export function getCallChain(cas: CASOutput, opts: { chainId?: string; entryPointId?: string; limit?: number; offset?: number }) {
  const chains = cas.call_chains || [];
  if (opts.chainId) return chains.find(c => c.id === opts.chainId) || null;
  const limit = opts.limit || 25;
  const offset = opts.offset || 0;
  if (opts.entryPointId) {
    const filtered = chains.filter(c => c.entry_point.entry_point_id === opts.entryPointId);
    return { total: filtered.length, offset, limit, chains: filtered.slice(offset, offset + limit) };
  }

  const summaries = chains.map(c => ({
    id: c.id,
    chain_type: c.chain_type,
    entry_point: c.entry_point,
    exit_point: c.exit_point,
    call_path_length: c.call_path?.length || 0,
    characteristics: c.characteristics,
    criticality: c.criticality,
    risk_level: c.risk_analysis?.risk_level,
  }));
  return { total: summaries.length, offset, limit, chains: summaries.slice(offset, offset + limit) };
}

export function getMethodCalls(cas: CASOutput, nodeId: string) {
  const calls = cas.method_calls || [];
  return {
    made_by: calls.filter(mc => mc.caller_node === nodeId),
    received_by: calls.filter(mc => mc.target_node === nodeId),
  };
}

export function getIntent(cas: CASOutput, nodeId: string) {
  return (cas.intents || []).find(i => i.node_id === nodeId) || null;
}

export function getDataEntities(
  cas: CASOutput,
  opts: { entityName?: string; limit?: number; offset?: number; role?: SemanticRole } = {}
) {
  let entities = cas.data_entities || [];
  if (opts.entityName) {
    entities = entities.filter(e =>
      e.name.toLowerCase().includes(opts.entityName!.toLowerCase())
    );
  }

  // Per-entity semantic role (core / supporting / infrastructure), classified
  // with the SAME evidence + logic as the workspace item classifier (shared
  // ./semantic-roles module), corroborated by the already-computed domain
  // concept classification (cas.domain_concepts[].classification) and the
  // entity's own lifecycle shape. Additive; omitted (`unknown`) when
  // unclassifiable. See docs/SPEC-CONCEPTUAL-LAYER.md role vocabulary.
  const conceptIndex = buildDomainConceptIndex(cas.domain_concepts);
  // Relation-pairing evidence for the integration-sync join-record check
  // (classifyEntityRole step 0): built once from the ORM relation graph
  // (cas.nodes/cas.edges), keyed by entity name, plus the set of domain
  // entity names in THIS dataset and their field lists — so a *ConnectionBind
  // -shaped entity can be told apart from a real domain entity without any
  // hardcoded per-entity name list.
  const relationIndex = buildEntityRelationIndex(cas);
  const domainEntityNamesLower = new Set((cas.data_entities || []).map(e => e.name.toLowerCase()));
  const fieldsByNameLower = new Map((cas.data_entities || []).map(e => [e.name.toLowerCase(), e.fields]));
  const roleByEntityId = new Map<string, { role?: SemanticRole; role_evidence: string[] }>();
  for (const e of entities) {
    roleByEntityId.set(e.id, classifyEntityRole(e, conceptIndex, {
      relations: relationIndex,
      domainEntityNamesLower,
      fieldsByNameLower,
    }));
  }

  // Optional role filter — apply BEFORE pagination so counts stay honest.
  if (opts.role) {
    entities = entities.filter(e => roleByEntityId.get(e.id)?.role === opts.role);
  }

  const total = entities.length;
  const limit = opts.limit || 25;
  const offset = opts.offset || 0;

  const roleBreakdown: Record<'core' | 'supporting' | 'infrastructure' | 'unknown', number> =
    { core: 0, supporting: 0, infrastructure: 0, unknown: 0 };
  for (const e of entities) {
    const r = roleByEntityId.get(e.id)?.role;
    roleBreakdown[r || 'unknown']++;
  }

  const summarized = entities.slice(offset, offset + limit).map(e => {
    const classification = roleByEntityId.get(e.id);
    const nameKey = e.name.toLowerCase();
    const dataRelations = relationIndex.dataByEntityNameLower.get(nameKey) || [];
    const structuralRelations = relationIndex.structuralByEntityNameLower.get(nameKey) || [];
    const relationFieldNames = relationIndex.relationFieldsByEntityNameLower.get(nameKey) || new Set<string>();
    return {
      id: e.id,
      name: e.name,
      schema_source: e.schema_source,
      // E1 entity_description.v1 (orchestrator applyAIInterpretation, last-stage
      // pass over the full evidence bundle): AI-only-or-absent, never a
      // deterministic placeholder — description stays undefined when the pass
      // hasn't run or the AI enrichment is skipped/degraded for this entity.
      description: e.description,
      description_source: e.description_source,
      role: classification?.role,
      role_evidence: classification?.role_evidence,
      field_count: e.fields?.length || 0,
      // A field that IS a relation is flagged rather than dropped: the column
      // is real and callers still need its name/type, but it must not read as
      // scalar state when a relation declaration or an entity-typed
      // declaration proves it is a foreign key. See `relations` below for the
      // relation itself (direction, cardinality, evidence).
      fields: (e.fields || []).slice(0, 10).map(f =>
        relationFieldNames.has(f.name) && !f.is_relation ? { ...f, is_relation: true } : f),
      relation_field_names: [...relationFieldNames],
      // DATA relations only — ORM associations (decorator, attribute, or
      // analyzer-emitted edge) and typed composition where a field's type IS
      // another extracted entity. Every entry cites the evidence that proves
      // it; a field whose NAME merely looks like a foreign key yields nothing.
      relations: dataRelations.slice(0, 25),
      relation_count: dataRelations.length,
      // STRUCTURAL relations (implements / uses_trait / extends) are a
      // SEPARATE field. They are legitimate — an entity implementing an
      // interface is a real edge — but they are not the data model, and they
      // used to be the only thing in `relations`, which made a persisted
      // entity look unrelated to everything it has a foreign key to.
      structural_relations: structuralRelations.slice(0, 10),
      structural_relation_count: structuralRelations.length,
      lifecycle_summary: {
        created_by_count: e.lifecycle?.created_by?.length || 0,
        read_by_count: e.lifecycle?.read_by?.length || 0,
        updated_by_count: e.lifecycle?.updated_by?.length || 0,
        deleted_by_count: e.lifecycle?.deleted_by?.length || 0,
        created_by_sample: (e.lifecycle?.created_by || []).slice(0, 3),
        read_by_sample: (e.lifecycle?.read_by || []).slice(0, 3),
        updated_by_sample: (e.lifecycle?.updated_by || []).slice(0, 3),
        deleted_by_sample: (e.lifecycle?.deleted_by || []).slice(0, 3),
      },
      transformation_count: e.transformations?.length || 0,
      invariant_count: e.invariants?.length || 0,
    };
  });

  return { total, offset, limit, role_breakdown: roleBreakdown, entities: summarized, data_summary: cas.data_summary };
}

export function getSecurityOverview(cas: CASOutput) {
  const boundaries = (cas.security_boundaries || []).map(b => ({
    id: b.id,
    name: b.name,
    boundary_type: b.boundary_type,
    trust_transition: b.trust_transition,
    enforcement_point_count: b.enforcement_points?.length || 0,
    enforcement_points_sample: (b.enforcement_points || []).slice(0, 5),
    sensitive_operation_count: b.sensitive_operations?.length || 0,
    bypass_risk_count: b.bypass_risks?.length || 0,
  }));

  const contexts = (cas.security_contexts || []).map(c => ({
    id: c.id,
    name: c.name,
    type: c.type,
    trust_level: c.trust_level,
    authentication: c.requirements?.authentication,
    authorization: c.requirements?.authorization,
    node_count: c.scope?.node_ids?.length || 0,
    node_sample: (c.scope?.node_ids || []).slice(0, 5),
  }));

  return {
    boundary_count: boundaries.length,
    security_boundaries: boundaries,
    security_summary: cas.security_summary || null,
    context_count: contexts.length,
    security_contexts: contexts,
  };
}

export function getBehavioralInvariants(
  cas: CASOutput,
  opts: { invariantType?: string; target?: string; limit?: number; offset?: number } = {}
) {
  let invariants = cas.behavioral_invariants || [];
  if (opts.invariantType) {
    invariants = invariants.filter(invariant => invariant.invariant_type === opts.invariantType);
  }
  if (opts.target) {
    const target = opts.target.toLowerCase();
    const targetNode = cas.nodes.find(node => node.id === opts.target);
    invariants = invariants.filter(invariant => {
      const scope = invariant.scope || {};
      const nodeMatch = scope.node_ids?.includes(opts.target!) ||
        (targetNode?.source?.file && scope.file_paths?.some(file => pathsCompatibleForBehavior(file, targetNode.source!.file!)));
      const text = [
        invariant.id,
        invariant.name,
        invariant.description,
        ...(scope.entity_names || []),
        ...(scope.field_names || []),
        ...(scope.file_paths || []),
      ].join(' ').toLowerCase();
      return Boolean(nodeMatch || text.includes(target));
    });
  }

  const limit = opts.limit || 25;
  const offset = opts.offset || 0;
  return {
    total: invariants.length,
    offset,
    limit,
    summary: cas.behavioral_invariant_summary || null,
    invariants: invariants.slice(offset, offset + limit).map(invariant => ({
      id: invariant.id,
      name: invariant.name,
      invariant_type: invariant.invariant_type,
      description: invariant.description,
      scope: invariant.scope,
      enforcement_summary: {
        enforced: invariant.enforcement.filter(point => point.confidence === 'enforced').length,
        inferred: invariant.enforcement.filter(point => point.confidence === 'inferred').length,
        missing: invariant.enforcement.filter(point => point.confidence === 'missing').length,
      },
      enforcement: invariant.enforcement.slice(0, 10),
      evidence: invariant.evidence.slice(0, 10),
      related_tests: invariant.related_tests,
      related_boundaries: invariant.related_boundaries,
      related_entities: invariant.related_entities,
      gaps: invariant.gaps || [],
      confidence: invariant.confidence,
    })),
  };
}

function pathsCompatibleForBehavior(left: string, right: string): boolean {
  const normalizedLeft = left.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
  const normalizedRight = right.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
  return normalizedLeft === normalizedRight || normalizedLeft.endsWith(`/${normalizedRight}`) || normalizedRight.endsWith(`/${normalizedLeft}`);
}

export function getStability(cas: CASOutput, nodeId?: string) {
  if (nodeId) {
    return (cas.temporal_stability || []).find(s => s.node_id === nodeId) || null;
  }
  const stability = cas.temporal_stability || [];
  const byClass: Record<string, number> = {};
  for (const s of stability) {
    byClass[s.stability_class] = (byClass[s.stability_class] || 0) + 1;
  }
  return {
    stability_summary: cas.stability_summary || null,
    total_nodes_tracked: stability.length,
    by_class: byClass,
  };
}

/**
 * Transitive affected set over the call graph (Workstream C,
 * docs/SPEC-MATHEMATICAL-INTELLIGENCE.md): every node whose behavior can be
 * affected when `nodeIds` change (direction 'upstream' = transitive callers,
 * the blast radius; 'downstream' = transitive callees; 'both' = undirected
 * closure). Uses the persisted reachability index when the analysis carries
 * one AND it's marked `includes_invokes_edges` (near-O(1) / O(answer));
 * falls back to a full BFS traversal over the SAME edge set
 * `reachabilityEdgePairs` defines ('calls' edges + resolved method_calls +
 * 'invokes' edges) on CAS revisions with no persisted index, or with one
 * stored before that flag existed — both paths return identical answers
 * (parity-tested). Gating on the flag (not presence alone) matters: an
 * analysis stored before task #100 carries an index built over 'calls' +
 * method_calls only, and reusing it unconditionally would silently narrow
 * the answer below what a fresh traversal (or a re-analysis) would report.
 * When `maxNodes` truncates, both paths return a bounded subset and flag
 * `truncated: true`; the untruncated closure is identical across paths.
 */
export function getAffectedSet(
  cas: CASOutput,
  nodeIds: string[],
  opts: { direction?: 'upstream' | 'downstream' | 'both'; maxNodes?: number } = {}
): { affected: string[]; truncated: boolean; method: 'reachability_index' | 'traversal' } {
  const direction = opts.direction ?? 'upstream';
  const maxNodes = opts.maxNodes ?? Infinity;

  if (cas.reachability_index?.includes_invokes_edges) {
    const idx = ReachabilityIndex.from(cas.reachability_index);
    const result = idx.affectedSet(nodeIds, { direction, maxNodes });
    return { ...result, method: 'reachability_index' };
  }

  // Traversal fallback: no persisted index, or one stored before
  // 'includes_invokes_edges' existed — BFS over the exact edge set a fresh
  // index would be built from, so answers match the up-to-date index path.
  const fwd = new Map<string, string[]>();
  const rev = new Map<string, string[]>();
  for (const [s, t] of reachabilityEdgePairs(cas)) {
    if (s === t) continue;
    if (!fwd.has(s)) fwd.set(s, []);
    fwd.get(s)!.push(t);
    if (!rev.has(t)) rev.set(t, []);
    rev.get(t)!.push(s);
  }
  const seeds = new Set(nodeIds);
  const visited = new Set<string>(seeds);
  const queue = [...seeds];
  while (queue.length > 0) {
    const v = queue.shift()!;
    const next = direction === 'downstream'
      ? (fwd.get(v) ?? [])
      : direction === 'upstream'
        ? (rev.get(v) ?? [])
        : [...(fwd.get(v) ?? []), ...(rev.get(v) ?? [])];
    for (const w of next) {
      if (!visited.has(w)) {
        visited.add(w);
        queue.push(w);
      }
    }
  }
  const affected = [...visited].filter(id => !seeds.has(id)).sort();
  const truncated = affected.length > maxNodes;
  return {
    affected: truncated ? affected.slice(0, maxNodes) : affected,
    truncated,
    method: 'traversal',
  };
}

function isTestOwnedRiskNode(node: CASNode | undefined): boolean {
  return !!node && (
    node.metadata?.is_test === true ||
    node.category === 'test' ||
    ['test', 'mock', 'test_double', 'test_fixture'].includes(node.type)
  );
}

/**
 * Score change risk for a SINGLE node on demand, when it is a riskable type
 * (function/method/service/controller/...) but buildChangeRisks left it out
 * of the precomputed `cas.change_risks` list — either because that pass caps
 * itself at the top 100 repo-wide, or because its "boring node" pre-filter
 * (few callers, not exported, not entry/data/repo/domain/critical) skipped
 * it as noise for a REPO-WIDE summary. Neither reason is valid grounds for
 * `assess_change_risk` to answer `null` when a caller asks about this ONE
 * specific node by id: the top-100/noise-filtering makes sense for a
 * repo-wide list, never for a targeted per-node question (defect #1,
 * 2026-08 blackbox demo: a real method's headline `risk` field came back
 * null while the transitive-impact data beneath it was excellent).
 *
 * Mirrors buildChangeRisks' non-git risk factors from CASOutput fields alone
 * (nodes/edges/entry_points/temporal_stability already on the analysis) — the
 * one factor buildChangeRisks derives from a live git.log() call
 * (`recent-bugs`) is instead read from cas.temporal_stability for this node
 * when present, and honestly omitted (not silently assumed absent) when it
 * is not. No node is ever dropped for having "too few" risk factors here —
 * zero factors is itself the honest answer 'low' risk, not a reason to
 * return nothing.
 */
function scoreChangeRiskOnDemand(cas: CASOutput, node: CASNode): CASChangeRisk {
  const nodesById = new Map(cas.nodes.map(n => [n.id, n]));
  const edges = cas.edges || [];

  const directCallers: string[] = [];
  let directlyTestCalled = false;
  let hasExternalDep = false;
  for (const edge of edges) {
    if (edge.target === node.id && (edge.type === 'calls' || edge.type === 'uses' || edge.type === 'depends_on')) {
      directCallers.push(edge.source);
      if (isTestOwnedRiskNode(nodesById.get(edge.source))) directlyTestCalled = true;
    }
    if (edge.source === node.id && (edge.type === 'external_call' || edge.category === 'external')) {
      hasExternalDep = true;
    }
  }

  const entryNodeIds = new Set<string>();
  const entryFiles = new Set<string>();
  for (const ep of cas.entry_points || []) {
    if (ep.source_node) entryNodeIds.add(ep.source_node);
    if (ep.handler?.node_id) entryNodeIds.add(ep.handler.node_id);
    if (ep.handler?.file) entryFiles.add(ep.handler.file.replace(/\\/g, '/').toLowerCase());
  }

  const file = node.source?.file?.replace(/\\/g, '/').toLowerCase() || '';
  const isEntryRelated = node.type === 'controller' || node.type === 'route' || node.type === 'handler' ||
    entryNodeIds.has(node.id) || (file && entryFiles.has(file));
  const isDataRelated = node.type === 'entity' || node.type === 'model' || node.type === 'serializer';
  const isRepository = node.type === 'repository' ||
    /repository|repo|dao|gateway|store/.test(`${node.type} ${node.name} ${file}`.toLowerCase());
  const isCriticalDomain = /\b(auth|oauth|token|password|permission|role|security|invoice|billing|payment|charge|subscription|fuel|vehicle|driver|trip|dispatch|maintenance|customer|partner)\b/i.test(`${node.name} ${file}`);
  const isSecuritySensitiveName = /\b(auth|oauth|token|password|permission|role|security|credential)\b/i.test(`${node.name} ${file}`);
  const nodeComplexity = node.metadata?.complexity?.cyclomatic || 0;
  const hasDirectTestCoverage = !!node.testing?.tested_by?.length || directlyTestCalled;

  const riskFactors: ChangeRiskFactor[] = [];
  if (directCallers.length > 10) {
    riskFactors.push({ factor: 'many-callers', severity: 'high', details: `Called by ${directCallers.length} functions` });
  } else if (directCallers.length > 5) {
    riskFactors.push({ factor: 'many-callers', severity: 'medium', details: `Called by ${directCallers.length} functions` });
  }

  if (isEntryRelated) {
    riskFactors.push({ factor: 'critical-path', severity: isCriticalDomain ? 'high' : 'medium', details: 'Entry-point or handler surface; changes can affect externally visible behavior' });
  }
  if (isDataRelated || isRepository) {
    riskFactors.push({ factor: 'critical-path', severity: isCriticalDomain ? 'high' : 'medium', details: 'Data model or data access surface; changes can affect persistence and downstream consumers' });
  }
  if (nodeComplexity > 20) {
    riskFactors.push({ factor: 'complex-logic', severity: 'high', details: `Cyclomatic complexity: ${nodeComplexity}` });
  } else if (nodeComplexity > 10) {
    riskFactors.push({ factor: 'complex-logic', severity: 'medium', details: `Cyclomatic complexity: ${nodeComplexity}` });
  }
  if (hasExternalDep) {
    riskFactors.push({ factor: 'external-dependency', severity: 'medium', details: 'Has external service dependencies' });
  }
  if (node.security?.authentication_required || node.security?.authorization_roles || isSecuritySensitiveName) {
    riskFactors.push({ factor: 'security-sensitive', severity: 'high', details: 'Handles security-sensitive operations' });
  }
  if (isCriticalDomain && !riskFactors.some(f => f.factor === 'critical-path')) {
    riskFactors.push({ factor: 'critical-path', severity: 'medium', details: 'Domain name suggests business-critical fleet, billing, identity, or operational behavior' });
  }
  const stability = (cas.temporal_stability || []).find(s => s.node_id === node.id);
  if (stability && stability.quality_signals.bug_fix_rate > 0.3) {
    riskFactors.push({ factor: 'recent-bugs', severity: 'high', details: `Bug fix density: ${Math.round(stability.quality_signals.bug_fix_rate * 100)}% of commits are bug fixes` });
  }
  if (!hasDirectTestCoverage) {
    riskFactors.push({ factor: 'no-tests', severity: 'high', details: 'No direct test coverage detected' });
  }

  const highSeverityCount = riskFactors.filter(f => f.severity === 'high').length;
  const riskLevel: CASChangeRisk['risk_level'] =
    highSeverityCount >= 2 ? 'critical' :
    highSeverityCount === 1 ? 'high' :
    riskFactors.length >= 2 ? 'medium' : 'low';

  const recommendations: string[] = [];
  if (riskFactors.some(f => f.factor === 'no-tests')) recommendations.push(`Find or add focused tests around ${node.name} before changing it.`);
  if (riskFactors.some(f => f.factor === 'critical-path')) recommendations.push('Inspect entry points, data lifecycle, and downstream callers before editing this node.');
  if (riskFactors.some(f => f.factor === 'security-sensitive')) recommendations.push('Preserve authentication, authorization, tenant, and token handling invariants.');
  if (riskFactors.some(f => f.factor === 'external-dependency')) recommendations.push('Check integration contracts and failure handling for external calls.');
  if (riskFactors.some(f => f.factor === 'complex-logic')) recommendations.push('Prefer small behavior-preserving changes and add regression coverage for branch-heavy paths.');

  return {
    node_id: node.id,
    risk_level: riskLevel,
    risk_factors: riskFactors,
    downstream_impact: {
      direct_callers: directCallers,
      transitive_callers: [],
      affected_call_chains: [],
      affected_entry_points: [],
    },
    test_protection: {
      has_direct_tests: hasDirectTestCoverage,
      has_integration_tests: false,
      test_ids: node.testing?.tested_by,
    },
    stability_context: {
      recent_churn: stability ? (stability.stability_class === 'volatile' || stability.stability_class === 'fragile') : false,
      commit_count_30d: stability?.churn_metrics.commits_30d || 0,
      bug_fix_density: stability?.quality_signals.bug_fix_rate || 0,
      last_refactor: stability?.age_context.last_major_change,
    },
    recommendations: recommendations.slice(0, 5),
  };
}

/**
 * `high_risk_nodes` / `untested_critical_paths` on `cas.change_risk_summary`
 * are REPO-WIDE lists (buildChangeRiskSummary scans every scored node in the
 * whole codebase), not consequences of the one change being assessed.
 * Embedding them wholesale under a per-node assess_change_risk answer read as
 * "your change endangers ~100 things" (defect #2, 2026-08 blackbox demo: a
 * one-method query returned ~100 high_risk_nodes and ~47
 * untested_critical_paths spanning unrelated JS files, locale printers, and
 * config parsers) — false, and actively destructive to trust in a tool whose
 * whole job is honest risk signal. Scope both lists to the change's own
 * transitive blast radius (`scopeNodeIds`); repo-wide totals are still
 * available, but as counts only and unmistakably labeled repo-wide rather
 * than embedded as if they were part of the per-node answer.
 */
function scopedChangeRiskContext(cas: CASOutput, scopeNodeIds: Set<string>) {
  const summary = cas.change_risk_summary;
  if (!summary) return null;
  const inScope = (id: string) => scopeNodeIds.has(id);
  return {
    note: 'high_risk_nodes / untested_critical_paths below are scoped to this change (the node itself plus its transitive blast radius) — every id here can actually be affected by this change. repo_wide is UNSCOPED whole-codebase context, not a consequence of this change.',
    high_risk_nodes: summary.high_risk_nodes.filter(inScope),
    untested_critical_paths: summary.untested_critical_paths.filter(inScope),
    recent_hotspots: summary.recent_hotspots.filter(inScope),
    repo_wide: {
      note: 'Whole-codebase counts, NOT scoped to this change. Do not read as consequences of this edit.',
      high_risk_node_count: summary.high_risk_nodes.length,
      untested_critical_path_count: summary.untested_critical_paths.length,
      recent_hotspot_count: summary.recent_hotspots.length,
    },
  };
}

export function assessChangeRisk(cas: CASOutput, nodeId: string) {
  const node = cas.nodes.find(n => n.id === nodeId);
  const risk = (cas.change_risks || []).find(r => r.node_id === nodeId);

  if (!node) {
    return {
      risk: null,
      reason: `No node with id '${nodeId}' on this analysis. Nothing was assessed — this is not a "low risk" result.`,
      change_risk_context: null,
    };
  }

  if (!risk && !RISKABLE_NODE_TYPES.includes(node.type)) {
    // The node exists but its type is never scored by buildChangeRisks (property,
    // interface, variable, class, file, import, ...) — returning `risk: null` plus the
    // whole-repo change_risk_summary here would look like "assessed, low-risk" when the
    // node was never evaluated at all (bug #3, 2026-07-04 impact benchmark: a silent
    // wrong-looking answer instead of an honest "unsupported" signal). Surface the real
    // reason and point at a node this tool can actually assess instead.
    // Walk 'contains' edges upward (property -> class/interface -> file) looking for the
    // nearest ancestor whose type IS scored, so the caller has something concrete to assess
    // instead of a dead end.
    const containedBy = new Map<string, string>();
    for (const edge of cas.edges) {
      if (edge.type === 'contains') containedBy.set(edge.target, edge.source);
    }
    let supported: CASNode | undefined;
    let currentId: string | undefined = nodeId;
    const visited = new Set<string>();
    while (currentId && !visited.has(currentId)) {
      visited.add(currentId);
      const parentId: string | undefined = containedBy.get(currentId);
      if (!parentId) break;
      const parentNode = cas.nodes.find(n => n.id === parentId);
      if (parentNode && RISKABLE_NODE_TYPES.includes(parentNode.type)) {
        supported = parentNode;
        break;
      }
      currentId = parentId;
    }
    return {
      risk: null,
      unsupported: true,
      reason: `assess_change_risk does not score node type '${node.type}' (only ${RISKABLE_NODE_TYPES.join(', ')} are assessed). This node was never evaluated — this is not a "low risk" result.`,
      node_type: node.type,
      suggested_node_id: supported?.id,
      suggested_node_reason: supported ? `Containing ${supported.type} node — assess that instead to get real risk signal for this change.` : undefined,
      change_risk_context: null,
    };
  }

  // Transitive blast radius (additive): full upstream closure — every node
  // that can transitively reach this one, i.e. everything a change here can
  // affect. Near-O(1) via the persisted reachability index when present;
  // traversal fallback on older CAS (same edge set, same answer).
  const affectedResult = getAffectedSet(cas, [nodeId], { direction: 'upstream' });
  const nodeNameById = new Map(cas.nodes.map(n => [n.id, n.name]));
  const transitiveImpact = {
    affected_count: affectedResult.affected.length,
    affected_sample: affectedResult.affected.slice(0, 20).map(id => ({ node_id: id, name: nodeNameById.get(id) })),
    method: affectedResult.method,
  };

  // Defect #1: never fall back to a silent `risk: null` for a riskable-type
  // node just because buildChangeRisks' repo-wide top-100/noise filtering
  // left it out — compute the answer on demand instead (see
  // scoreChangeRiskOnDemand). `risk_computation` says which path produced it,
  // so a caller can tell "the analysis already knew this" from "computed just
  // now for this ask" without guessing from field presence alone.
  const resolvedRisk = risk || scoreChangeRiskOnDemand(cas, node);
  const scopeNodeIds = new Set<string>([nodeId, ...affectedResult.affected]);

  return {
    risk: resolvedRisk,
    risk_computation: risk ? 'precomputed' : 'computed_on_demand',
    transitive_impact: transitiveImpact,
    change_risk_context: scopedChangeRiskContext(cas, scopeNodeIds),
  };
}

export function getFlowCoverage(cas: CASOutput, chainId?: string) {
  const coverage = cas.flow_coverage || [];
  if (chainId) {
    return {
      coverage: coverage.find(fc => fc.call_chain_id === chainId) || null,
      test_gaps: (cas.test_gaps || []).filter(g => g.location.call_chain_id === chainId),
    };
  }
  // VOCABULARY COHERENCE: `flow_coverage` entries are per CALL CHAIN
  // (call_chain_id), not per flow. Report chains as chains, and measure FLOW
  // coverage over the SAME flow set get_flow_concepts returns
  // (computeFlowConcepts' union), joined chain->flow by chain id (terminal
  // flows embed it: flow::<chain_id>) or by shared entry point. Previously
  // `total_flows` was the raw chain count (e.g. 3703) while get_flow_concepts
  // said 10 — two tools, one word, two meanings.
  const chainByStatus: Record<string, number> = {};
  for (const fc of coverage) {
    chainByStatus[fc.coverage_status] = (chainByStatus[fc.coverage_status] || 0) + 1;
  }

  const flows = computeFlowConcepts(cas);
  const coverageByChainId = new Map(coverage.map(fc => [fc.call_chain_id, fc]));
  // entry node/entry-point id -> best coverage status of any chain rooted there
  // (for entry-point-rooted flows that don't wrap a single recorded chain).
  const STATUS_RANK: Record<string, number> = { 'fully-covered': 3, 'partially-covered': 2, 'not-covered': 1 };
  const bestStatusByEntry = new Map<string, string>();
  for (const chain of cas.call_chains || []) {
    const fc = coverageByChainId.get(chain.id);
    if (!fc) continue;
    for (const key of [chain.entry_point.entry_point_id, chain.entry_point.node_id]) {
      if (!key) continue;
      const prev = bestStatusByEntry.get(key);
      if (!prev || (STATUS_RANK[fc.coverage_status] || 0) > (STATUS_RANK[prev] || 0)) {
        bestStatusByEntry.set(key, fc.coverage_status);
      }
    }
  }

  const flowsByStatus: Record<string, number> = {};
  let unmeasuredFlows = 0;
  for (const flow of flows) {
    // Terminal flows carry their chain id in the flow_id (flow::<chain_id>).
    const embeddedChainId = flow.flow_id.startsWith('flow::') ? flow.flow_id.slice('flow::'.length) : undefined;
    const direct = embeddedChainId ? coverageByChainId.get(embeddedChainId) : undefined;
    const status = direct?.coverage_status || bestStatusByEntry.get(flow.entry_point);
    if (status) {
      flowsByStatus[status] = (flowsByStatus[status] || 0) + 1;
    } else {
      unmeasuredFlows += 1;
    }
  }

  const gaps = cas.test_gaps || [];
  const gapsBySeverity: Record<string, number> = {};
  for (const g of gaps) {
    gapsBySeverity[g.severity] = (gapsBySeverity[g.severity] || 0) + 1;
  }
  return {
    flow_summary: cas.flow_summary || null,
    // Flows — the SAME flow set (and count) as get_flow_concepts.
    total_flows: flows.length,
    flows_by_coverage_status: flowsByStatus,
    // Flows with no coverage-measured chain rooted at their entry point —
    // honest "unmeasured", never silently folded into not-covered.
    unmeasured_flows: unmeasuredFlows,
    // Chains — the raw per-call-chain coverage records, reported as chains.
    total_chains: coverage.length,
    chains_by_coverage_status: chainByStatus,
    // Back-compat alias (pre-coherence field name; same chain breakdown).
    by_coverage_status: chainByStatus,
    total_test_gaps: gaps.length,
    test_gaps_by_severity: gapsBySeverity,
  };
}

export function getWorkflows(cas: CASOutput, workflowId?: string) {
  if (workflowId) {
    const workflow = (cas.workflows || []).find(w => w.id === workflowId);
    return { workflow: workflow || null };
  }
  const workflows = cas.workflows || [];
  return {
    total: workflows.length,
    workflows: workflows.map(w => ({
      id: w.id,
      name: w.name,
      workflow_type: w.workflow_type,
      classification: w.classification,
      criticality: w.criticality,
      entry_point_count: w.entry_points?.length || 0,
      chain_count: w.call_chains?.length || 0,
      entity_count: w.entities_touched?.length || 0,
      service_count: w.services_used?.length || 0,
    })),
    workflow_graph: cas.workflow_graph || null,
  };
}

export function getUserJourneys(
  cas: CASOutput,
  opts: { journeyId?: string; kind?: string; limit?: number; offset?: number; format?: 'json' | 'markdown'; includeSteps?: boolean } = {}
) {
  const journeysNotice = cas.user_journeys === undefined
    ? analysisVersionNotice(cas, 'user journeys')
    : undefined;
  const journeys = cas.user_journeys || [];
  if (opts.journeyId) {
    const journey = journeys.find(item => item.id === opts.journeyId) || null;
    if (opts.format === 'markdown') {
      const markdown = journey ? journeyDetailMarkdown(journey) : `No journey with id '${opts.journeyId}'.`;
      return {
        markdown: journeysNotice ? `> ${journeysNotice}\n\n${markdown}` : markdown,
      };
    }
    return {
      journey: journey
        ? { title: journeyTitle(journey), headline: journeyHeadline(journey), ...journey }
        : null,
      analysis_version_notice: journeysNotice,
    };
  }

  let filtered = journeys;
  if (opts.kind) {
    filtered = filtered.filter(journey => journey.journey_kind === opts.kind);
  }

  const limit = opts.limit || 25;
  const offset = opts.offset || 0;
  const page = filtered.slice(offset, offset + limit);

  if (opts.format === 'markdown') {
    const markdown = journeyListMarkdown(page, {
      total: filtered.length,
      offset,
      byKind: cas.user_journey_summary?.by_kind,
    });
    return {
      markdown: journeysNotice ? `> ${journeysNotice}\n\n${markdown}` : markdown,
    };
  }

  // Steps in the list form: default ON. Each step is small (node_id, name,
  // layer, depth), so even a page of 25 journeys stays token-cheap, and it
  // removes the near-universal need for a 2nd per-journey detail call just to
  // get the step chain (e.g. to feed a node_id into get_coding_context). Uses
  // the same display-deduped step list as the markdown/detail views (drops
  // steps whose label repeats the entry or the previous step) so the JSON and
  // markdown forms agree. Pass include_steps: false to opt out for very large
  // listings.
  const includeSteps = opts.includeSteps !== false;

  return {
    total: filtered.length,
    offset,
    limit,
    analysis_version_notice: journeysNotice,
    summary: cas.user_journey_summary || null,
    journeys: page.map(journey => ({
      id: journey.id,
      title: journeyTitle(journey),
      headline: journeyHeadline(journey),
      name: journey.name,
      journey_kind: journey.journey_kind,
      criticality: journey.criticality,
      risk: journey.risk,
      entry: journey.entry,
      terminal_entities: journey.terminal_entities,
      entities_written: journey.terminal_effects?.entities_written || [],
      external_services: journey.terminal_effects?.external_services || [],
      step_count: journey.steps?.length || 0,
      steps: includeSteps
        ? displayJourneySteps(journey).map(step => ({
            node_id: step.node_id,
            name: step.name,
            layer: step.layer,
            depth: step.depth,
          }))
        : undefined,
      // Compact source->sink reaching-chain so the cross-function path is visible
      // without a second per-journey detail call. Reuses the same compression-bounded
      // step-name phrase as the markdown/detail views (leading + "(N intermediate)" +
      // trailing), keeping this token-bounded even for long chains.
      path: journeyStepPhrase(journey) || undefined,
      security_boundary_count: journey.security_boundaries?.length || 0,
      test_count: journey.tests_covering?.length || 0,
    })),
  };
}

export function getParadigmConformance(
  cas: CASOutput,
  opts: { paradigm?: string } = {}
) {
  const paradigmsNotice = cas.paradigm_conformance === undefined
    ? analysisVersionNotice(cas, 'paradigm conformance')
    : undefined;
  const paradigms = cas.paradigm_conformance || [];

  if (opts.paradigm) {
    const match = paradigms.find(item => item.paradigm === opts.paradigm) || null;
    return { paradigm: match, analysis_version_notice: paradigmsNotice };
  }

  const severityCounts = (deviations: { severity: string }[]) => {
    const counts: Record<string, number> = {};
    for (const deviation of deviations) {
      counts[deviation.severity] = (counts[deviation.severity] || 0) + 1;
    }
    return counts;
  };

  return {
    total: paradigms.length,
    total_deviations: paradigms.reduce((sum, item) => sum + item.deviations.length, 0),
    analysis_version_notice: paradigmsNotice,
    paradigms: paradigms.map(item => ({
      paradigm: item.paradigm,
      description: item.description,
      adoption: item.adoption,
      deviation_count: item.deviations.length,
      deviations_by_severity: severityCounts(item.deviations),
      sample_deviations: item.deviations.slice(0, 3),
    })),
  };
}

/**
 * Architectural consistency: pattern-conflict/overlap findings (the same
 * concern handled by two competing structural patterns) and engineering-
 * principle violations (layering, single-responsibility, coupling), grounded
 * in the same deterministic evidence as paradigm_conformance. This is the
 * tool an agent calls BEFORE adding non-trivial code to check "is what I'm
 * about to build consistent with how this system is actually built?" —
 * self-regulation so a fleet of agents keeps a growing codebase cohesive.
 */
export function getArchitecturalConflicts(
  cas: CASOutput,
  opts: { severity?: 'low' | 'medium' | 'high'; limit?: number; offset?: number; includeFlowLinks?: boolean } = {}
) {
  const notice = cas.architectural_conflicts === undefined && cas.principle_violations === undefined
    ? analysisVersionNotice(cas, 'architectural conflicts')
    : undefined;

  let conflicts = cas.architectural_conflicts || [];
  if (opts.severity) {
    const rank = { low: 0, medium: 1, high: 2 };
    conflicts = conflicts.filter(c => rank[c.severity] >= rank[opts.severity!]);
  }
  const violations = cas.principle_violations || [];

  const offset = opts.offset ?? 0;
  const limit = opts.limit ?? 25;

  const violationsBySeverity: Record<string, number> = {};
  for (const v of violations) violationsBySeverity[v.severity] = (violationsBySeverity[v.severity] || 0) + 1;

  const violationsByPrinciple: Record<string, number> = {};
  for (const v of violations) violationsByPrinciple[v.principle] = (violationsByPrinciple[v.principle] || 0) + 1;

  // Cross-link to the BEHAVIORAL hierarchy (docs/SPEC-CONCEPTUAL-LAYER.md
  // §3/§6): which flow(s)/step(s)/capability(ies) each conflict/violation's
  // evidence actually sits on, deterministically, via node-id/file
  // membership in the traced flow function sets. Opt-out (includeFlowLinks:
  // false) since it requires computing flows; on by default because flows
  // are cheap at the default bounded traversal depth and this is exactly the
  // point of the unification. Silently degrades to no links (never throws)
  // when entry_points are absent — existing callers see identical output
  // plus an empty flow_links, not a behavior change.
  const includeFlowLinks = opts.includeFlowLinks !== false;
  let conflictLinks = new Map<string, ReturnType<typeof computeConflictBehavioralLinks>['conflicts'] extends Map<string, infer V> ? V : never>();
  let violationLinks = new Map<string, ReturnType<typeof computeConflictBehavioralLinks>['violations'] extends Map<string, infer V> ? V : never>();
  if (includeFlowLinks && (cas.entry_points || []).length > 0) {
    const flows = computeFlowConcepts(cas);
    const linked = computeConflictBehavioralLinks(cas, flows, conflicts, violations);
    conflictLinks = linked.conflicts;
    violationLinks = linked.violations;
  }

  const conflictsPage = conflicts.slice(offset, offset + limit).map(c => ({
    ...c,
    flow_links: conflictLinks.get(c.id) || undefined,
  }));
  const violationsPage = violations.slice(0, limit).map(v => ({
    ...v,
    flow_links: violationLinks.get(v.id) || undefined,
  }));

  return {
    total_conflicts: conflicts.length,
    total_principle_violations: violations.length,
    principle_violations_by_severity: violationsBySeverity,
    principle_violations_by_principle: violationsByPrinciple,
    conflicts: conflictsPage,
    principle_violations: violationsPage,
    is_cohesive: conflicts.length === 0 && violations.filter(v => v.severity === 'error').length === 0,
    analysis_version_notice: notice,
  };
}

/**
 * Module health: "which parts of this system are dangerous to touch, and
 * why" (task #122 — a codebase-analysis product that never told its own team
 * a 31k-line file existed). Every finding is a file that is a statistical
 * OUTLIER within THIS codebase's own file-size/churn/fan-in/capability-anchor
 * distribution (median + MAD modified z-score, see module-health.ts) — never
 * a fixed line-count cutoff. A tidy codebase legitimately returns zero
 * findings; that is success, not a gap. Call this before touching a file you
 * do not already know well, or when onboarding to an unfamiliar system, to
 * see where change is structurally risky before you make it.
 */
export function getModuleHealth(
  cas: CASOutput,
  opts: { kind?: 'size-outlier' | 'change-concentration' | 'fan-in-hotspot' | 'mixed-concerns' | 'danger-composite'; severity?: 'info' | 'warning' | 'error'; limit?: number; offset?: number } = {}
) {
  const health = cas.module_health;
  if (!health) {
    return {
      available: false,
      reason: cas.nodes.length === 0
        ? 'No nodes on this analysis.'
        : 'Below the statistical-signal floor (module_health requires at least 10 files with resolvable source locations) — too few files for "outlier" to be a meaningful concept, or this analysis predates module_health (re-run to populate it).',
      analysis_version_notice: analysisVersionNotice(cas, 'module health'),
    };
  }

  let findings = health.findings;
  if (opts.kind) findings = findings.filter(f => f.kind === opts.kind);
  if (opts.severity) {
    const rank = { info: 0, warning: 1, error: 2 };
    findings = findings.filter(f => rank[f.severity] >= rank[opts.severity!]);
  }
  const offset = opts.offset ?? 0;
  const limit = opts.limit ?? 25;

  const findingsByKind: Record<string, number> = {};
  for (const f of health.findings) findingsByKind[f.kind] = (findingsByKind[f.kind] || 0) + 1;

  return {
    available: true,
    method: health.method,
    files_analyzed: health.files_analyzed,
    total_lines: health.total_lines,
    total_commits_90d: health.total_commits_90d,
    concentration: health.concentration,
    total_findings: health.findings.length,
    findings_by_kind: findingsByKind,
    findings: findings.slice(offset, offset + limit),
    is_healthy: health.findings.length === 0,
  };
}

/**
 * Order data-lineage access sites so the most authoritative producers/consumers
 * come first: repositories and services (where the entity is really persisted or
 * orchestrated) above controllers, above UI stores, above tests. An entity whose
 * only writer is a test or a UI store reads as "untraceable" to an onboarding
 * agent — surface the real backend site instead.
 */
function rankLineageSites<T extends { file?: string }>(sites: T[]): T[] {
  const rank = (file: string | undefined): number => {
    const f = (file || '').toLowerCase();
    if (/\.(test|spec)\.[a-z]+$|(^|\/)(tests?|__tests__|fixtures?)\//.test(f)) return 5;
    if (/(^|\/)(ui|frontend|client|web|app)\/.*\/(stores?|components?|pages?|hooks?)\//.test(f) || /\.(store|component|page|hook)\.[a-z]+$/.test(f)) return 4;
    if (/repositor|persistence|\/dao\/|\/entities\//.test(f)) return 0;
    if (/service/.test(f)) return 1;
    if (/controller|handler|route|resolver/.test(f)) return 2;
    return 3;
  };
  return [...sites].sort((a, b) => rank(a.file) - rank(b.file));
}

export function getDataLineage(
  cas: CASOutput,
  opts: { entityId?: string; entityName?: string; sensitiveOnly?: boolean; limit?: number; offset?: number } = {}
) {
  const lineageNotice = cas.data_lineage === undefined
    ? analysisVersionNotice(cas, 'data lineage')
    : undefined;
  const lineage = cas.data_lineage || [];

  // `entityName` is an alias accepted for callers that pass a display name
  // (e.g. "Invoice") rather than the internal entity_id — this was previously
  // silently ignored, returning the identical unfiltered listing regardless
  // of what was passed. Resolve by entity_id first (exact), then by
  // entity_name case-insensitively. A filter that resolves to nothing now
  // returns an explicit not-found reason instead of silently falling through
  // to the unfiltered listing.
  const requestedFilter = opts.entityId || opts.entityName;
  if (requestedFilter) {
    let entity = lineage.find(item => item.entity_id === requestedFilter) || null;
    if (!entity) {
      const wanted = requestedFilter.toLowerCase();
      entity = lineage.find(item => item.entity_name.toLowerCase() === wanted) || null;
    }
    if (!entity) {
      const known = lineage.map(item => item.entity_name).slice(0, 20);
      return {
        entity: null,
        error: `Entity '${requestedFilter}' not found in data lineage. Known entities (up to 20): ${known.join(', ') || 'none'}.`,
        analysis_version_notice: lineageNotice,
      };
    }
    return { entity, analysis_version_notice: lineageNotice };
  }

  const exposureScore = (item: typeof lineage[number]) => {
    let score = 0;
    if (item.exposure.sensitive) score += 4;
    if (item.exposure.unguarded_paths > 0) score += 2;
    if (item.exposure.external_transfer) score += 1;
    return score;
  };

  let filtered = lineage;
  if (opts.sensitiveOnly) {
    filtered = filtered.filter(item => item.exposure.sensitive);
  }
  filtered = [...filtered].sort((a, b) =>
    exposureScore(b) - exposureScore(a) ||
    b.exposure.unguarded_paths - a.exposure.unguarded_paths ||
    (b.writers.length + b.readers.length) - (a.writers.length + a.readers.length) ||
    a.entity_name.localeCompare(b.entity_name)
  );

  const limit = opts.limit || 25;
  const offset = opts.offset || 0;

  return {
    total: filtered.length,
    offset,
    limit,
    analysis_version_notice: lineageNotice,
    sensitive_entities: lineage.filter(item => item.exposure.sensitive).length,
    entities_with_external_transfer: lineage.filter(item => item.exposure.external_transfer).length,
    entities_with_unguarded_paths: lineage.filter(item => item.exposure.unguarded_paths > 0).length,
    entities_with_non_auth_guarded_paths: lineage.filter(item => (item.exposure.non_auth_guarded_paths || 0) > 0).length,
    entities: filtered.slice(offset, offset + limit).map(item => ({
      entity_id: item.entity_id,
      entity_name: item.entity_name,
      sensitive_fields: item.sensitive_fields,
      writer_count: item.writers.length,
      reader_count: item.readers.length,
      // Surface the actual writer/reader SITES (file + how), not just counts —
      // otherwise the lineage is unnavigable ("who writes User?" -> a number).
      // Rank persistence/service/controller sites above tests and UI stores so the
      // first results point at where the entity is really produced/consumed.
      writers: rankLineageSites(item.writers).slice(0, 6).map(writer => ({ file: writer.file, via: writer.via, node_id: writer.node_id })),
      readers: rankLineageSites(item.readers).slice(0, 6).map(reader => ({ file: reader.file, via: reader.via, node_id: reader.node_id })),
      external_recipients: item.external_recipients.map(recipient => recipient.service),
      boundaries_crossed: item.boundaries_crossed,
      journey_count: item.journeys_carrying.length,
      exposure: item.exposure,
    })),
  };
}

export async function diffBehaviorAgainstSnapshot(
  projectPath: string,
  currentCas: CASOutput,
  snapshotId?: string
) {
  const snapshots = await listAnalysisSnapshots(projectPath);
  const requested = snapshotId && snapshotId !== 'previous' ? snapshotId : null;

  let resolvedId: string | null = null;
  if (requested) {
    if (!snapshots.some(snapshot => snapshot.id === requested)) {
      return {
        applicable: false,
        reason: `Snapshot '${requested}' not found. Available snapshots: ${snapshots.map(s => s.id).join(', ') || 'none'}.`,
      };
    }
    resolvedId = requested;
  } else {
    if (snapshots.length < 2) {
      return {
        applicable: false,
        reason: snapshots.length === 0
          ? 'No analysis snapshots exist for this project. Run analyze_codebase at least twice to enable behavior diffing.'
          : 'Only the current analysis snapshot exists. Run analyze_codebase again after changes to create a comparison baseline.',
      };
    }
    resolvedId = snapshots[1].id;
  }

  const before = await loadAnalysisSnapshot(projectPath, resolvedId);
  if (!before) {
    return { applicable: false, reason: `Snapshot '${resolvedId}' could not be loaded.` };
  }

  const diff = diffBehavior(before, currentCas);

  const baselinePredatesPillars =
    before.user_journeys === undefined &&
    before.data_lineage === undefined &&
    compareCasVersions(before.cas_version, PILLAR_ATTESTED_CAS_VERSION) < 0;

  return {
    applicable: true,
    compared_to_snapshot: resolvedId,
    analysis_version_notice: baselinePredatesPillars
      ? `Baseline snapshot '${resolvedId}' was produced by cas_version ${before.cas_version || 'unknown'}, which predates behavior pillars (journeys, lineage, conformance). Added/removed counts may reflect the analyzer upgrade rather than code changes. Re-run analyze_codebase after changes to build current baselines.`
      : undefined,
    risk_flags: diff.summary.risk_flags,
    counts: {
      journeys_added: diff.journeys.added.length,
      journeys_removed: diff.journeys.removed.length,
      journeys_changed: diff.journeys.changed.length,
      newly_unguarded_entries: diff.security.newly_unguarded_entries.length,
      capabilities_added: diff.capabilities.added.length,
      capabilities_removed: diff.capabilities.removed.length,
      capabilities_possibly_duplicated: diff.capabilities.possibly_duplicated.length,
      entities_with_new_writers: diff.lineage.entities_with_new_writers.length,
      sensitive_exposure_changes: diff.lineage.sensitive_exposure_changes.length,
      new_paradigm_deviations: diff.paradigms.new_deviations.length,
      resolved_paradigm_deviations: diff.paradigms.resolved_deviations.length,
    },
    diff,
  };
}

const PRODUCT_MAP_SECTIONS = ['identity', 'capabilities', 'journeys', 'data', 'conventions', 'health', 'runtime_topology', 'coverage_caveats'] as const;

export function getProductMap(
  cas: CASOutput,
  opts: { section?: string; format?: 'json' | 'markdown' } = {}
) {
  const map = cas.product_map || buildProductMap(cas);
  const mapPredatesStorage = cas.product_map === undefined
    && compareCasVersions(cas.cas_version, PILLAR_ATTESTED_CAS_VERSION) < 0;
  const mapNotice = mapPredatesStorage
    ? `This analysis (cas_version ${cas.cas_version || '0.0.0'}) predates the stored product map; the map below was computed on demand from older analysis data and may miss journeys, lineage, and conventions. Re-run analyze_codebase for the full product map.`
    : undefined;

  if (opts.format === 'markdown') {
    const markdown = productMapToMarkdown(map);
    return {
      markdown: mapNotice ? `> ${mapNotice}\n\n${markdown}` : markdown,
    };
  }

  if (opts.section) {
    if (!PRODUCT_MAP_SECTIONS.includes(opts.section as typeof PRODUCT_MAP_SECTIONS[number])) {
      return {
        error: `Unknown section '${opts.section}'. Available sections: ${PRODUCT_MAP_SECTIONS.join(', ')}.`,
      };
    }
    return { [opts.section]: map[opts.section as keyof CASProductMap], analysis_version_notice: mapNotice };
  }

  return mapNotice ? { ...map, analysis_version_notice: mapNotice } : map;
}

export function productMapToMarkdown(map: CASProductMap): string {
  const lines: string[] = [];
  const percent = (rate: number) => `${Math.round(rate * 100)}%`;
  // Exposure-highlight fields (sensitive_fields, external_recipients) are typed
  // string[], but legacy/cross-repo analyses can carry field/recipient OBJECTS
  // ({name,...} / {service,...}) instead of bare strings; joining those renders
  // "[object Object]" in the served map. Coerce to a meaningful string so old
  // analyses degrade to the field/service NAME instead of the object noise.
  const asLabel = (value: unknown): string => {
    if (value == null) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'object') {
      const record = value as Record<string, unknown>;
      const label = record.name ?? record.service ?? record.field ?? record.label ?? record.boundary;
      if (typeof label === 'string') return label;
    }
    return String(value);
  };
  const joinLabels = (values: unknown): string =>
    (Array.isArray(values) ? values : [])
      .map(asLabel)
      .filter(Boolean)
      .join(', ');

  lines.push(`# ${map.identity.name} - Product Map`);
  lines.push('');
  lines.push(`**Domain:** ${map.identity.domain} (${map.identity.domain_source})`);
  if (map.identity.description) {
    lines.push('');
    lines.push(`${map.identity.description} _(description: ${map.identity.description_source})_`);
  }

  lines.push('');
  lines.push(`## Capabilities (${map.capabilities.length})`);
  for (const capability of map.capabilities.slice(0, 12)) {
    lines.push(`- **${capability.name}** [${capability.criticality}, ${capability.category}] ${capability.description}`);
    const facts: string[] = [];
    if (capability.journeys.length > 0) {
      facts.push(`journeys: ${capability.journeys.map(journey => storedJourneyNameParts(journey.name).title || journey.name).join('; ')}`);
    }
    if (capability.entities.length > 0) {
      facts.push(`entities: ${capability.entities.join(', ')}`);
    }
    facts.push(`tests: ${capability.tests_present ? 'yes' : 'no'}`);
    facts.push(`risk: ${capability.risk_level}`);
    lines.push(`  - ${facts.join(' | ')}`);
  }
  if (map.capabilities.length > 12) {
    lines.push(`- plus ${map.capabilities.length - 12} more capabilities`);
  }

  lines.push('');
  lines.push('## Journeys');
  const mappedJourneys = map.journeys.user_facing + map.journeys.system + map.journeys.scheduled;
  const kindBreakdown = `${map.journeys.user_facing} user-facing, ${map.journeys.system} system, ${map.journeys.scheduled} scheduled`;
  if (mappedJourneys < map.journeys.total) {
    lines.push(`${map.journeys.total} discovered, ${mappedJourneys} mapped in detail: ${kindBreakdown}.`);
  } else {
    lines.push(`${map.journeys.total} total: ${kindBreakdown}.`);
  }
  for (const journey of map.journeys.top) {
    const guardText = guardPhraseForBoundaries(journey.boundaries.map(name => ({ name })));
    const testText = journey.tests === 0 ? 'no tests' : `${journey.tests} test${journey.tests === 1 ? '' : 's'}`;
    lines.push(`- ${storedJourneyNameHeadline(journey.name)}; ${guardText}, ${testText} [${journey.kind}, ${journey.criticality}]`);
  }

  lines.push('');
  lines.push('## Data');
  const sensitiveText = map.data.sensitive.length > 0 ? map.data.sensitive.join(', ') : 'none detected';
  lines.push(`${map.data.entities} entities tracked. Sensitive: ${sensitiveText}.`);
  for (const highlight of map.data.exposure_highlights) {
    const details: string[] = [];
    const sensitiveFieldsText = joinLabels(highlight.sensitive_fields);
    if (sensitiveFieldsText) details.push(`sensitive fields: ${sensitiveFieldsText}`);
    if (highlight.unguarded_paths > 0) {
      const nonAuth = highlight.non_auth_guarded_paths || 0;
      const nonAuthSuffix = nonAuth > 0 ? ` (${nonAuth} with non-auth guards only)` : '';
      details.push(`${highlight.unguarded_paths} unguarded path${highlight.unguarded_paths === 1 ? '' : 's'}${nonAuthSuffix}`);
    }
    if (highlight.external_transfer) details.push(`external transfer to ${joinLabels(highlight.external_recipients) || 'unknown service'}`);
    lines.push(`- ${asLabel(highlight.entity)}: ${details.join('; ')}`);
  }

  lines.push('');
  lines.push('## Conventions');
  if (map.conventions.paradigms.length === 0) {
    lines.push('No codebase paradigms detected.');
  }
  for (const paradigm of map.conventions.paradigms) {
    lines.push(`- ${paradigm.paradigm}: ${percent(paradigm.adoption_rate)} adoption (${paradigm.following_count}/${paradigm.comparable_count})`);
  }
  const dev = map.conventions.open_deviations;
  if (dev.error + dev.warning + dev.info > 0) {
    lines.push(`Open deviations: ${dev.error} error, ${dev.warning} warning, ${dev.info} info.`);
  }

  lines.push('');
  lines.push('## Health');
  if (map.health.status) {
    lines.push(`Status: ${map.health.status}${map.health.score !== undefined ? ` (score ${map.health.score})` : ''}.`);
  }
  const tests = map.health.tests;
  const coverageText = tests.coverage_percentage !== undefined ? `, ${Math.round(tests.coverage_percentage)}% coverage` : '';
  lines.push(`Tests: ${tests.total} total (${tests.passing} passing, ${tests.failing} failing${coverageText}).`);
  const impl = map.health.implementation;
  lines.push(`Implementation: ${impl.complete} complete, ${impl.partial} partial, ${impl.stubs} stubs, ${impl.not_implemented} not implemented, ${impl.deprecated} deprecated.`);
  for (const risk of map.health.top_risks) {
    lines.push(`- Risk [${risk.level}] ${risk.name} (${risk.type}): ${risk.recommendation}`);
  }

  if (map.runtime_topology && map.runtime_topology.deployables.length > 0) {
    lines.push('');
    const commTotal = map.runtime_topology.communication?.counts.total || 0;
    lines.push(
      `## Runtime Topology (${map.runtime_topology.edge_count} infra->code edges` +
        (commTotal > 0 ? `, ${commTotal} communication seams` : '') +
        ')'
    );
    for (const deployable of map.runtime_topology.deployables) {
      lines.push(`- **${deployable.name}**`);
      const facts: Array<[string, string[]]> = [
        ['deploys', deployable.deploys],
        ['exposes', deployable.exposes],
        ['routes', deployable.routes],
        ['channels', deployable.channels],
        ['databases', deployable.databases],
        ['storage', deployable.storage],
        ['depends on', deployable.depends_on],
      ];
      for (const [label, values] of facts) {
        if (values.length > 0) lines.push(`  - ${label}: ${values.join(', ')}`);
      }
    }
    const comm = map.runtime_topology.communication;
    if (comm && comm.edges.length > 0) {
      lines.push('');
      lines.push(
        `### Communication graph (${comm.counts.total} seams: ${comm.counts.sync} sync / ${comm.counts.async} async / ${comm.counts.passive} passive)`
      );
      for (const edge of comm.edges.slice(0, 25)) {
        const breakdown = (['sync', 'async', 'passive'] as const)
          .filter(m => edge[m] > 0)
          .map(m => `${edge[m]} ${m}`)
          .join(', ');
        lines.push(`- ${edge.source} -> ${edge.target} (${breakdown})`);
      }
      if (comm.edges.length > 25) lines.push(`- ...and ${comm.edges.length - 25} more edges`);
    }
  }

  if (map.coverage_caveats.length > 0) {
    lines.push('');
    lines.push('## Coverage Caveats');
    for (const caveat of map.coverage_caveats) {
      lines.push(`- ${caveat}`);
    }
  }

  return lines.join('\n');
}

export function getRuntimeStaticLinks(
  cas: CASOutput,
  opts: { telemetryStatus?: string; kind?: string; limit?: number; offset?: number } = {}
) {
  let links = cas.runtime_static_links || [];
  if (opts.telemetryStatus) {
    links = links.filter(link => link.telemetry_status === opts.telemetryStatus);
  }
  if (opts.kind) {
    links = links.filter(link => link.kind === opts.kind);
  }

  const total = links.length;
  const limit = opts.limit || 50;
  const offset = opts.offset || 0;

  const byStatus: Record<string, number> = {};
  for (const link of cas.runtime_static_links || []) {
    byStatus[link.telemetry_status] = (byStatus[link.telemetry_status] || 0) + 1;
  }

  return {
    total,
    offset,
    limit,
    by_status: byStatus,
    links: links.slice(offset, offset + limit),
    runtime: cas.runtime || null,
  };
}

export function getAnalysisFacts(
  cas: CASOutput,
  opts: { subjectType?: string; subjectId?: string; factType?: string; limit?: number; offset?: number } = {}
) {
  let facts = cas.analysis_facts || [];

  if (opts.subjectType) {
    facts = facts.filter(fact => fact.subject_type === opts.subjectType);
  }
  if (opts.subjectId) {
    facts = facts.filter(fact => fact.subject_id === opts.subjectId);
  }
  if (opts.factType) {
    facts = facts.filter(fact => fact.fact_type === opts.factType);
  }

  const total = facts.length;
  const limit = opts.limit || 50;
  const offset = opts.offset || 0;

  return {
    total,
    offset,
    limit,
    facts: facts.slice(offset, offset + limit),
  };
}

export function getFlowGraph(cas: CASOutput) {
  const flowGraph = cas.flow_graph;
  if (!flowGraph) return null;

  const capabilities = (flowGraph.capabilities || []).map(c => ({
    id: c.id,
    name: c.name,
    description: c.description,
    classification: c.classification,
    criticality: c.criticality,
    signals: c.signals,
    complexity_profile: c.complexity_profile,
    operation_patterns: c.operation_patterns,
    entry_point_count: c.entry_points?.length || 0,
    entry_point_summary: c.entry_point_summary,
    operation_count: c.operations?.length || 0,
    entity_count: c.entities_touched?.length || 0,
    service_count: c.services_used?.length || 0,
    exit_point_count: c.exit_points?.length || 0,
    call_chain_count: c.call_chain_ids?.length || 0,
    depends_on_count: c.depends_on?.length || 0,
    depended_by_count: c.depended_by?.length || 0,
  }));

  const dependencies = (flowGraph.dependencies || []).map(d => ({
    from_capability: d.from_capability,
    to_capability: d.to_capability,
    dependency_type: d.dependency_type,
    strength: d.strength,
    description: d.description,
    evidence_summary: {
      shared_service_count: d.evidence?.shared_services?.length || 0,
      shared_entity_count: d.evidence?.shared_entities?.length || 0,
      shared_node_count: d.evidence?.shared_nodes?.length || 0,
      call_count: d.evidence?.call_count,
    },
  }));

  return {
    capability_count: capabilities.length,
    capabilities,
    dependency_count: dependencies.length,
    dependencies,
    topology: flowGraph.topology,
    primary_flow: flowGraph.primary_flow,
    layers: flowGraph.layers,
    system_insights: flowGraph.system_insights,
  };
}

export function getDomainConcepts(cas: CASOutput, opts: { classification?: string; limit?: number; offset?: number } = {}) {
  let concepts = cas.domain_concepts || [];
  if (opts.classification) {
    concepts = concepts.filter(c => c.classification === opts.classification);
  }
  concepts = [...concepts].sort((a, b) => b.frequency - a.frequency);
  const total = concepts.length;
  const limit = opts.limit || 25;
  const offset = opts.offset || 0;

  const summarized = concepts.slice(offset, offset + limit).map(c => ({
    id: c.id,
    name: c.name,
    frequency: c.frequency,
    classification: c.classification,
    appears_in: {
      entry_points_count: c.appears_in?.entry_points?.length || 0,
      entities_count: c.appears_in?.entities?.length || 0,
      nodes_count: c.appears_in?.nodes?.length || 0,
      entry_points_sample: (c.appears_in?.entry_points || []).slice(0, 5),
      entities_sample: (c.appears_in?.entities || []).slice(0, 5),
      nodes_sample: (c.appears_in?.nodes || []).slice(0, 5),
    },
  }));

  return { total, offset, limit, concepts: summarized };
}

export function getPatterns(cas: CASOutput) {
  const patterns = (cas.patterns || []).map(p => ({
    id: p.id,
    name: p.name,
    description: p.description,
    type: p.type,
    confidence: p.confidence,
    instance_count: p.instances?.length || 0,
    variations: (p.variations || []).map(v => ({
      id: v.id,
      implementation: v.implementation,
      description: v.description,
      instance_count: v.instances?.length || 0,
      percentage: v.percentage,
    })),
  }));

  return {
    total: patterns.length,
    patterns,
    categories: cas.categories || {},
    behaviors_count: (cas.behaviors || []).length,
  };
}

/** Louvain functional modules over the call graph — structural parity with
 *  codebase-memory's community detection, computed from the final CAS graph. */
export function getCommunities(cas: CASOutput) {
  const communities = detectCommunities(
    (cas.nodes || []).map(n => n.id),
    (cas.edges || [])
      .filter(e => e.type === 'calls' || e.type === 'uses' || e.type === 'depends_on')
      .map(e => ({ source: e.source, target: e.target })),
  );
  const byId = new Map((cas.nodes || []).map(n => [n.id, n]));
  return {
    total: communities.length,
    communities: communities.map(c => ({
      id: c.id,
      size: c.members.length,
      internal_edges: c.internal_edges,
      members: c.members.map(id => byId.get(id)?.name || id).slice(0, 50),
    })),
  };
}

/** MinHash near-clone groups over function/method bodies — structural parity with
 *  codebase-memory's SIMILAR_TO edge. */
export function getClones(cas: CASOutput, opts: { threshold?: number } = {}) {
  const items = (cas.nodes || [])
    .filter(n => /function|method/.test(String(n.type)) && n.source?.raw)
    .map(n => ({ id: n.id, text: String(n.source!.raw) }));
  const byId = new Map((cas.nodes || []).map(n => [n.id, n]));
  const pairs = findNearClones(items, { threshold: opts.threshold ?? 0.8 });
  return {
    total: pairs.length,
    clones: pairs.map(p => ({
      a: byId.get(p.a)?.name || p.a,
      b: byId.get(p.b)?.name || p.b,
      similarity: Math.round(p.similarity * 100) / 100,
    })),
  };
}

/** Dead code: functions/methods with zero callers in the call graph, excluding
 *  entry points and tests — structural parity with codebase-memory's dead-code
 *  detection. (Exported-but-uncalled symbols are reported; they are API surface
 *  the caller can vet, the same simple definition the competition uses.) */
export function getDeadCode(cas: CASOutput) {
  const called = new Set(
    (cas.edges || [])
      .filter(e => e.type === 'calls' || e.type === 'uses' || e.type === 'depends_on')
      .map(e => e.target),
  );
  const entryIds = new Set(
    (cas.entry_points || []).map((e: any) => e?.node_id || e?.id).filter(Boolean),
  );
  const dead = (cas.nodes || []).filter(
    n =>
      /function|method/.test(String(n.type)) &&
      !called.has(n.id) &&
      !entryIds.has(n.id) &&
      !(n.metadata as any)?.is_entry_point &&
      !n.metadata?.is_test,
  );
  return {
    total: dead.length,
    functions: dead.slice(0, 500).map(n => ({
      name: n.name,
      type: n.type,
      file: n.source?.file,
      line: n.source?.line,
    })),
  };
}

export function getBehaviors(
  cas: CASOutput,
  opts: { limit?: number; offset?: number } = {}
) {
  const behaviors = cas.behaviors || [];
  const total = behaviors.length;
  const limit = opts.limit || 50;
  const offset = opts.offset || 0;

  const paginated = behaviors.slice(offset, offset + limit);

  const summaries = paginated.map(b => ({
    id: b.id,
    name: b.name,
    description: b.description,
    node_count: b.nodes?.length || 0,
    flow_steps: b.flow?.length || 0,
  }));

  return {
    total,
    offset,
    limit,
    behaviors: summaries,
    hint: 'Use get_behaviors with behavior_id for full detail including nodes and flow',
  };
}

export function getBehaviorDetail(cas: CASOutput, behaviorId: string) {
  const behavior = (cas.behaviors || []).find(b => b.id === behaviorId);
  if (!behavior) return null;

  const resolvedNodes = (behavior.nodes || []).map(nodeId => {
    const node = cas.nodes.find(n => n.id === nodeId);
    return node ? {
      id: nodeId,
      name: node.name,
      type: node.type,
      file: node.source?.file,
      line: node.source?.line,
    } : { id: nodeId };
  });

  return {
    ...behavior,
    resolved_nodes: resolvedNodes,
  };
}

function inferLifecyclePhase(name: string, behavior?: string): string {
  const lower = (name + ' ' + (behavior || '')).toLowerCase();
  if (lower.includes('init') || lower.includes('constructor') || lower.includes('create') || lower.includes('oninit')) return 'init';
  if (lower.includes('mount') || lower.includes('afterview') || lower.includes('ready') || lower.includes('connected') || lower.includes('onmoduleinit')) return 'mount';
  if (lower.includes('update') || lower.includes('change') || lower.includes('render') || lower.includes('docheck')) return 'update';
  if (lower.includes('destroy') || lower.includes('unmount') || lower.includes('cleanup') || lower.includes('disconnect') || lower.includes('onmoduledestroy')) return 'destroy';
  return 'other';
}

export function getLifecycleHooks(
  cas: CASOutput,
  opts: { phase?: string; framework?: string; limit?: number; offset?: number } = {}
) {
  const limit = opts.limit || 50;
  const offset = opts.offset || 0;
  const hooks: Array<{
    id: string;
    name: string;
    phase: string;
    framework: string;
    node_id: string;
    node_name: string;
    file?: string;
    line?: number;
    source: 'decorator' | 'entry_point' | 'method_call';
  }> = [];

  for (const dec of cas.decorators || []) {
    if (dec.semantic_meaning.category !== 'lifecycle') continue;
    if (opts.framework && dec.decorator_info.framework.toLowerCase() !== opts.framework.toLowerCase()) continue;

    const node = cas.nodes.find(n => n.id === dec.target_node);
    const phase = inferLifecyclePhase(dec.decorator_info.name, dec.semantic_meaning.behavior);

    if (opts.phase && phase !== opts.phase) continue;

    hooks.push({
      id: dec.id,
      name: dec.decorator_info.name,
      phase,
      framework: dec.decorator_info.framework,
      node_id: dec.target_node,
      node_name: node?.name || dec.target_node,
      file: dec.decorator_info.source_location?.file,
      line: dec.decorator_info.source_location?.line,
      source: 'decorator',
    });
  }

  for (const ep of cas.entry_points || []) {
    if (ep.type !== 'lifecycle') continue;
    const node = cas.nodes.find(n => n.id === ep.handler?.node_id);
    const framework = (ep.metadata?.framework as string) || 'unknown';
    if (opts.framework && framework.toLowerCase() !== opts.framework.toLowerCase()) continue;

    const phase = inferLifecyclePhase(ep.name, ep.description);

    if (opts.phase && phase !== opts.phase) continue;

    hooks.push({
      id: ep.id,
      name: ep.name,
      phase,
      framework,
      node_id: ep.handler?.node_id || '',
      node_name: node?.name || ep.name,
      file: ep.handler?.file,
      line: ep.handler?.line,
      source: 'entry_point',
    });
  }

  const byPhase: Record<string, number> = {};
  for (const h of hooks) {
    byPhase[h.phase] = (byPhase[h.phase] || 0) + 1;
  }

  return {
    total: hooks.length,
    by_phase: byPhase,
    offset,
    limit,
    hooks: hooks.slice(offset, offset + limit),
  };
}

export function getPatternInstances(cas: CASOutput, patternId: string, opts: { variation_id?: string; limit?: number; offset?: number } = {}) {
  const pattern = (cas.patterns || []).find(p => p.id === patternId);
  if (!pattern) return null;

  const limit = opts.limit || 50;
  const offset = opts.offset || 0;

  if (opts.variation_id) {
    const variation = (pattern.variations || []).find(v => v.id === opts.variation_id);
    if (!variation) return { error: `Variation not found: ${opts.variation_id}` };
    const instances = variation.instances || [];
    return {
      pattern_id: patternId,
      pattern_name: pattern.name,
      variation_id: variation.id,
      variation_description: variation.description,
      total_instances: instances.length,
      offset,
      limit,
      instances: instances.slice(offset, offset + limit),
    };
  }

  const instances = pattern.instances || [];
  return {
    pattern_id: patternId,
    pattern_name: pattern.name,
    total_instances: instances.length,
    offset,
    limit,
    instances: instances.slice(offset, offset + limit),
  };
}

export function getPerspectives(cas: CASOutput) {
  return cas.perspectives || [];
}

/**
 * Returns behavioral (flows/capabilities) and structural (architectural
 * conflicts + paradigm conformance) perspectives cross-referenced in one call,
 * each annotated with links into the other. Pure composition over the three
 * existing accessors — does not change or duplicate their own outputs.
 * `target` narrows flows the same way get_flow_concepts does.
 */
export function getUnifiedPerspectives(
  cas: CASOutput,
  opts: { target?: string; maxFlows?: number; severity?: 'low' | 'medium' | 'high' } = {}
) {
  const flowResult = getFlowConcepts(cas, {
    target: opts.target,
    maxFlows: opts.maxFlows ?? 10,
    includeStructural: true,
  });
  const architectural = getArchitecturalConflicts(cas, { severity: opts.severity, includeFlowLinks: true });
  const paradigms = getParadigmConformance(cas);

  const gaps: string[] = [...(flowResult.gaps || [])];
  if ((cas.architectural_conflicts === undefined) && (cas.principle_violations === undefined)) {
    gaps.push('No architectural_conflicts/principle_violations on this analysis — structural perspective is incomplete.');
  }
  if (cas.paradigm_conformance === undefined) {
    gaps.push('No paradigm_conformance on this analysis — paradigm perspective is incomplete.');
  }

  return {
    behavioral: {
      flows: flowResult.flows,
      total: flowResult.total,
    },
    structural: {
      architectural_conflicts: architectural.conflicts,
      principle_violations: architectural.principle_violations,
      is_cohesive: architectural.is_cohesive,
      paradigms: paradigms.paradigms,
    },
    cross_links_summary: {
      flows_with_layer: flowResult.flows.filter((f: any) => (f.structural?.layers?.length || 0) > 0).length,
      flows_with_paradigm_deviations: flowResult.flows.filter((f: any) => (f.structural?.paradigm_deviations?.length || 0) > 0).length,
      conflicts_linked_to_flows: architectural.conflicts.filter((c: any) => c.flow_links).length,
      violations_linked_to_flows: architectural.principle_violations.filter((v: any) => v.flow_links).length,
    },
    gaps: gaps.length ? gaps : undefined,
  };
}

export function findTests(cas: CASOutput, opts: { nodeId?: string; filePath?: string; limit?: number; offset?: number }) {
  const suites = cas.test_suites || [];
  const mocks = cas.mocks || [];
  const fixtures = cas.fixtures || [];
  const limit = opts.limit || 25;
  const offset = opts.offset || 0;

  if (opts.nodeId) {
    const node = cas.nodes.find(n => n.id === opts.nodeId);
    const rankedSuites = rankTestSuitesForNode(cas, suites, opts.nodeId, node);
    const relevantSuites = rankedSuites.map(match => match.suite);
    const relevantMocks = mocks.filter(m =>
      m.target_node === opts.nodeId || m.used_by?.includes(opts.nodeId!)
    );
    return {
      total_suites: relevantSuites.length,
      suites: relevantSuites.slice(offset, offset + limit),
      mocks: relevantMocks,
      fixtures,
      resolution: {
        strategy: 'explicit-coverage-plus-related-test-files',
        node_file: node?.source?.file || null,
        matches: rankedSuites.slice(offset, offset + limit).map(match => ({
          file_path: match.suite.file_path,
          reason: match.reason,
          score: match.score,
        })),
      },
    };
  }

  if (opts.filePath) {
    const normalized = normalizeProjectPathForQuery(opts.filePath);
    const rankedSuites = uniqueSuitesForQuery(suites
      .map(suite => {
        const testFile = normalizeProjectPathForQuery(suite.file_path);
        const score = testFile.includes(normalized)
          ? 100
          : relatedTestCandidates(normalized).some(candidate => projectPathsMatchForQuery(testFile, candidate)) ? 90
            : pathStemForQuery(testFile) === pathStemForQuery(normalized) ? 65
              : 0;
        return { suite, score, reason: score >= 90 ? 'file path match' : score > 0 ? 'related test filename' : '' };
      })
      .filter(match => match.score > 0)
      .sort((left, right) => right.score - left.score));
    const relevantSuites = rankedSuites.map(match => match.suite);
    return {
      total_suites: relevantSuites.length,
      suites: relevantSuites.slice(offset, offset + limit),
      mocks,
      fixtures,
      resolution: {
        strategy: 'file-path-plus-related-test-files',
        file_path: opts.filePath,
        matches: rankedSuites.slice(offset, offset + limit).map(match => ({
          file_path: match.suite.file_path,
          reason: match.reason,
          score: match.score,
        })),
      },
    };
  }

  return {
    total_suites: suites.length,
    total_mocks: mocks.length,
    total_fixtures: fixtures.length,
    offset,
    limit,
    suites: suites.slice(offset, offset + limit),
    mocks: mocks.slice(offset, offset + limit),
    fixtures: fixtures.slice(offset, offset + limit),
  };
}

function rankTestSuitesForNode(cas: CASOutput, suites: CASTestSuite[], nodeId: string, node?: CASNode) {
  const nodeFile = node?.source?.file ? normalizeProjectPathForQuery(node.source.file) : '';
  const candidates = nodeFile ? relatedTestCandidates(nodeFile) : [];
  const nodeStem = nodeFile ? pathStemForQuery(nodeFile) : '';
  return uniqueSuitesForQuery(suites
    .map(suite => {
      const testFile = normalizeProjectPathForQuery(suite.file_path);
      const coversNode = suite.coverage?.nodes_tested?.includes(nodeId) || suite.tests.some(test => test.targets?.includes(nodeId));
      const colocated = candidates.some(candidate => projectPathsMatchForQuery(testFile, candidate));
      const sameStem = Boolean(nodeStem && pathStemForQuery(testFile) === nodeStem);
      const score = coversNode ? 100 : colocated ? 90 : sameStem ? 65 : 0;
      const reason = coversNode ? 'explicit CAS coverage' : colocated ? 'co-located test file' : sameStem ? 'matching test filename' : '';
      return { suite, score, reason };
    })
    .filter(match => match.score > 0)
    .sort((left, right) => right.score - left.score));
}

function uniqueSuitesForQuery(matches: Array<{ suite: CASTestSuite; score: number; reason: string }>) {
  const seen = new Set<string>();
  const unique: Array<{ suite: CASTestSuite; score: number; reason: string }> = [];
  for (const match of matches) {
    if (seen.has(match.suite.file_path)) continue;
    seen.add(match.suite.file_path);
    unique.push(match);
  }
  return unique;
}

function relatedTestCandidates(sourceFile: string): string[] {
  const dir = sourceFile.includes('/') ? sourceFile.split('/').slice(0, -1).join('/') : '';
  const base = sourceFile.split('/').pop() || sourceFile;
  const stem = base.replace(/\.[^.]+$/, '');
  return [
    sourceFile.replace(/\.([cm]?[jt]sx?)$/, '.spec.$1'),
    sourceFile.replace(/\.([cm]?[jt]sx?)$/, '.test.$1'),
    sourceFile.replace(/\.py$/, '_test.py'),
    sourceFile.replace(/\.py$/, '.test.py'),
    sourceFile.endsWith('.py') && dir ? `${dir}/test_${stem}.py` : '',
    sourceFile.endsWith('.py') ? `tests/test_${stem}.py` : '',
    ...pythonApiTestCandidatesForQuery(sourceFile),
    sourceFile.replace(/\.go$/, '_test.go'),
    sourceFile.replace(/\.rs$/, '_test.rs'),
  ].filter(Boolean);
}

function pythonApiTestCandidatesForQuery(sourceFile: string): string[] {
  const normalized = sourceFile.toLowerCase();
  if (!sourceFile.endsWith('.py')) return [];
  if (!/(^|\/)(api|routes|views|controllers)(\/|$)/.test(normalized) && !/(^|\/)(app|main)\.py$/.test(normalized)) return [];
  return [
    'tests/test_api.py',
    'tests/test_app.py',
    'tests/test_routes.py',
  ];
}

function normalizeProjectPathForQuery(file: string): string {
  return file.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
}

function projectPathsMatchForQuery(left: string, right: string): boolean {
  const normalizedLeft = normalizeProjectPathForQuery(left);
  const normalizedRight = normalizeProjectPathForQuery(right);
  return normalizedLeft === normalizedRight || normalizedLeft.endsWith(`/${normalizedRight}`) || normalizedRight.endsWith(`/${normalizedLeft}`);
}

function pathStemForQuery(file: string): string {
  const base = file.split('/').pop() || file;
  return base
    .replace(/\.(spec|test)\.([cm]?[jt]sx?)$/i, '')
    .replace(/^test_/, '')
    .replace(/_test\.(py|go|rs)$/i, '')
    .replace(/\.test\.py$/i, '')
    .replace(/\.([cm]?[jt]sx?|py|go|rs)$/i, '')
    .toLowerCase();
}

const TEST_GAP_SEVERITY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

export function getTestSummary(
  cas: CASOutput,
  opts: { gapType?: string; severity?: string; limit?: number; offset?: number } = {},
) {
  const allGaps = cas.test_gaps || [];
  const filtered = allGaps.filter(gap =>
    (!opts.gapType || gap.gap_type === opts.gapType) &&
    (!opts.severity || gap.severity === opts.severity));
  const sorted = [...filtered].sort((a, b) =>
    (TEST_GAP_SEVERITY_RANK[a.severity] ?? 4) - (TEST_GAP_SEVERITY_RANK[b.severity] ?? 4));
  const offset = Math.max(0, opts.offset || 0);
  const limit = Math.max(1, Math.min(opts.limit || 25, 200));
  const page = sorted.slice(offset, offset + limit);
  const countBy = (key: 'severity' | 'gap_type') => allGaps.reduce((counts, gap) => {
    const value = gap[key];
    counts[value] = (counts[value] || 0) + 1;
    return counts;
  }, {} as Record<string, number>);

  const coverage = cas.test_coverage || null;
  const componentEntries = Object.entries(coverage?.by_component || {});
  const testCoverage = coverage
    ? {
      summary: coverage.summary || null,
      by_level: coverage.by_level || null,
      component_count: componentEntries.length,
      worst_covered_components: componentEntries
        .map(([component, detail]) => ({
          component,
          coverage: detail?.coverage ?? null,
          untested_node_count: (detail?.untested_nodes || []).length,
        }))
        .sort((a, b) => (a.coverage ?? -1) - (b.coverage ?? -1))
        .slice(0, 10),
      test_relationship_count: (coverage.test_relationships || []).length,
    }
    : null;

  return {
    test_summary: cas.test_summary || null,
    gap_summary: {
      total: allGaps.length,
      matching: filtered.length,
      returned: page.length,
      offset,
      by_severity: countBy('severity'),
      by_type: countBy('gap_type'),
    },
    test_gaps: page,
    test_coverage: testCoverage,
    ...(filtered.length > offset + page.length
      ? { continuation: `Returned ${page.length} of ${filtered.length} matching gaps sorted by severity. Page with offset/limit, or narrow with gap_type (untested-flow, untested-branch, mock-only, no-assertions) and severity (critical, high, medium, low). Use find_tests for per-node coverage.` }
      : {}),
  };
}

export function getDatabaseSchema(cas: CASOutput) {
  return cas.database_schema || null;
}

// --- Entity-Relationship model (ERD) -----------------------------------------
//
// The ORM analyzers + entity extraction already give us `cas.database_schema`
// (entities, fields, and `relationships` carrying an ORM relation kind + target
// + field). `buildErd` reshapes THAT — it does not re-extract — into a
// structured entity-relationship model plus a renderable Mermaid `erDiagram`.
//
// Evidence-gating: every relationship edge comes from a real ORM relation
// declaration (decorator, typed edge, attribute, or Eloquent method) captured on
// an entity's `relationships[]`. We never invent an edge from a field name that
// merely looks like a foreign key. When the relation kind is present but its
// cardinality is not one of the four known ORM kinds, we label the edge
// `unknown` rather than guessing a cardinality.

export type ErdCardinality = 'one-to-one' | 'one-to-many' | 'many-to-one' | 'many-to-many' | 'unknown';

export interface ErdField {
  name: string;
  type: string;
  pk?: boolean;
  fk?: boolean;
  unique?: boolean;
  nullable?: boolean;
}

export interface ErdEntity {
  name: string;
  table?: string;
  source_file?: string;
  fields: ErdField[];
  /** Repos this entity appears in (only set when a workspace analysis spans repos). */
  repos?: string[];
  cross_repo?: boolean;
}

export interface ErdRelationship {
  from: string;
  to: string;
  cardinality: ErdCardinality;
  /** The declaring field / relation-method name on `from`. */
  field?: string;
  join_table?: string;
  /** How the relation kind was grounded, e.g. the raw ORM relation type. */
  evidence: string;
}

export interface ErdModel {
  orm?: string;
  entities: ErdEntity[];
  relationships: ErdRelationship[];
  cardinality_breakdown: Record<ErdCardinality, number>;
  cross_repo?: {
    /** Entity names that appear in more than one repo in the workspace. */
    shared_entities: string[];
    repos: string[];
  };
}

const ERD_RELATION_KIND_TO_CARDINALITY: Record<string, ErdCardinality> = {
  OneToOne: 'one-to-one',
  OneToMany: 'one-to-many',
  ManyToOne: 'many-to-one',
  ManyToMany: 'many-to-many',
};

/** The extractor's normalized cardinality -> the ERD vocabulary. */
const ERD_EXTRACTED_CARDINALITY: Record<string, ErdCardinality> = {
  '1:1': 'one-to-one',
  '1:N': 'one-to-many',
  'N:1': 'many-to-one',
  'N:M': 'many-to-many',
};

// The Mermaid crow's-foot notation for the LEFT->RIGHT reading of the edge.
// `from` side first. e.g. one-to-many: from ||--o{ to.
const ERD_CARDINALITY_TO_MERMAID: Record<ErdCardinality, string> = {
  'one-to-one': '||--||',
  'one-to-many': '||--o{',
  'many-to-one': '}o--||',
  'many-to-many': '}o--o{',
  unknown: '..',
};

/**
 * Build a structured ERD model from `cas.database_schema`. Optionally accepts a
 * workspace analysis to annotate entities that span multiple repos (the same
 * entity/relationship graph spanning repos). Returns an empty (non-crashing)
 * model when the repo has no entities.
 */
export function buildErd(
  cas: CASOutput,
  opts: { entityName?: string; workspace?: { entities?: Array<{ name: string; project_ids?: string[] }>; project_ids?: string[] } } = {},
): ErdModel {
  const schema = cas.database_schema;
  const emptyBreakdown = (): Record<ErdCardinality, number> => ({
    'one-to-one': 0, 'one-to-many': 0, 'many-to-one': 0, 'many-to-many': 0, unknown: 0,
  });

  // The relation graph from EVERY carrier, not just `database_schema`. An ORM
  // whose analyzer emits relation EDGES (rather than property decorators) used
  // to leave `database_schema.entities[].relationships` nearly empty, and a
  // typed-composition data model left it entirely empty — in both cases the
  // ERD rendered a set of disconnected boxes even though the relations were
  // provable from the stored graph. Reading the shared extractor here also
  // means an analysis stored BEFORE relations were persisted still renders.
  const relationGraph = buildEntityRelationIndex(cas);

  if (!schema || !schema.entities || schema.entities.length === 0) {
    return { orm: schema?.orm, entities: [], relationships: [], cardinality_breakdown: emptyBreakdown() };
  }

  const wantEntity = opts.entityName?.toLowerCase();

  // Cross-repo annotation: which entity names appear in >1 repo of the workspace.
  const sharedEntityNames = new Set<string>();
  const wsRepos = new Set<string>();
  const wsEntities = opts.workspace?.entities || [];
  for (const we of wsEntities) {
    const projects = we.project_ids || [];
    projects.forEach(p => wsRepos.add(p));
    if (projects.length > 1) sharedEntityNames.add(we.name.toLowerCase());
  }
  const wsEntityRepos = new Map<string, string[]>();
  for (const we of wsEntities) {
    if (we.project_ids && we.project_ids.length) wsEntityRepos.set(we.name.toLowerCase(), we.project_ids);
  }

  // NON-PERSISTED SHAPES ARE NOT ERD ENTITIES. `data_entities` carries the
  // deterministic kind, so a shape the analyzer classified as a domain
  // shape/DTO/value object is excluded here even when it reached
  // `database_schema` (an analysis stored before the producer-side persistence
  // gate, or a schema carrier that admitted a type on its location). Exclusion
  // requires an explicit non-persisted classification: a name ABSENT from
  // `data_entities`, or one with no kind at all, is left alone — absence is not
  // evidence. Dropping the box also drops its edges, since every relationship
  // below is gated on both endpoints being in the entity set.
  const nonPersistedNames = new Set<string>();
  for (const entity of cas.data_entities || []) {
    if (entity.kind && entity.kind !== 'persisted-entity') {
      nonPersistedNames.add(entity.name.toLowerCase());
    }
  }
  const schemaEntities = schema.entities.filter(e => !nonPersistedNames.has(e.name.toLowerCase()));

  const knownEntityNames = new Set(schemaEntities.map(e => e.name));

  const entities: ErdEntity[] = [];
  const relationships: ErdRelationship[] = [];
  const breakdown = emptyBreakdown();
  const relSeen = new Set<string>();
  // (entity|field) pairs whose relation is already drawn. A field declares AT
  // MOST ONE association, so a second carrier reading the same field with a
  // different cardinality (a typed-composition `1:1` over a decorator's `N:1`)
  // must not draw a second edge — that would render every relation twice.
  const relFieldClaimed = new Set<string>();

  for (const ent of schemaEntities) {
    if (wantEntity && ent.name.toLowerCase() !== wantEntity) {
      // Still allow it to appear if it is the TARGET of a wanted entity's
      // relationship — handled below by not filtering targets out of the graph.
    }

    // Foreign-key fields: a scalar field whose name matches a relation's join
    // field, or ends in a conventional `_id`/`Id` suffix AND names a known
    // entity. Only the former is strictly evidence-backed; the suffix heuristic
    // is a labelling aid (fk?), never a source of relationship edges.
    const relationFieldNames = new Set([
      ...((ent.relationships || []).map(r => r.field).filter(Boolean) as string[]),
      ...(relationGraph.relationFieldsByEntityNameLower.get(ent.name.toLowerCase()) || []),
    ]);

    const fields: ErdField[] = (ent.fields || []).map(f => {
      const looksFk =
        relationFieldNames.has(f.name) ||
        /(_id|Id)$/.test(f.name) && knownEntityNames.has(fkTargetGuess(f.name));
      return {
        name: f.name,
        type: f.type || 'unknown',
        pk: f.primary || undefined,
        fk: looksFk || undefined,
        unique: f.unique || undefined,
        nullable: f.nullable || undefined,
      };
    });

    const nameKey = ent.name.toLowerCase();
    const repos = wsEntityRepos.get(nameKey);
    entities.push({
      name: ent.name,
      table: ent.table,
      source_file: ent.source_file,
      fields,
      repos: repos && repos.length ? repos : undefined,
      cross_repo: sharedEntityNames.has(nameKey) || undefined,
    });

    // Evidence-gated relationships: one edge per declared ORM relation.
    for (const rel of ent.relationships || []) {
      if (!rel.target) continue;
      const cardinality: ErdCardinality = ERD_RELATION_KIND_TO_CARDINALITY[rel.type] || 'unknown';
      // Dedup on (from|kind|to|field) so a decorator + typed-edge description of
      // the SAME relation don't double-count.
      const key = `${ent.name}|${cardinality}|${rel.target}|${rel.field || ''}`.toLowerCase();
      if (relSeen.has(key)) continue;
      relSeen.add(key);
      if (rel.field) relFieldClaimed.add(`${ent.name}|${rel.field}`.toLowerCase());
      relationships.push({
        from: ent.name,
        to: rel.target,
        cardinality,
        field: rel.field || undefined,
        join_table: rel.join_table || undefined,
        evidence: `ORM relation ${rel.type}${rel.field ? ` via ${rel.field}` : ''}`,
      });
      breakdown[cardinality] += 1;
    }
  }

  // Relations from the shared extractor, for every entity already in the
  // diagram. Same evidence gate: the target must be a known entity. Dedupe is
  // shared with the database_schema pass above via `relSeen`, so a relation
  // proved by both carriers renders once.
  const erdEntityNames = new Map(entities.map(e => [e.name.toLowerCase(), e.name]));
  for (const [sourceKey, relations] of relationGraph.dataByEntityNameLower) {
    const fromName = erdEntityNames.get(sourceKey);
    if (!fromName) continue;
    for (const relation of relations) {
      const toName = erdEntityNames.get(relation.targetName.toLowerCase());
      if (!toName) continue;
      const cardinality: ErdCardinality =
        ERD_EXTRACTED_CARDINALITY[relation.cardinality || ''] ||
        ERD_RELATION_KIND_TO_CARDINALITY[relation.relationType] ||
        'unknown';
      const key = `${fromName}|${cardinality}|${toName}|${relation.field || ''}`.toLowerCase();
      if (relSeen.has(key)) continue;
      if (relation.field && relFieldClaimed.has(`${fromName}|${relation.field}`.toLowerCase())) continue;
      relSeen.add(key);
      if (relation.field) relFieldClaimed.add(`${fromName}|${relation.field}`.toLowerCase());
      relationships.push({
        from: fromName,
        to: toName,
        cardinality,
        field: relation.field || undefined,
        join_table: relation.joinTable || undefined,
        evidence: relation.evidence,
      });
      breakdown[cardinality] += 1;
    }
  }

  // Entity filter: when an entity is named, keep it, its direct neighbours, and
  // only the edges touching it — so the ERD is a focused subgraph, not a lie.
  let outEntities = entities;
  let outRelationships = relationships;
  if (wantEntity) {
    const neighbours = new Set<string>([wantEntity]);
    for (const r of relationships) {
      if (r.from.toLowerCase() === wantEntity) neighbours.add(r.to.toLowerCase());
      if (r.to.toLowerCase() === wantEntity) neighbours.add(r.from.toLowerCase());
    }
    outEntities = entities.filter(e => neighbours.has(e.name.toLowerCase()));
    outRelationships = relationships.filter(
      r => r.from.toLowerCase() === wantEntity || r.to.toLowerCase() === wantEntity,
    );
    // Recompute breakdown for the focused view.
    const fb = emptyBreakdown();
    for (const r of outRelationships) fb[r.cardinality] += 1;
    return {
      orm: schema.orm,
      entities: outEntities,
      relationships: outRelationships,
      cardinality_breakdown: fb,
      ...(wsRepos.size ? { cross_repo: { shared_entities: [...sharedEntityNames], repos: [...wsRepos] } } : {}),
    };
  }

  return {
    orm: schema.orm,
    entities: outEntities,
    relationships: outRelationships,
    cardinality_breakdown: breakdown,
    ...(wsRepos.size ? { cross_repo: { shared_entities: [...sharedEntityNames], repos: [...wsRepos] } } : {}),
  };
}

function fkTargetGuess(fieldName: string): string {
  // `userId` / `user_id` -> `User`. Best-effort, only used to LABEL a field as
  // fk when the guessed target is a known entity; never emits a relationship.
  const base = fieldName.replace(/(_id|Id)$/, '');
  const camel = base.replace(/[_-](\w)/g, (_, c) => c.toUpperCase());
  return camel.charAt(0).toUpperCase() + camel.slice(1);
}

/** Render a Mermaid `erDiagram` string from an ERD model. */
export function erdToMermaid(model: ErdModel): string {
  const lines: string[] = ['erDiagram'];
  const safe = (n: string) => n.replace(/[^A-Za-z0-9_]/g, '_');

  for (const ent of model.entities) {
    const header = ent.cross_repo ? `  ${safe(ent.name)} {` : `  ${safe(ent.name)} {`;
    lines.push(header);
    if (ent.fields.length === 0) {
      // Mermaid needs at least a valid block; emit nothing inside is allowed but
      // some renderers dislike empty blocks, so annotate presence.
    }
    for (const f of ent.fields) {
      const type = safe(f.type || 'unknown') || 'unknown';
      const tags: string[] = [];
      if (f.pk) tags.push('PK');
      if (f.fk) tags.push('FK');
      const comment = f.unique || f.nullable
        ? ` "${[f.unique ? 'unique' : '', f.nullable ? 'nullable' : ''].filter(Boolean).join(', ')}"`
        : '';
      lines.push(`    ${type} ${safe(f.name)}${tags.length ? ` ${tags.join(',')}` : ''}${comment}`);
    }
    lines.push('  }');
  }

  for (const rel of model.relationships) {
    const conn = ERD_CARDINALITY_TO_MERMAID[rel.cardinality];
    const label = rel.field || (rel.cardinality === 'unknown' ? 'relates' : 'has');
    lines.push(`  ${safe(rel.from)} ${conn} ${safe(rel.to)} : "${label}"`);
  }

  return lines.join('\n');
}

/**
 * Public ERD query used by the MCP tool / CLI / HTTP. Returns the structured
 * model plus a Mermaid `erDiagram`. `format` narrows the payload.
 */
export function getErd(
  cas: CASOutput,
  opts: { entityName?: string; format?: 'json' | 'mermaid'; workspace?: Parameters<typeof buildErd>[1] extends infer O ? O : never } = {},
) {
  const model = buildErd(cas, { entityName: opts.entityName, workspace: (opts as any).workspace });
  const mermaid = erdToMermaid(model);
  if (opts.format === 'mermaid') return { mermaid };
  if (opts.format === 'json') return model;
  return { ...model, mermaid };
}

export function getImplementationHealth(cas: CASOutput) {
  return cas.implementation_health || null;
}

export function getSystemHealth(cas: CASOutput) {
  return cas.system_health || null;
}

export function getDocumentationCoverage(cas: CASOutput) {
  return cas.documentation_summary || null;
}

export function getTodos(cas: CASOutput) {
  return cas.todos_summary || null;
}

export function getDependencies(cas: CASOutput) {
  // Package-manager dependencies are parsed into cas.libraries (name/version/type/
  // package_manager); the cas.dependencies summary is rarely populated. Build the
  // real dependency view from the manifest-backed libraries so the tool returns
  // versions + counts instead of null.
  const libs = (cas.libraries || []) as Array<{ name?: string; version?: string; type?: string; package_manager?: string; security?: { vulnerabilities?: unknown[] }; license?: string }>;
  const manifestDeps = libs.filter(lib => lib.package_manager && lib.version);
  if (manifestDeps.length === 0) return cas.dependencies || { direct_count: 0, total_count: 0, packages: [] };
  const byType = (t: string) => manifestDeps.filter(d => (d.type || 'production') === t);
  const packages = manifestDeps
    .map(d => ({
      name: d.name,
      version: d.version,
      type: d.type || 'production',
      package_manager: d.package_manager,
      license: d.license,
      vulnerabilities: d.security?.vulnerabilities?.length || 0,
    }))
    .sort((a, b) => (a.type === b.type ? String(a.name).localeCompare(String(b.name)) : a.type.localeCompare(b.type)));
  return {
    direct_count: byType('production').length,
    dev_count: byType('development').length,
    peer_count: byType('peer').length,
    total_count: manifestDeps.length,
    critical_vulnerabilities: packages.reduce((sum, p) => sum + p.vulnerabilities, 0),
    package_managers: [...new Set(manifestDeps.map(d => d.package_manager))],
    packages,
    summary: cas.dependencies,
  };
}

export function getLibraries(cas: CASOutput, opts: { query?: string; limit?: number; offset?: number } = {}) {
  let libraries = cas.libraries || [];
  if (opts.query) {
    const q = opts.query.toLowerCase();
    libraries = libraries.filter(l =>
      l.name.toLowerCase().includes(q) ||
      (l.category && l.category.toLowerCase().includes(q))
    );
  }
  const total = libraries.length;
  const limit = opts.limit || 25;
  const offset = opts.offset || 0;

  const summarized = libraries.slice(offset, offset + limit).map(l => ({
    id: l.id,
    name: l.name,
    version: l.version,
    type: l.type,
    category: l.category,
    package_manager: l.package_manager,
    description: l.description,
    size: l.size,
    security: l.security,
    usage_statistics: l.usage_statistics,
    migration_complexity: l.migration_complexity,
    replacement_feasibility: l.replacement_feasibility,
    usage_pattern_count: l.usage_patterns?.length || 0,
    usage_patterns_summary: (l.usage_patterns || []).slice(0, 3).map(p => ({
      pattern: p.pattern,
      occurrences: p.occurrences,
      function_count: p.functions_used?.length || 0,
    })),
    related_library_count: l.related_libraries?.length || 0,
    alternative_library_count: l.alternative_libraries?.length || 0,
    connected_node_count: l.connected_nodes?.length || 0,
    optimization_count: l.optimization_opportunities?.length || 0,
    optimization_opportunities: l.optimization_opportunities,
  }));

  return { total, offset, limit, libraries: summarized };
}

/**
 * Self-discovered coverage gaps (see analyzer/core/coverage-gaps.ts): unknown
 * dependencies matching no analyzer, low node-extraction-ratio files, roots
 * with zero entry points, and unhandled tree-sitter node types. This is the
 * queryable surface for "what does this analysis NOT understand yet" — the
 * mechanism that makes gap-closing systematic instead of ad hoc.
 */
export function getCoverageGaps(
  cas: CASOutput,
  opts: { kind?: string; severity?: string; limit?: number; offset?: number } = {}
) {
  let gaps = cas.coverage_gaps || [];
  if (opts.kind) {
    gaps = gaps.filter(g => g.kind === opts.kind);
  }
  if (opts.severity) {
    gaps = gaps.filter(g => g.severity === opts.severity);
  }
  const total = gaps.length;
  const limit = opts.limit || 50;
  const offset = opts.offset || 0;

  const bySeverityOrder: Record<string, number> = { high: 0, medium: 1, low: 2 };
  const sorted = [...gaps].sort((a, b) => (bySeverityOrder[a.severity] ?? 3) - (bySeverityOrder[b.severity] ?? 3));

  const byKind: Record<string, number> = {};
  for (const g of cas.coverage_gaps || []) {
    byKind[g.kind] = (byKind[g.kind] || 0) + 1;
  }

  return {
    total,
    offset,
    limit,
    codebase_type: cas.codebase_type,
    codebase_type_confidence: cas.codebase_type_confidence,
    summary: {
      total_gaps: (cas.coverage_gaps || []).length,
      by_kind: byKind,
    },
    gaps: sorted.slice(offset, offset + limit),
  };
}

/**
 * Levenshtein edit distance, used only for short identifier-length strings
 * (fuzzy near-name matching below) — not intended for long text.
 */
function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const prev = new Array(n + 1);
  const curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= n; j++) prev[j] = curr[j];
  }
  return prev[n];
}

/**
 * Builds a graceful "target not found" result shared by getCodingContext and
 * getInterfaceSignature: (a) frames the miss as CAS-relative, not absolute —
 * the analysis may simply be stale, not the guess wrong, (b) surfaces an
 * analysis-age hint (this function has no git access to run the full
 * freshness scan itself), (c) points at get_server_version if the
 * tool/analysis itself seems unavailable, and (d) offers fuzzy near-name
 * matches so a typo or stale name still gets somewhere useful.
 */
function buildTargetNotFoundResult(cas: CASOutput, target: string, toolName: string) {
  const query = target.trim();
  const queryLower = query.toLowerCase();

  // Near-name matches: prefer substring hits (cheap, high precision for partial/
  // renamed identifiers), then fall back to edit-distance for typos, scored over
  // named nodes only (searching all ~tens-of-thousands of nodes by full edit
  // distance would be wasteful; substring first keeps this cheap in the common case).
  const namedNodes = cas.nodes.filter(n => typeof n.name === 'string' && n.name.length > 0);
  const substringMatches = namedNodes.filter(n => n.name.toLowerCase().includes(queryLower) || queryLower.includes(n.name.toLowerCase()));

  const scored = (substringMatches.length > 0 ? substringMatches : namedNodes)
    .map(n => ({
      node: n,
      distance: substringMatches.length > 0 ? 0 : levenshteinDistance(queryLower, n.name.toLowerCase()),
    }))
    .filter(({ node, distance }) => substringMatches.includes(node) || distance <= Math.max(2, Math.ceil(queryLower.length * 0.4)))
    .sort((a, b) => a.distance - b.distance || a.node.name.length - b.node.name.length)
    .slice(0, 5)
    .map(({ node }) => ({
      id: node.id,
      name: node.name,
      type: node.type,
      file: node.source?.file,
    }));

  // Analysis-age hint: this function only has the CAS payload (no project path
  // or git access), so it can't run the real staleness scan (see
  // get_analysis_freshness / getFreshAnalysisForAgent for that). It surfaces the
  // one staleness-relevant fact it does have — how old the stored analysis is —
  // so an agent isn't left guessing whether "not found" means "doesn't exist" or
  // "analysis predates this symbol".
  let analysisAgeHint: string | undefined;
  if (cas.analysis_timestamp) {
    const analyzedAt = new Date(cas.analysis_timestamp);
    if (!Number.isNaN(analyzedAt.getTime())) {
      const ageMs = Date.now() - analyzedAt.getTime();
      const ageMinutes = Math.max(0, Math.round(ageMs / 60000));
      analysisAgeHint = ageMinutes < 5
        ? `Analysis is recent (${ageMinutes}m old); "${target}" likely does not exist under this name, or is defined somewhere this analysis doesn't cover.`
        : `Analysis was generated ${ageMinutes}m ago. If "${target}" was added, renamed, or moved since then, this analysis won't know about it — call get_analysis_freshness (or re-run analyze_codebase) before concluding it doesn't exist.`;
    }
  }

  return {
    error: `Target not found in the current analysis: ${target}`,
    target,
    near_matches: scored,
    analysis_age_hint: analysisAgeHint,
    next_steps: [
      'Call get_analysis_freshness on this project path to check whether the analysis is stale relative to source files, and re-run analyze_codebase if so.',
      scored.length > 0
        ? 'Review near_matches below — one of them may be the renamed/actual target.'
        : 'Try search_nodes with a broader or partial query to locate the target by name or description.',
      `If ${toolName} itself seems to be missing or misbehaving (not just this target), call get_server_version to confirm the server/tool version in use.`,
    ],
  };
}

export function getCodingContext(
  cas: CASOutput,
  target: string,
  opts: {
    task_type?: 'add' | 'modify' | 'delete' | 'refactor';
    include?: string[];
    caller_limit?: number;
    callee_limit?: number;
    runtimeMetrics?: RuntimeMetricLike[];
  } = {}
) {
  const taskType = opts.task_type || 'modify';
  const includeAll = !opts.include || opts.include.length === 0;
  const shouldInclude = (section: string) => includeAll || opts.include?.includes(section);
  const callerLimit = opts.caller_limit && opts.caller_limit > 0 ? opts.caller_limit : 10;
  const calleeLimit = opts.callee_limit && opts.callee_limit > 0 ? opts.callee_limit : 10;
  // Large-but-bounded probe used only to learn the true caller/callee count so we can
  // report `callers_total`/`callees_total` and a `truncated` flag instead of silently
  // dropping entries past the display limit (see docs/SPEC-RESPONSE-BUDGET.md).
  const UNCAPPED_COUNT_PROBE = 5000;

  let targetNode: CASNode | undefined;
  if (target.includes('/') || target.includes('.')) {
    const fileNodes = cas.nodes.filter(n =>
      n.source?.file?.endsWith(target) || n.id === target
    );
    targetNode = fileNodes.find(n => n.type === 'class' || n.type === 'module' || n.type === 'function') || fileNodes[0];
  } else {
    targetNode = cas.nodes.find(n => n.id === target);
    if (!targetNode) {
      const searchResults = searchNodes(cas, target, { limit: 1 });
      if (searchResults.length > 0) {
        targetNode = cas.nodes.find(n => n.id === searchResults[0].id);
      }
    }
  }

  if (!targetNode) {
    return buildTargetNotFoundResult(cas, target, 'get_coding_context');
  }

  const determineLayer = (node: CASNode): 'entry' | 'business' | 'data' | 'infrastructure' => {
    const entryTypes = ['controller', 'gateway', 'resolver', 'handler', 'page', 'route', 'api_route'];
    const dataTypes = ['entity', 'repository', 'model', 'schema', 'migration'];
    const infraTypes = ['config', 'middleware', 'guard', 'interceptor', 'filter', 'pipe', 'decorator'];

    if (entryTypes.includes(node.type)) return 'entry';
    if (dataTypes.includes(node.type)) return 'data';
    if (infraTypes.includes(node.type)) return 'infrastructure';

    const isEntryPoint = (cas.entry_points || []).some(ep =>
      ep.source_node === node.id || ep.handler?.node_id === node.id
    );
    if (isEntryPoint) return 'entry';

    return 'business';
  };

  const determineFrameworkRole = (node: CASNode): string | undefined => {
    const decorators = (cas.decorators || []).filter(d => d.target_node === node.id);
    const decoratorNames = decorators.map(d => d.decorator_info.name);

    if (decoratorNames.includes('Controller')) return 'NestJS Controller';
    if (decoratorNames.includes('Injectable')) return 'NestJS Service';
    if (decoratorNames.includes('Entity')) return 'MikroORM/TypeORM Entity';
    if (decoratorNames.includes('Module')) return 'NestJS Module';
    if (decoratorNames.includes('Guard')) return 'NestJS Guard';
    if (decoratorNames.includes('Component')) return 'Vue Component';

    if (node.type === 'functional_component' || node.type === 'class_component') return 'React Component';
    if (node.type === 'custom_hook') return 'React Hook';
    if (node.type === 'api_route') return 'Next.js API Route';
    if (node.type === 'react_page') return 'Next.js Page';
    if (node.type === 'server_component') return 'React Server Component';

    return undefined;
  };

  const layer = determineLayer(targetNode);
  const frameworkRole = determineFrameworkRole(targetNode);

  const result: Record<string, unknown> = {
    target_node: {
      id: targetNode.id,
      name: targetNode.name,
      type: targetNode.type,
      file: targetNode.source?.file,
      line: targetNode.source?.line,
      signature: targetNode.signature,
      docstring: targetNode.description,
      layer,
      framework_role: frameworkRole,
    },
  };

  if (shouldInclude('conventions')) {
    const allNodes = cas.nodes;
    const functions = allNodes.filter(n => n.type === 'function' || n.type === 'method');
    const classes = allNodes.filter(n => n.type === 'class' || n.type === 'service' || n.type === 'controller');

    const functionNames = functions.slice(0, 20).map(n => n.name);
    const classNames = classes.slice(0, 20).map(n => n.name);

    const detectNamingPattern = (names: string[]): string => {
      if (names.length === 0) return 'unknown';
      const camelCase = names.filter(n => /^[a-z][a-zA-Z0-9]*$/.test(n)).length;
      const pascalCase = names.filter(n => /^[A-Z][a-zA-Z0-9]*$/.test(n)).length;
      const snakeCase = names.filter(n => /^[a-z][a-z0-9_]*$/.test(n)).length;

      if (pascalCase > camelCase && pascalCase > snakeCase) return 'PascalCase';
      if (snakeCase > camelCase) return 'snake_case';
      return 'camelCase';
    };

    const hasAsyncAwait = functions.some(f => f.signature?.return_type?.includes('Promise'));
    const hasPromises = cas.edges.some(e => e.metadata?.async);

    const errorPatterns = (cas.patterns || []).filter(p =>
      p.name.toLowerCase().includes('error') || p.name.toLowerCase().includes('exception')
    );

    result.conventions = {
      naming: {
        functions: { pattern: detectNamingPattern(functionNames), examples: functionNames.slice(0, 5) },
        classes: { pattern: detectNamingPattern(classNames), examples: classNames.slice(0, 5) },
      },
      async_style: hasAsyncAwait ? 'async-await' : (hasPromises ? 'promises' : 'callbacks'),
      error_handling: errorPatterns.length > 0 ? {
        pattern: 'exceptions',
        example_node_id: errorPatterns[0].instances?.[0],
      } : { pattern: 'try-catch' },
    };
  }

  if (shouldInclude('patterns')) {
    const nodePatterns = (cas.patterns || []).filter(p =>
      p.instances?.includes(targetNode!.id) ||
      p.variations?.some(v => v.instances?.includes(targetNode!.id))
    );

    const relevantPatterns = nodePatterns.map(p => ({
      pattern_id: p.id,
      name: p.name,
      relevance: p.type === 'anti-pattern' ? 'must_follow' as const : 'recommended' as const,
      example_node_id: p.instances?.[0],
    }));

    const layerPatterns = (cas.patterns || [])
      .filter(p => !nodePatterns.includes(p))
      .slice(0, 5)
      .map(p => ({
        pattern_id: p.id,
        name: p.name,
        relevance: 'optional' as const,
        example_node_id: p.instances?.[0],
      }));

    result.related_patterns = [...relevantPatterns, ...layerPatterns].slice(0, 10);
  }

  if (shouldInclude('constraints')) {
    const canCall: Array<{ layer: string; types: string[] }> = [];
    const shouldNotCall: Array<{ layer: string; reason: string }> = [];

    if (layer === 'entry') {
      canCall.push({ layer: 'business', types: ['service', 'use_case'] });
      shouldNotCall.push({ layer: 'data', reason: 'Controllers should not directly access repositories' });
    } else if (layer === 'business') {
      canCall.push({ layer: 'data', types: ['repository', 'entity'] });
      canCall.push({ layer: 'infrastructure', types: ['external_service', 'cache'] });
      shouldNotCall.push({ layer: 'entry', reason: 'Services should not depend on controllers' });
    } else if (layer === 'data') {
      canCall.push({ layer: 'infrastructure', types: ['database', 'orm'] });
      shouldNotCall.push({ layer: 'entry', reason: 'Repositories should not depend on controllers' });
      shouldNotCall.push({ layer: 'business', reason: 'Repositories should not depend on services' });
    }

    result.layer_boundaries = { can_call: canCall, should_not_call: shouldNotCall };
  }

  if (shouldInclude('tests')) {
    const changeRisk = (cas.change_risks || []).find(r => r.node_id === targetNode!.id);
    const callersResult = getCallers(cas, targetNode.id, 2, 20);
    const tests = findTests(cas, { nodeId: targetNode.id });

    const mustVerify: Array<{ check: string; how_to_verify: string }> = [];
    const shouldVerify: Array<{ check: string; how_to_verify: string }> = [];

    if (changeRisk?.risk_level === 'high' || changeRisk?.risk_level === 'critical') {
      mustVerify.push({
        check: 'All existing tests pass',
        how_to_verify: 'Run test suite'
      });
    }

    if (callersResult.total > 0) {
      mustVerify.push({
        check: `${callersResult.total} callers still work correctly`,
        how_to_verify: 'Review caller implementations'
      });
    }

    if (taskType === 'modify' || taskType === 'refactor') {
      shouldVerify.push({
        check: 'Type signature unchanged or callers updated',
        how_to_verify: 'Check function signature and all call sites'
      });
    }

    const testsToRun = tests.suites.slice(0, 5).map(s => ({
      test_id: s.file_path,
      name: s.name,
      command: `npm test -- ${s.file_path}`,
    }));

    const testsToAdd: Array<{ type: 'unit' | 'integration'; reason: string; similar_test_id?: string }> = [];
    if (tests.suites.length === 0) {
      testsToAdd.push({
        type: 'unit',
        reason: 'No existing tests cover this code',
      });
    }

    result.modification_checklist = {
      must_verify: mustVerify,
      should_verify: shouldVerify,
      tests_to_run: testsToRun,
      tests_to_add: testsToAdd,
    };
  }

  const callersResult = getCallers(cas, targetNode.id, 1, callerLimit);
  const calleesResult = getCallees(cas, targetNode.id, 1, calleeLimit);
  // callersResult.total/truncated only reflect what the capped traversal collected, not
  // the real graph count. Re-probe at depth 1 with a large limit to learn the true count
  // so truncation is reported honestly rather than silently.
  const callersTotal = callersResult.truncated
    ? getCallers(cas, targetNode.id, 1, UNCAPPED_COUNT_PROBE).total
    : callersResult.total;
  const calleesTotal = calleesResult.truncated
    ? getCallees(cas, targetNode.id, 1, UNCAPPED_COUNT_PROBE).total
    : calleesResult.total;

  const sharedTypes: Array<{ id: string; name: string; usage_count: number }> = [];
  const outgoingEdges = cas.edges.filter(e => e.source === targetNode!.id && e.type === 'uses_type');
  for (const edge of outgoingEdges.slice(0, 5)) {
    const typeNode = cas.nodes.find(n => n.id === edge.target);
    if (typeNode) {
      const usageCount = cas.edges.filter(e => e.target === typeNode.id && e.type === 'uses_type').length;
      sharedTypes.push({ id: typeNode.id, name: typeNode.name, usage_count: usageCount });
    }
  }

  const anyTruncated = callersTotal > callersResult.callers.length || calleesTotal > calleesResult.callees.length;

  result.connected_code = {
    callers: callersResult.callers.map(c => ({
      id: c.node_id,
      name: c.name,
      type: c.type,
      risk_if_changed: callersTotal > 5 ? 'high' : (callersTotal > 2 ? 'medium' : 'low'),
    })),
    callees: calleesResult.callees.map(c => ({
      id: c.node_id,
      name: c.name,
      type: c.type,
    })),
    shared_types: sharedTypes,
    callers_total: callersTotal,
    callees_total: calleesTotal,
    truncated: anyTruncated,
    ...(anyTruncated
      ? {
          truncation_hint:
            `Showing ${callersResult.callers.length}/${callersTotal} callers and ${calleesResult.callees.length}/${calleesTotal} callees. ` +
            `Call get_callers/get_callees directly (or pass a larger caller_limit/callee_limit) for the full set.`,
        }
      : {}),
  };

  // TELEMETRY facet (facet 6 of the uniform understanding contract): if the
  // caller supplied runtime metrics, attach "how this unit actually runs" to
  // the resolved target node. Evidence-gated — omitted entirely when no
  // observation matches this node, never fabricated.
  if (opts.runtimeMetrics && opts.runtimeMetrics.length > 0) {
    const tel = telemetryForNode(targetNode.id, opts.runtimeMetrics);
    if (tel) result.telemetry = tel;
  }

  return result;
}

/**
 * Resolve "Class::method" / "Class.method" / "Class#method" syntax — agents
 * often paste a target straight from a stack trace or another tool's naming
 * convention, and node ids don't encode that shape directly. Each member
 * node carries a `parent` pointing at its containing class/interface node,
 * which is the robust join: find class node(s) by name, then a method/function
 * node among them whose `parent` equals the class node's id. Falls back to
 * the id-embedding convention used by method nodes
 * (`method_class_<file>_<Class>_<i>_<method>_<j>`, see flow-concepts.ts) when
 * no `parent` link is present on this analyzer's output. An honest miss
 * returns undefined rather than guessing across classes with the same method
 * name.
 */
function resolveClassMember(cas: CASOutput, className: string, memberName: string): CASNode | undefined {
  const memberNodes = cas.nodes.filter(n =>
    (n.type === 'method' || n.type === 'function') && n.name === memberName
  );
  if (memberNodes.length === 0) return undefined;

  const classCandidates = cas.nodes.filter(n =>
    (n.type === 'class' || n.type === 'interface' || n.type === 'struct') && n.name === className
  );
  for (const classNode of classCandidates) {
    const member = memberNodes.find(n => n.parent === classNode.id);
    if (member) return member;
  }

  // Fall back to id-embedding convention when no parent link resolved.
  const idScoped = memberNodes.find(n => n.id.includes(`_${className}_`));
  if (idScoped) return idScoped;

  return undefined;
}

/**
 * getInterfaceSignature — the I/L/S/O join (SPEC-INTELLIGENCE-CAPITALIZATION.md
 * concept #2). Every entity (function -> flow -> capability -> project ->
 * workspace) has the same contract shape: Input (what it requires), Logic
 * (the blackbox internal wiring), Side-effects (3rd-party/external touches),
 * Output (what it produces). Today these four facts live in four separate
 * tools/ID-spaces (entry_points, exit_points, data_lineage, callers/callees)
 * that an agent must call separately and intersect by node_id/file by hand.
 * This is a pure JOIN over existing facts — no new analyzer pass.
 */
export function getInterfaceSignature(
  cas: CASOutput,
  target: string,
  opts: { level?: 'auto' | 'function' | 'flow' | 'capability' | 'project' | 'workspace'; caller_limit?: number; callee_limit?: number } = {}
) {
  const callerLimit = opts.caller_limit && opts.caller_limit > 0 ? opts.caller_limit : 10;
  const calleeLimit = opts.callee_limit && opts.callee_limit > 0 ? opts.callee_limit : 10;
  const UNCAPPED_COUNT_PROBE = 5000;

  // -- project/workspace level: aggregate from workspace-level-CAS-adjacent CAS fields
  // (product_map, exit_points, entry_points) rather than a single node. --
  const requestedLevel = opts.level && opts.level !== 'auto' ? opts.level : undefined;
  const isProjectTarget = requestedLevel === 'project' || requestedLevel === 'workspace'
    || (!requestedLevel && /^(project|workspace|\.|\/?$)$/.test(target.trim()));

  if (isProjectTarget) {
    const productMap = cas.product_map || buildProductMap(cas);
    const exitTypes = new Set((cas.exit_points || []).map(ep => ep.type));
    const externalServices = [...new Set([
      ...(cas.external_services || []).map((s: any) => s.name || s.id).filter(Boolean),
      ...(cas.exit_points || []).map(ep => ep.target?.service_id).filter(Boolean),
    ])];

    return {
      target: { id: cas.system?.name || target, level: requestedLevel === 'workspace' ? 'workspace' : 'project', name: cas.system?.name },
      level: requestedLevel === 'workspace' ? 'workspace' : 'project',
      input: (cas.entry_points || []).slice(0, 20).map(ep => ({ id: ep.id, name: ep.name, type: ep.type })),
      output: (productMap.capabilities || []).slice(0, 20).map(c => ({ name: c.name, category: c.category, entities: c.entities?.slice(0, 5) })),
      side_effects: {
        exit_point_types: [...exitTypes],
        external_services: externalServices.slice(0, 20),
        exit_point_count: (cas.exit_points || []).length,
      },
      logic: {
        callers_total: undefined,
        callees_total: undefined,
        key_refs: (productMap.capabilities || []).slice(0, 10).map(c => c.name),
        internal_module_count: cas.nodes.filter(n => n.type === 'module' || n.type === 'file').length,
      },
      purpose: cas.enhanced_system_purpose?.inferred_description || productMap.identity?.description || undefined,
      gaps: [
        'project/workspace level is aggregated from product_map + entry/exit points, not a per-node join; cross-repo (workspace) contracts require WAS tools (get_cross_repo_contracts) which this join does not call.',
      ],
    };
  }

  // -- function/flow/capability level: resolve target node the same way
  // getCodingContext does (node id, file path, or search query). --
  let targetNode: CASNode | undefined;

  // Class::method / Class#method syntax (unambiguous separators — agents
  // commonly paste this straight from a stack trace or another tool) is
  // tried first, before the file-path/id/search fallbacks below.
  const classMemberSeparatorMatch = target.match(/^([\w$]+)\s*(?:::|#)\s*([\w$]+)$/);
  if (classMemberSeparatorMatch) {
    targetNode = resolveClassMember(cas, classMemberSeparatorMatch[1], classMemberSeparatorMatch[2]);
  }

  if (!targetNode) {
    if (target.includes('/') || target.includes('.')) {
      const fileNodes = cas.nodes.filter(n => n.source?.file?.endsWith(target) || n.id === target);
      targetNode = fileNodes.find(n => n.type === 'class' || n.type === 'module' || n.type === 'function') || fileNodes[0];
    } else {
      targetNode = cas.nodes.find(n => n.id === target);
      if (!targetNode) {
        const searchResults = searchNodes(cas, target, { limit: 1 });
        if (searchResults.length > 0) targetNode = cas.nodes.find(n => n.id === searchResults[0].id);
      }
    }
  }

  // Class.method syntax is ambiguous with a bare file name (e.g. "utils.ts"),
  // so it is only tried as a last resort once the id/file/search resolution
  // above has come up empty.
  if (!targetNode && !classMemberSeparatorMatch) {
    const dotMatch = target.match(/^([\w$]+)\.([\w$]+)$/);
    if (dotMatch) {
      targetNode = resolveClassMember(cas, dotMatch[1], dotMatch[2]);
    }
  }

  if (!targetNode) {
    return { error: `Target not found: ${target}` };
  }

  const level = requestedLevel
    ? requestedLevel
    : (['controller', 'gateway', 'resolver', 'handler', 'page', 'route', 'api_route'].includes(targetNode.type)
        ? 'flow'
        : 'function');

  // -- I: required inputs --
  const ownEntryPoints = (cas.entry_points || []).filter(ep =>
    ep.source_node === targetNode!.id || ep.handler?.node_id === targetNode!.id
  );
  const requiredParams = targetNode.signature?.parameters?.map(p => ({ name: p.name, type: p.type, optional: p.optional })) || [];
  const callersResult = getCallers(cas, targetNode.id, 1, callerLimit);
  const callersTotal = callersResult.truncated ? getCallers(cas, targetNode.id, 1, UNCAPPED_COUNT_PROBE).total : callersResult.total;

  // -- O: produced outputs --
  const returnType = targetNode.signature?.return_type;
  const ownExitEventNames: string[] = [];

  // -- S: side-effects, from exit_points filtered to this node's own
  // source_node (code-level call sites) reconciled with data_lineage
  // external_recipients for entities this node writes/reads (entity-level
  // recipients) — the two "external" notions the audit found unreconciled. --
  const ownExitPoints = (cas.exit_points || []).filter(ep => ep.source_node === targetNode!.id);
  const lineageEntries = cas.data_lineage || [];
  const relatedLineage = lineageEntries.filter(entry =>
    entry.writers.some(w => w.node_id === targetNode!.id) || entry.readers.some(r => r.node_id === targetNode!.id)
  );
  const externalRecipients = [...new Set(relatedLineage.flatMap(entry => entry.external_recipients.map(r => r.service)))];
  const boundariesCrossed = relatedLineage.flatMap(entry => entry.boundaries_crossed);

  // -- L: blackbox internal wiring (callers + callees), reusing the
  // truncation-signal pattern from getCodingContext (report the true total,
  // never silently drop entries past the display limit). --
  const calleesResult = getCallees(cas, targetNode.id, 1, calleeLimit);
  const calleesTotal = calleesResult.truncated ? getCallees(cas, targetNode.id, 1, UNCAPPED_COUNT_PROBE).total : calleesResult.total;
  const anyTruncated = callersTotal > callersResult.callers.length || calleesTotal > calleesResult.callees.length;

  // -- purpose: terminal-signal proximity, if the entity's name/related
  // entities match a ranked terminal entity/stage. Cheap: buildTerminalSignal
  // runs over the CAS's own journeys/capabilities, already in memory. --
  let purpose: string | undefined;
  if (cas.user_journeys && cas.user_journeys.length > 0) {
    const signal = buildTerminalSignal({ journeys: cas.user_journeys, systemCapabilities: cas.system_capabilities || [] });
    const nameLower = targetNode.name.toLowerCase();
    const matchedEntity = signal.ranked_entities.find(e => e.name.toLowerCase() === nameLower || nameLower.includes(e.name.toLowerCase()));
    const matchedStage = signal.ranked_stages.find(s => s.name.toLowerCase() === nameLower || nameLower.includes(s.name.toLowerCase()));
    if (matchedEntity) {
      purpose = `Near/at a terminal entity: "${matchedEntity.name}" (score ${matchedEntity.score.toFixed(1)}, ${matchedEntity.write_journeys} write / ${matchedEntity.read_journeys} read journeys) — this is evidence of why the entity exists, not an inferred label.`;
    } else if (matchedStage) {
      purpose = `Near-terminal stage: "${matchedStage.name}" (${matchedStage.min_distance_from_terminal} step(s) from a terminal, score ${matchedStage.score.toFixed(1)}).`;
    }
  }

  const gaps: string[] = [];
  if (!cas.data_lineage || cas.data_lineage.length === 0) {
    gaps.push('No data_lineage on this analysis scope — side_effects.external_recipients may be incomplete; re-run analyze_codebase or widen scope if this node touches shared entities.');
  }
  if (!purpose) {
    gaps.push('No terminal-signal match for this target — purpose omitted rather than fabricated.');
  }

  return {
    target: { id: targetNode.id, name: targetNode.name, type: targetNode.type, file: targetNode.source?.file, line: targetNode.source?.line },
    level,
    input: [
      ...requiredParams.map(p => ({ kind: 'parameter', name: p.name, type: p.type, optional: p.optional })),
      ...ownEntryPoints.map(ep => ({ kind: 'entry_point', id: ep.id, name: ep.name, type: ep.type, trigger: ep.trigger })),
    ],
    output: [
      ...(returnType ? [{ kind: 'return_type', type: returnType }] : []),
      ...ownExitEventNames.map(name => ({ kind: 'event', name })),
    ],
    side_effects: [
      ...ownExitPoints.map(ep => ({ kind: 'exit_point', id: ep.id, type: ep.type, name: ep.name, target: ep.target })),
      ...externalRecipients.map(service => ({ kind: 'external_recipient', service })),
      ...boundariesCrossed.map(b => ({ kind: 'boundary', boundary: b.boundary, guarded: b.guarded, guard_kinds: b.guard_kinds })),
    ],
    logic: {
      callers_total: callersTotal,
      callees_total: calleesTotal,
      key_refs: [
        ...callersResult.callers.slice(0, 5).map(c => c.name),
        ...calleesResult.callees.slice(0, 5).map(c => c.name),
      ],
      truncated: anyTruncated,
    },
    purpose,
    gaps: gaps.length ? gaps : undefined,
  };
}

// getFlowConcepts has no default cap on the number of flows returned when
// `target` is omitted — one flow per entry point, each carrying a full
// I/L/S/O + Constraints contract per flow AND per step. On a repo with
// hundreds/thousands of entry points (this repo: 1,133) that is ~467k
// tokens in a single uncapped response — silently, since the only signal
// was an undocumented "default: all" in the tool description. This default
// keeps the common "browse a handful of flows" case cheap while an agent
// that genuinely wants everything can still ask for it explicitly via
// max_flows (a large explicit value, or Infinity-ish via a big number) —
// never silent, always paginated with total/truncated/hint.
//
// RAISED 15 -> 25 (P0 rank-before-truncate). The old number was chosen when the
// window was significance-BLIND, so a bigger page only bought more 1-step
// leaves; with ranking in front of the cap the page carries the flows that
// answer a question, and the size is now set from measurement.
//
// MEASURED compact-projection cost per flow (`flows` JSON bytes / flow, three
// real stored CASes, heavy evidence tiers already stripped):
//
//   page size |    27k-node repo |   57k-node repo |   12k-node repo
//   ----------+------------------+-----------------+----------------
//        15   |  10.0 KB / flow  | 12.1 KB / flow  |  6.4 KB / flow
//        25   |   9.9 KB / flow  | 11.1 KB / flow  |  6.2 KB / flow
//        50   |   8.5 KB / flow  |  8.8 KB / flow  |  5.6 KB / flow
//
// A ranked page costs ~3x MORE per flow than the old window did (~2.4-3.4 KB)
// — precisely because it now carries deep flows instead of leaves. That cost
// is dominated by RANKING, not by page size: going 15 -> 25 adds ~21% bytes
// for 67% more flows, and the per-flow cost DROPS as the page extends into
// shallower flows. 25 is where the marginal flow is still substantive.
//
// Interaction with the hard response budget (docs/SPEC-RESPONSE-BUDGET.md):
// every MCP tool result is bounded to RESPONSE_BUDGET_BYTES (20,000) by
// server.ts' enforceResponseBudget, which shrinks the largest arrays and
// attaches an honest truncation envelope. That wrapper — not this default —
// is what actually sizes an MCP response on a large repo, and it is now SAFE
// for it to trim the tail of `flows`, because the tail is the lowest-ranked
// end of a real order rather than an arbitrary one. Callers that want the
// trimmed flows ask for them by page (`offset`), not by luck.
const DEFAULT_MAX_FLOWS = 25;

/**
 * getFlowConcepts — the FLOW -> STEP tier of the conceptual understanding
 * layer (docs/SPEC-CONCEPTUAL-LAYER.md), thin query-layer wrapper over
 * computeFlowConcepts (packages/analyzer-core/src/analyzer/core/flow-concepts.ts).
 * `target` filters to entry points matching an id/name/route-path substring;
 * omitted returns the top DEFAULT_MAX_FLOWS derivable flows (explicit
 * `maxFlows` overrides the default; pass a value >= the real entry_points
 * count to get everything).
 */
export function getFlowConcepts(
  cas: CASOutput,
  opts: {
    target?: string; maxDepth?: number; maxFunctionsPerFlow?: number; maxFlows?: number; includeStructural?: boolean; runtimeMetrics?: RuntimeMetricLike[]; role?: SemanticRole;
    /** Page offset into the RANKED flow order (rankStoredFlowRefs) — the
     *  page-2 mechanism. 0/omitted = first page. */
    offset?: number;
    /** 'compact' (default) elides the heavy evidence tiers (contract
     *  facet_provenance, step code_mappings) with availability markers so the
     *  browse response stays inside the size budget; 'full' inlines them. */
    detail?: 'compact' | 'full';
    /** Persisted AI-authored flow/step descriptions (element-description store,
     *  kind 'flow'), keyed by flow_id AND step_id. This is the caller of the
     *  interpretive `nameStep` seam: step keys feed computeFlowConcepts'
     *  nameStep hook (description_source flips to 'ai'); flow keys overlay the
     *  flow-level description. Absent -> fully deterministic output. */
    aiDescriptions?: Map<string, { description: string }>;
    /** Which caller surface is asking — affects only the phrasing of the
     *  truncation gap hint below. 'mcp' (default): this function's own
     *  `maxFlows` param is a first-class tool arg an MCP caller can pass
     *  directly. 'http': the caller is an HTTP route (e.g. /conceptual) that
     *  may or may not forward a max_flows query param — the hint must name
     *  the actual mechanism (query param, with its bound) rather than assume
     *  a bare function-argument surface that doesn't exist for HTTP callers. */
    surface?: 'mcp' | 'http';
  } = {}
) {
  // Only apply the default cap when browsing all flows (no target filter).
  // A targeted lookup ("flows touching this entry point") is already
  // naturally narrow and an explicit ask — don't second-guess it.
  const effectiveMaxFlows = opts.maxFlows && opts.maxFlows > 0
    ? opts.maxFlows
    : (opts.target ? undefined : DEFAULT_MAX_FLOWS);

  // PAGINATION (P0): offset into the ranked order. Only meaningful when a
  // ranked order exists (browse case + materialized flow index) — a targeted
  // lookup has no stable global order to page through, so an offset there is
  // reported as unsupported in `gaps` rather than silently applied.
  const requestedOffset = opts.offset && opts.offset > 0 ? Math.floor(opts.offset) : 0;
  // Exact denominator for the paged view: the materialized flow index IS the
  // full flow set (one ref per derived flow), so when it is present we know
  // the true total without a second uncapped derivation — the honest `total`
  // the old truncation hint could only approximate with entry_points.length.
  const rankedTotal = (!opts.target && !opts.role) ? rankStoredFlowRefs(cas).length : 0;
  const pagingSupported = rankedTotal > 0;
  const offset = pagingSupported ? requestedOffset : 0;

  const computeOpts: ComputeFlowConceptsOptions = {
    target: opts.target,
    offset: offset > 0 ? offset : undefined,
    maxDepth: opts.maxDepth,
    maxFunctionsPerFlow: opts.maxFunctionsPerFlow,
    // Probe one extra so we can report truncation honestly without a
    // second full compute pass just to learn the true total. When a `role`
    // filter is active we must compute over ALL flows first (otherwise the
    // per-flow filter would only ever see the first N and silently miss
    // matching flows past the cap), so drop the probe cap in that case.
    maxFlows: opts.role ? undefined : (effectiveMaxFlows ? effectiveMaxFlows + 1 : undefined),
    // The interpretive seam's caller (ICELOT doctrine): persisted AI-authored
    // step descriptions (element-description store, kind 'flow') feed the
    // nameStep hook, flipping matched steps' description_source to 'ai'.
    // Deterministic labels remain the fallback for every unmatched step.
    nameStep: opts.aiDescriptions && opts.aiDescriptions.size > 0
      ? (step) => {
          const hit = opts.aiDescriptions!.get(step.step_id);
          return hit ? { description: hit.description } : undefined;
        }
      : undefined,
  };
  let probedFlows = computeFlowConcepts(cas, computeOpts);

  // Flow-level AI description overlay (same store, keyed by flow_id). The
  // deterministic `intent` stays untouched as the fact-shaped fallback.
  if (opts.aiDescriptions && opts.aiDescriptions.size > 0) {
    for (const f of probedFlows) {
      const hit = opts.aiDescriptions.get(f.flow_id);
      if (hit) {
        f.description = hit.description;
        f.description_source = 'ai';
      }
    }
  }

  // Per-flow semantic role (core / supporting / infrastructure), classified
  // with the SAME shared ./semantic-roles logic as entities + workspace items,
  // anchored on the already-computed domain concept classification
  // (entry-point-anchored and touched-entity-anchored) with a name-based
  // fallback. Additive; `unknown` (undefined) when unclassifiable.
  const flowConceptIndex = buildDomainConceptIndex(cas.domain_concepts);
  // Structural terminal/product evidence per flow (entry TYPE + terminus +
  // capability membership) — outranks domain-concept/name anchors inside
  // classifyFlowRole, so a deploy.sh-rooted flow is infrastructure even when a
  // "shell" domain concept was classified core, and a capability-serving flow
  // with an api/persisted terminus is core regardless of its name.
  const roleEntryPointById = new Map((cas.entry_points || []).map(ep => [ep.id, ep]));
  const roleNodeById = new Map(cas.nodes.map(n => [n.id, n]));
  const structuralRoleEvidence = (f: (typeof probedFlows)[number]) => {
    const ep = roleEntryPointById.get(f.entry_point);
    const rootNode = ep
      ? roleNodeById.get(ep.handler?.node_id || ep.source_node)
      : roleNodeById.get(f.entry_point);
    return {
      entry_type: ep?.type,
      entry_file: ep?.handler?.file || rootNode?.source?.file,
      terminus_kind: f.terminus?.kind,
      terminus_produces: f.terminus?.produces,
      capability_linked: Boolean(f.capability_id),
    };
  };
  // FLOW-FLOODING FIX: a flow rooted at a `test` entry point is a real
  // structural fact (get_test_summary depends on the underlying entry point
  // staying in the graph) but must never be counted into the product
  // core/supporting/infrastructure vocabulary — a test-heavy CAS would
  // otherwise either drown those buckets in test noise or (via the
  // conservative "supporting" name fallback) silently misclassify test flows
  // as product surface. Give it its own honest 'test' bucket instead, decided
  // BEFORE the name/domain-concept classifier runs (entry type is a stronger,
  // cheaper signal than name matching). Doctrine: tests stay in the graph and
  // in entry_points; they just never dominate — see
  // filterPrimaryProductEntryPoints/filterPrimaryProductJourneys in
  // orchestrator.ts for the same doctrine applied to comprehension surfaces.
  const roleByFlowId = new Map<string, { role?: SemanticRole | 'test'; role_evidence: string[] }>();
  for (const f of probedFlows) {
    const structural = structuralRoleEvidence(f);
    if (structural.entry_type === 'test') {
      roleByFlowId.set(f.flow_id, {
        role: 'test',
        role_evidence: ['entry point type is test — excluded from product role classification, retained as a structural fact'],
      });
      continue;
    }
    const classification = classifyFlowRole(f, flowConceptIndex, structural);
    roleByFlowId.set(f.flow_id, classification);
    // Rule (c) of the capability↔flow relational-role derivation
    // (docs/SEMANTIC-MODEL.md — roles live on the EDGE): an entity-overlap
    // relationship on a flow the classifier grounds as 'infrastructure'
    // (deploy/install script entry, plumbing surface) is 'operational', not
    // 'supporting'. Primary (operation-ref) and observability (telemetry-exit)
    // edges keep their stronger evidence.
    applyFlowRoleToCapabilityRelationships(f, classification.role, classification.role_evidence);
  }

  // Optional role filter — applied to the fully-computed flow set before the
  // browse cap, so counts and truncation stay honest for the filtered view.
  if (opts.role) {
    probedFlows = probedFlows.filter(f => roleByFlowId.get(f.flow_id)?.role === opts.role);
  }

  const truncated = effectiveMaxFlows !== undefined && probedFlows.length > effectiveMaxFlows;
  const flows = truncated ? probedFlows.slice(0, effectiveMaxFlows) : probedFlows;

  const roleBreakdown: Record<'core' | 'supporting' | 'infrastructure' | 'test' | 'unknown', number> =
    { core: 0, supporting: 0, infrastructure: 0, test: 0, unknown: 0 };
  for (const f of probedFlows) {
    roleBreakdown[roleByFlowId.get(f.flow_id)?.role || 'unknown']++;
  }
  // Honest product-vs-test denominator, independent of the (possibly capped)
  // probe window above: a cheap O(entry_points) pass over facts already
  // loaded, so total_available staying dominated by test count is visible
  // rather than silently implied. Additive field — existing consumers reading
  // total_available/role_breakdown are unaffected.
  const testEntryPointTotal = (cas.entry_points || []).filter(ep => ep.type === 'test').length;
  const entryPointTotals = {
    product: (cas.entry_points || []).length - testEntryPointTotal,
    test: testEntryPointTotal,
  };
  // True total when we didn't truncate is just what we got; when we did,
  // it's at least effectiveMaxFlows+1 (we don't re-probe uncapped here —
  // entry_points.length is the authoritative upper bound for "all flows").
  // When a role filter is active we computed over ALL flows, so probedFlows
  // (post-filter) is the exact filtered total — don't fall back to the
  // entry-point upper bound (which ignores the filter).
  //
  // When the materialized flow index is available (pagingSupported) it IS the
  // exact total — use it instead of the entry-point upper bound, so `offset`
  // has a denominator a caller can page against rather than an estimate.
  const totalFlowsAvailable = pagingSupported
    ? rankedTotal
    : truncated
      ? (opts.role ? probedFlows.length : Math.max(probedFlows.length, (cas.entry_points || []).length))
      : probedFlows.length;
  // "Is there another page" is an offset question, not just a cap question.
  const hasMore = pagingSupported ? offset + flows.length < totalFlowsAvailable : truncated;
  const nextOffset = hasMore && pagingSupported ? offset + flows.length : undefined;

  const gaps: string[] = [];
  if (!cas.entry_points || cas.entry_points.length === 0) {
    gaps.push('No entry_points on this analysis — flows cannot be rooted; re-run analyze_codebase or widen scope.');
  }
  if (opts.target && flows.length === 0) {
    gaps.push(`No entry point matched target "${opts.target}" — check get_entry_points/get_route_table for valid ids/paths.`);
  }
  if (requestedOffset > 0 && !pagingSupported) {
    gaps.push(
      'offset ignored: paging needs the materialized flow index (flow_graph.flows) and the untargeted/unfiltered browse view — this response has no stable global rank order to page through. Use target to narrow instead.'
    );
  }
  if (hasMore) {
    // Report the cap that was ACTUALLY applied (effectiveMaxFlows), not the
    // module default — a caller (e.g. the /conceptual HTTP route) may pass
    // its own explicit maxFlows, and stating DEFAULT_MAX_FLOWS there would be
    // false ("default cap 15" while the real cap in effect was 20).
    const appliedCapNotice = opts.maxFlows && opts.maxFlows > 0
      ? `cap ${effectiveMaxFlows}`
      : `default cap ${effectiveMaxFlows} when browsing all entry points`;
    // HONEST HINT (P0): the old text told HTTP callers to "Pass a max_flows
    // query param (bounded, max 50)" — i.e. the advertised remedy was capped
    // at the same number that caused the complaint, and there was no page 2 at
    // all. Name the mechanism that actually reaches flow #51+.
    const moreHint = pagingSupported
      // Same mechanism name on both surfaces: `offset` is a real query param on
      // the HTTP route AND a real tool arg on the MCP surface.
      ? `Pass offset=${nextOffset} (with max_flows) for the next page — flows are ranked by significance (steps, capability link, terminus, criticality, structural importance) before the cap, so page 1 is the top of that order and later pages are strictly lower-ranked, never duplicated. Or use target to narrow to a specific entry point/route/name.`
      : (opts.surface === 'http'
        ? 'Pass a larger max_flows query param to see more, or target to narrow to a specific entry point/route/name.'
        : 'Pass max_flows to see more, or target to narrow to a specific entry point/route/name.');
    gaps.push(`Showing ${flows.length}/${totalFlowsAvailable} flows (${appliedCapNotice}${offset > 0 ? `, offset ${offset}` : ''}). ${moreHint}`);
    if (entryPointTotals.test > entryPointTotals.product) {
      gaps.push(
        `total_available is dominated by test entry points (${entryPointTotals.test} test vs ${entryPointTotals.product} product) — see entry_point_totals; the returned window is ordered product-first so this page should still be product-shaped.`
      );
    }
  }

  // Cross-link each flow/step to the STRUCTURAL perspectives (architectural
  // layer + paradigm-deviation membership, docs/SPEC-CONCEPTUAL-LAYER.md
  // §3/§6) — on by default (includeStructural: false to opt out). Purely
  // additive: `structural` is a new field on each flow/step; existing
  // consumers reading name/contract/functions see no change.
  const includeStructural = opts.includeStructural !== false;
  const withRole = (flow: typeof flows[number]) => {
    const classification = roleByFlowId.get(flow.flow_id);
    // `terminus` (what the flow PRODUCES at its resolved exit — SPEC terminal
    // anchor), `capability_id` (back-compat primary link the UI binds) and
    // `capability_relationships` (the real M:N model — role on the edge) are
    // spread via `...flow`, but named explicitly so the projection is an
    // intentional, grep-visible field-list rather than an implicit spread
    // that a future compaction could silently drop.
    return { ...flow, terminus: flow.terminus, capability_id: flow.capability_id, capability_relationships: flow.capability_relationships, role: classification?.role, role_evidence: classification?.role_evidence };
  };
  let flowsOut: any[] = flows.map(withRole);
  if (includeStructural && flows.length > 0) {
    const linksByFlow = computeFlowStructuralLinks(cas, flows);
    if ((cas.paradigm_conformance || []).length === 0) {
      gaps.push('No paradigm_conformance on this analysis — step/flow paradigm_deviations will be empty (layer is still derived structurally).');
    }
    flowsOut = flows.map(flow => {
      const linked = linksByFlow.get(flow.flow_id);
      const classification = roleByFlowId.get(flow.flow_id);
      return {
        ...flow,
        terminus: flow.terminus,
        capability_id: flow.capability_id,
        capability_relationships: flow.capability_relationships,
        role: classification?.role,
        role_evidence: classification?.role_evidence,
        structural: linked?.flow,
        steps: flow.steps.map(step => ({
          ...step,
          structural: linked?.steps.get(step.step_id),
        })),
      };
    });
  }

  // TELEMETRY facet (facet 6 of the uniform understanding contract): join
  // real runtime metrics onto each flow/step contract when the caller supplied
  // them (server.ts loads persisted observations and builds NodeRuntimeMetrics).
  // Evidence-gated: attachTelemetryToFlows only sets `contract.telemetry` where
  // an observation actually matches; nothing is fabricated. The mutation lands
  // on the shared `contract` object referenced by both `flows` and `flowsOut`
  // (the structural branch shallow-spreads steps, so `step.contract` is the
  // same reference).
  //
  // Runs over `probedFlows` (the full computed-before-display-cap set), not
  // the possibly-truncated `flows` page: `flows` is a slice of the SAME
  // object references when truncated, so attaching onto probedFlows covers
  // the display page for free while also giving the capability-level rollup
  // below (computeCapabilityTelemetry) the widest honest view this call
  // actually computed, rather than silently only seeing page 1.
  let capabilityTelemetry: ReturnType<typeof computeCapabilityTelemetry> | undefined;
  let unexercised: ReturnType<typeof unexercisedFlows> | undefined;
  if (opts.runtimeMetrics && opts.runtimeMetrics.length > 0) {
    attachTelemetryToFlows(probedFlows, opts.runtimeMetrics);
    if (cas.system_capabilities && cas.system_capabilities.length > 0) {
      capabilityTelemetry = computeCapabilityTelemetry(cas.system_capabilities, probedFlows);
    }
    unexercised = unexercisedFlows(probedFlows, opts.runtimeMetrics);
  }

  // COMPACT projection (default): D2 facet_provenance + D1 code_mappings
  // inflate per-flow weight ~3-4x, and with the significance-first flow window
  // (task #15) the default window carries REAL flows — a whale's compact
  // get_flow_concepts response measured 138KB against the 64KB budget. The
  // heavy evidence tiers leave the default projection (marker fields say what
  // was elided); `detail: 'full'` opts back in for callers that want the
  // walkable provenance/mapping chains inline. Built as NEW objects — the
  // underlying flow/step/contract objects are shared with `flows` and must
  // not be mutated.
  if (opts.detail !== 'full') {
    const stripContract = (contract: any) => {
      if (!contract || typeof contract !== 'object' || !('facet_provenance' in contract)) return contract;
      const { facet_provenance: _fp, ...rest } = contract;
      return { ...rest, facet_provenance_available: true };
    };
    flowsOut = flowsOut.map(flow => ({
      ...flow,
      contract: stripContract(flow.contract),
      steps: Array.isArray(flow.steps)
        ? flow.steps.map((step: any) => {
            const { code_mappings: cm, code_mappings_truncated: _cmt, ...rest } = step;
            return {
              ...rest,
              contract: stripContract(step.contract),
              ...(Array.isArray(cm) && cm.length ? { code_mappings_available: cm.length } : {}),
            };
          })
        : flow.steps,
    }));
  }

  return {
    flows: flowsOut,
    // total = count returned (unchanged meaning/back-compat with prior
    // callers that read `.total` as "how many flows are in `flows`").
    // `total_available`/`truncated` are additive fields carrying the honest
    // "is there more" signal instead of a silent drop.
    total: flows.length,
    total_available: totalFlowsAvailable,
    // `truncated` keeps its meaning ("there are more flows than this response
    // carries") but is now offset-aware: on page 3 of 5 it is still true, and
    // on the last page it is false even though a cap was applied.
    truncated: hasMore,
    // PAGINATION (P0). `returned`/`offset`/`next_offset` are the honest
    // page-2 contract: next_offset is present iff another page exists, and
    // feeding it straight back as `offset` yields the next slice of the SAME
    // ranked order (no overlap, no gap). Omitted (never 0/null) on the last
    // page, so "is there more" is answerable without arithmetic.
    returned: flows.length,
    offset,
    next_offset: nextOffset,
    /** How the window was chosen — so a caller knows whether `offset` is live
     *  and what the order in front of the cap actually is. */
    ranking: pagingSupported
      ? 'significance: product-first, then step depth + capability link + terminus + chain criticality + structural importance; ties by flow_id (byte-stable)'
      : 'derivation order (no materialized flow index on this analysis — offset unavailable)',
    role_breakdown: roleBreakdown,
    // Honest product-vs-test split of ALL entry points on the CAS (not just
    // the probed window) — additive, so total_available dominated by test
    // count is legible instead of silently implied.
    entry_point_totals: entryPointTotals,
    // Tier 4 capability-level rollup (docs/analysis-scope/SPECIFICATION.md
    // §8) — "which capabilities are exercised versus dormant". Omitted
    // (never []) when no runtime metrics were supplied, matching the
    // evidence-gated omission rule the flow/step telemetry facet already
    // follows. Each entry states its own `coverage` — 'dormant' is only ever
    // true under 'full' coverage; see computeCapabilityTelemetry's doc.
    capability_telemetry: capabilityTelemetry && capabilityTelemetry.length ? capabilityTelemetry : undefined,
    // "Paths that exist in source but never run in production" — flows this
    // call computed that carry no observation, only reported when real
    // telemetry data exists for the scope at all (never a claim of dead code
    // from an untelemetered repo, which would be indistinguishable from
    // silence). Annotates; does not remove the flow from `flows` above.
    unexercised_flows: unexercised && unexercised.length ? unexercised : undefined,
    gaps: gaps.length ? gaps : undefined,
  };
}

export function getConventions(
  cas: CASOutput,
  opts: {
    scope?: 'global' | 'layer' | 'module';
    layer?: string;
    module_id?: string;
  } = {}
) {
  const scope = opts.scope || 'global';

  let nodes = cas.nodes;
  if (scope === 'module' && opts.module_id) {
    const moduleNode = cas.nodes.find(n => n.id === opts.module_id);
    if (moduleNode?.children) {
      const childIds = new Set(moduleNode.children);
      nodes = cas.nodes.filter(n => childIds.has(n.id) || n.id === opts.module_id);
    }
  }

  const functions = nodes.filter(n => n.type === 'function' || n.type === 'method');
  const classes = nodes.filter(n => n.type === 'class' || n.type === 'service' || n.type === 'controller');
  const files = [...new Set(nodes.map(n => n.source?.file).filter(Boolean))];

  const detectPattern = (names: string[]): { pattern: string; examples: string[] } => {
    if (names.length === 0) return { pattern: 'unknown', examples: [] };

    const camelCase = names.filter(n => /^[a-z][a-zA-Z0-9]*$/.test(n)).length;
    const pascalCase = names.filter(n => /^[A-Z][a-zA-Z0-9]*$/.test(n)).length;
    const snakeCase = names.filter(n => /^[a-z][a-z0-9_]*$/.test(n)).length;
    const kebabCase = names.filter(n => /^[a-z][a-z0-9-]*$/.test(n)).length;

    let pattern = 'camelCase';
    if (pascalCase > camelCase && pascalCase > snakeCase) pattern = 'PascalCase';
    else if (snakeCase > camelCase && snakeCase > kebabCase) pattern = 'snake_case';
    else if (kebabCase > snakeCase) pattern = 'kebab-case';

    return { pattern, examples: names.slice(0, 5) };
  };

  const functionNames = functions.map(n => n.name);
  const classNames = classes.map(n => n.name);
  const fileNames = files.map(f => f!.split('/').pop()!.replace(/\.[^.]+$/, ''));

  const hasIndexFiles = files.some(f => f!.includes('index.'));
  const hasBarrelExports = nodes.some(n => n.source?.file?.includes('index.') && n.type === 'export');

  const imports = nodes.filter(n => n.type === 'import');
  const hasNamedImports = imports.length > 0;
  const hasDefaultImports = imports.length > 0;

  const hasAsyncAwait = functions.some(f => f.signature?.return_type?.includes('Promise'));

  const errorHandlingPatterns = (cas.patterns || []).filter(p =>
    p.name.toLowerCase().includes('error') || p.name.toLowerCase().includes('exception')
  );

  const customErrors = classes.filter(c =>
    c.name.toLowerCase().includes('error') || c.name.toLowerCase().includes('exception')
  );

  return {
    naming: {
      functions: detectPattern(functionNames),
      classes: detectPattern(classNames),
      files: detectPattern(fileNames),
      variables: detectPattern(functions.flatMap(f => f.children || []).slice(0, 20).map(id => {
        const node = cas.nodes.find(n => n.id === id);
        return node?.name || '';
      }).filter(Boolean)),
      constants: detectPattern(nodes.filter(n => n.type === 'constant' || n.type === 'constant_util').map(n => n.name)),
    },
    file_organization: {
      structure_pattern: hasIndexFiles ? 'feature-based' : 'layer-based',
      index_files: hasIndexFiles,
      barrel_exports: hasBarrelExports,
    },
    imports: {
      style: hasNamedImports && hasDefaultImports ? 'mixed' : (hasNamedImports ? 'named' : 'default'),
      order: ['builtin', 'external', 'internal', 'relative'],
    },
    error_handling: {
      pattern: customErrors.length > 0 ? 'exceptions' : 'try-catch',
      custom_error_classes: customErrors.slice(0, 5).map(e => ({ name: e.name, usage: 'custom exception' })),
      example_node_id: errorHandlingPatterns[0]?.instances?.[0],
    },
    async_patterns: {
      preferred: hasAsyncAwait ? 'async-await' : 'promises',
      error_handling: 'try-catch',
    },
  };
}

export function getModificationGuide(
  cas: CASOutput,
  nodeId: string,
  changeType: 'signature' | 'behavior' | 'delete' | 'add_parameter' | 'rename'
) {
  const node = cas.nodes.find(n => n.id === nodeId);
  if (!node) return { error: `Node not found: ${nodeId}` };

  const changeRisk = (cas.change_risks || []).find(r => r.node_id === nodeId);
  const callersResult = getCallers(cas, nodeId, 3, 100);
  const tests = findTests(cas, { nodeId });

  const riskLevel = changeRisk?.risk_level ||
    (callersResult.total > 20 ? 'high' : (callersResult.total > 5 ? 'medium' : 'low'));

  const criticalPathAffected = (cas.call_chains || []).some(chain =>
    chain.criticality === 'critical' && chain.call_path?.some(step => step.node_id === nodeId)
  );

  const mustUpdate: Array<{ node_id: string; name: string; file: string; line?: number; reason: string; suggested_change: string }> = [];
  const shouldVerify: Array<{ check: string; how: string; automated: boolean }> = [];

  if (changeType === 'signature' || changeType === 'add_parameter' || changeType === 'rename') {
    for (const caller of callersResult.callers.slice(0, 20)) {
      const callerNode = cas.nodes.find(n => n.id === caller.node_id);
      if (callerNode) {
        mustUpdate.push({
          node_id: caller.node_id,
          name: caller.name,
          file: callerNode.source?.file || 'unknown',
          line: callerNode.source?.line,
          reason: changeType === 'rename' ? 'Update reference to new name' : 'Update call to match new signature',
          suggested_change: changeType === 'rename' ? `Rename reference from ${node.name}` : 'Add/update parameters',
        });
      }
    }
  }

  if (changeType === 'delete') {
    for (const caller of callersResult.callers) {
      const callerNode = cas.nodes.find(n => n.id === caller.node_id);
      if (callerNode) {
        mustUpdate.push({
          node_id: caller.node_id,
          name: caller.name,
          file: callerNode.source?.file || 'unknown',
          line: callerNode.source?.line,
          reason: 'Remove reference to deleted code',
          suggested_change: 'Find alternative or remove call',
        });
      }
    }
  }

  shouldVerify.push({ check: 'No type errors', how: 'Run TypeScript compiler', automated: true });
  shouldVerify.push({ check: 'All tests pass', how: 'Run test suite', automated: true });

  if (changeType === 'behavior') {
    shouldVerify.push({ check: 'Behavior change documented', how: 'Update comments/docs', automated: false });
  }

  const existingTests = tests.suites.map(s => ({
    test_id: s.file_path,
    name: s.name,
    file: s.file_path,
    covers_this_change: true,
  }));

  const testsToAdd: Array<{ type: 'unit' | 'integration'; reason: string; similar_test_id?: string }> = [];
  if (existingTests.length === 0) {
    testsToAdd.push({ type: 'unit', reason: 'No existing tests for this code' });
  }
  if (changeType === 'behavior' && existingTests.length > 0) {
    testsToAdd.push({ type: 'unit', reason: 'Add test for new behavior', similar_test_id: existingTests[0]?.test_id });
  }

  const runCommand = tests.suites.length > 0
    ? `npm test -- ${tests.suites.map(s => s.file_path).join(' ')}`
    : 'npm test';

  return {
    risk_level: riskLevel,
    change_summary: {
      what_changes: `${changeType} of ${node.type} "${node.name}"`,
      blast_radius: callersResult.total,
      critical_path_affected: criticalPathAffected,
    },
    must_update: mustUpdate,
    should_verify: shouldVerify,
    tests: {
      existing: existingTests,
      to_add: testsToAdd,
      run_command: runCommand,
    },
    rollback_considerations: [
      changeType === 'delete' ? 'Restore from version control if needed' : 'Revert signature changes',
      'Check for cached/compiled artifacts',
    ],
  };
}

export function getPatternExamples(
  cas: CASOutput,
  patternId: string,
  opts: { variation_id?: string; limit?: number } = {}
) {
  const pattern = (cas.patterns || []).find(p => p.id === patternId);
  if (!pattern) return { error: `Pattern not found: ${patternId}` };

  const limit = opts.limit || 3;
  let instanceIds: string[] = [];

  if (opts.variation_id) {
    const variation = pattern.variations?.find(v => v.id === opts.variation_id);
    if (variation) {
      instanceIds = variation.instances || [];
    }
  } else {
    instanceIds = pattern.instances || [];
  }

  const examples = instanceIds.slice(0, limit).map(nodeId => {
    const node = cas.nodes.find(n => n.id === nodeId);
    if (!node) return null;

    return {
      node_id: node.id,
      name: node.name,
      file: node.source?.file,
      line: node.source?.line,
      code_snippet: node.signature || `${node.type} ${node.name}`,
      annotations: [] as Array<{ line: number; explanation: string }>,
      why_exemplary: `Example of ${pattern.name} pattern with ${pattern.confidence} confidence`,
    };
  }).filter(Boolean);

  return {
    pattern: {
      id: pattern.id,
      name: pattern.name,
      description: pattern.description,
    },
    examples,
  };
}

export function findSimilarCode(
  cas: CASOutput,
  opts: {
    node_id?: string;
    code_snippet?: string;
    similarity_type?: 'structural' | 'semantic' | 'both';
    limit?: number;
  }
) {
  const limit = opts.limit || 10;
  const similarityType = opts.similarity_type || 'both';

  let targetNode: CASNode | undefined;
  if (opts.node_id) {
    targetNode = cas.nodes.find(n => n.id === opts.node_id);
    if (!targetNode) return { error: `Node not found: ${opts.node_id}` };
  }

  if (!targetNode && !opts.code_snippet) {
    return { error: 'Either node_id or code_snippet required' };
  }

  const targetType = targetNode?.type;

  const candidates = cas.nodes.filter(n => {
    if (targetNode && n.id === targetNode.id) return false;
    if (similarityType === 'structural' || similarityType === 'both') {
      if (targetType && n.type !== targetType) return false;
    }
    return true;
  });

  const scored = candidates.map(n => {
    let score = 0;
    const reasons: string[] = [];
    const differences: string[] = [];

    if (n.type === targetType) {
      score += 0.3;
      reasons.push('Same type');
    } else {
      differences.push(`Different type: ${n.type} vs ${targetType}`);
    }

    if (targetNode?.parent && n.parent === targetNode.parent) {
      score += 0.2;
      reasons.push('Same parent');
    }

    const targetPatterns = (cas.patterns || []).filter(p => p.instances?.includes(targetNode?.id || ''));
    const nodePatterns = (cas.patterns || []).filter(p => p.instances?.includes(n.id));
    const sharedPatterns = targetPatterns.filter(tp => nodePatterns.some(np => np.id === tp.id));
    if (sharedPatterns.length > 0) {
      score += 0.2 * sharedPatterns.length;
      reasons.push(`Shares patterns: ${sharedPatterns.map(p => p.name).join(', ')}`);
    }

    const targetDecorators = (cas.decorators || []).filter(d => d.target_node === targetNode?.id).map(d => d.decorator_info.name);
    const nodeDecorators = (cas.decorators || []).filter(d => d.target_node === n.id).map(d => d.decorator_info.name);
    const sharedDecorators = targetDecorators.filter(d => nodeDecorators.includes(d));
    if (sharedDecorators.length > 0) {
      score += 0.15 * sharedDecorators.length;
      reasons.push(`Same decorators: ${sharedDecorators.join(', ')}`);
    }

    if (similarityType === 'semantic' || similarityType === 'both') {
      const targetWords = splitCamelCase(targetNode?.name || '');
      const nodeWords = splitCamelCase(n.name);
      const sharedWords = targetWords.filter(w => nodeWords.includes(w));
      if (sharedWords.length > 0) {
        score += 0.1 * sharedWords.length;
        reasons.push(`Similar naming: ${sharedWords.join(', ')}`);
      }
    }

    return { node: n, score, reasons, differences };
  });

  scored.sort((a, b) => b.score - a.score);

  const similar = scored.slice(0, limit).filter(s => s.score > 0.2).map(s => ({
    node_id: s.node.id,
    name: s.node.name,
    file: s.node.source?.file,
    line: s.node.source?.line,
    similarity_score: Math.min(s.score, 1),
    similarity_reasons: s.reasons,
    differences: s.differences,
    reuse_recommendation: s.score > 0.7 ? 'extract_shared' as const :
      (s.score > 0.4 ? 'copy_pattern' as const : 'reference_only' as const),
  }));

  return {
    query: { node_id: opts.node_id, snippet_hash: opts.code_snippet ? hashCode(opts.code_snippet) : undefined },
    similar,
  };
}

function hashCode(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(16);
}

interface CollectedComment {
  type: string;
  text: string;
  purpose?: string;
  file: string;
  line: number;
  node_id: string;
  node_name: string;
}

export function getComments(
  cas: CASOutput,
  opts: {
    scope: 'node' | 'file' | 'module' | 'all';
    node_id?: string;
    file_path?: string;
    types?: Array<'todo' | 'fixme' | 'hack' | 'note' | 'warning'>;
    limit?: number;
  }
) {
  const maxResults = opts.limit || 50;
  const types = opts.types || ['todo', 'fixme', 'hack', 'note', 'warning'];

  const allComments: CollectedComment[] = [];

  for (const node of cas.nodes) {
    if (node.comments) {
      for (const comment of node.comments) {
        allComments.push({
          type: comment.type,
          text: comment.text,
          purpose: comment.purpose,
          file: comment.location.file,
          line: comment.location.line,
          node_id: node.id,
          node_name: node.name,
        });
      }
    }

    if (node.todos) {
      for (const todo of node.todos) {
        allComments.push({
          type: todo.type,
          text: todo.text,
          purpose: todo.type,
          file: todo.location?.file || node.source?.file || 'unknown',
          line: todo.location?.line || node.source?.line || 0,
          node_id: node.id,
          node_name: node.name,
        });
      }
    }
  }

  let comments = allComments;

  if (opts.scope === 'node' && opts.node_id) {
    comments = comments.filter(c => c.node_id === opts.node_id);
  } else if (opts.scope === 'file' && opts.file_path) {
    const normalizedPath = opts.file_path.replace(/\\/g, '/');
    comments = comments.filter(c =>
      c.file.replace(/\\/g, '/').endsWith(normalizedPath)
    );
  } else if (opts.scope === 'module' && opts.node_id) {
    const moduleNode = cas.nodes.find(n => n.id === opts.node_id);
    if (!moduleNode) return { error: `Module not found: ${opts.node_id}` };

    const childIds = new Set(moduleNode.children || []);
    childIds.add(opts.node_id);
    comments = comments.filter(c => childIds.has(c.node_id));
  }

  comments = comments.filter(c => {
    const commentPurpose = (c.purpose || c.type).toLowerCase();
    const commentText = c.text.toLowerCase();
    return types.some(t =>
      commentPurpose.includes(t) ||
      commentText.includes(t.toUpperCase()) ||
      commentText.startsWith(t.toUpperCase() + ':')
    );
  });

  const byType: Record<string, number> = {};
  const byPurpose: Record<string, number> = {};

  for (const c of comments) {
    byType[c.type] = (byType[c.type] || 0) + 1;
    if (c.purpose) {
      byPurpose[c.purpose] = (byPurpose[c.purpose] || 0) + 1;
    }
  }

  return {
    total: comments.length,
    by_type: byType,
    by_purpose: byPurpose,
    comments: comments.slice(0, maxResults).map(c => ({
      type: c.type,
      text: c.text,
      purpose: c.purpose,
      file: c.file,
      line: c.line,
      node_id: c.node_id,
      node_name: c.node_name,
    })),
  };
}

export function getErrorContracts(
  cas: CASOutput,
  nodeId: string,
  direction: 'throws' | 'catches' | 'both' = 'both'
) {
  const node = cas.nodes.find(n => n.id === nodeId);
  if (!node) return { error: `Node not found: ${nodeId}` };

  const throws: Array<{ error_type: string; conditions?: string; documented: boolean }> = [];
  const caughtBy: Array<{ caller_id: string; caller_name: string; handling: 'caught' | 'propagated' | 'ignored' }> = [];

  if (direction === 'throws' || direction === 'both') {
    if (node.signature?.throws) {
      for (const errorType of node.signature.throws) {
        throws.push({
          error_type: errorType,
          documented: true,
        });
      }
    }

    const methodCalls = (cas.method_calls || []).filter(mc =>
      mc.caller_node === nodeId &&
      (mc.call_details.method_name.toLowerCase().includes('throw') ||
       mc.call_details.method_name.toLowerCase() === 'error')
    );
    for (const mc of methodCalls) {
      if (!throws.some(t => t.error_type === mc.call_details.method_name)) {
        throws.push({
          error_type: mc.call_details.method_name,
          documented: false,
        });
      }
    }

    const constructorCalls = (cas.method_calls || []).filter(mc =>
      mc.caller_node === nodeId && mc.call_details.call_type === 'constructor'
    );
    for (const mc of constructorCalls) {
      if (mc.call_details.method_name.toLowerCase().includes('error') ||
          mc.call_details.method_name.toLowerCase().includes('exception')) {
        if (!throws.some(t => t.error_type === mc.call_details.method_name)) {
          throws.push({
            error_type: mc.call_details.method_name,
            documented: false,
          });
        }
      }
    }
  }

  if (direction === 'catches' || direction === 'both') {
    const callers = getCallers(cas, nodeId, 2, 50);

    for (const caller of callers.callers) {
      const callerNode = cas.nodes.find(n => n.id === caller.node_id);
      if (!callerNode) continue;

      const hasTryCatch = (cas.patterns || []).some(p =>
        p.name.toLowerCase().includes('try-catch') &&
        p.instances?.includes(caller.node_id)
      );

      caughtBy.push({
        caller_id: caller.node_id,
        caller_name: caller.name,
        handling: hasTryCatch ? 'caught' : 'propagated',
      });
    }
  }

  const uncaughtPaths: Array<{ entry_point_id: string; entry_point_name: string; path_description: string }> = [];

  if (throws.length > 0) {
    const chains = (cas.call_chains || []).filter(chain =>
      chain.call_path?.some(step => step.node_id === nodeId)
    );

    for (const chain of chains.slice(0, 5)) {
      const allHandled = caughtBy.some(c => c.handling === 'caught');
      if (!allHandled) {
        const entryPointId = chain.entry_point.entry_point_id || chain.entry_point.node_id;
        const entryPointData = (cas.entry_points || []).find(ep => ep.id === entryPointId);
        uncaughtPaths.push({
          entry_point_id: entryPointId,
          entry_point_name: entryPointData?.name || chain.entry_point.method_name || 'unknown',
          path_description: `Error may propagate to ${entryPointData?.type || 'unknown'} entry point`,
        });
      }
    }
  }

  return {
    node: { id: node.id, name: node.name },
    throws,
    caught_by: caughtBy,
    uncaught_paths: uncaughtPaths,
  };
}

export function getFrameworkGuidance(
  cas: CASOutput,
  opts: {
    framework?: string;
    topic?: 'routing' | 'state' | 'data-fetching' | 'testing' | 'security';
  } = {}
) {
  const frameworks = cas.system?.technologies?.frameworks || [];
  const targetFramework = opts.framework
    ? frameworks.find(f => f.name.toLowerCase().includes(opts.framework!.toLowerCase()))
    : frameworks[0];

  if (!targetFramework) {
    return { error: opts.framework ? `Framework not found: ${opts.framework}` : 'No frameworks detected' };
  }

  const frameworkPatterns = (cas.patterns || []).filter(p =>
    p.name.toLowerCase().includes(targetFramework.name.toLowerCase()) ||
    p.variations?.some(v => v.implementation?.toLowerCase().includes(targetFramework.name.toLowerCase()))
  );

  const detectedPatterns = frameworkPatterns.map(p => ({
    pattern: p.name,
    usage_count: p.instances?.length || 0,
    is_recommended: p.type !== 'anti-pattern',
  }));

  const recommendations: Array<{
    topic: string;
    current_approach: string;
    recommended_approach: string;
    example_node_id?: string;
    migration_effort: 'trivial' | 'moderate' | 'significant';
  }> = [];

  const antiPatterns = (cas.patterns || []).filter(p =>
    p.type === 'anti-pattern' &&
    (p.name.toLowerCase().includes(targetFramework.name.toLowerCase()) ||
     p.instances?.some(id => {
       const node = cas.nodes.find(n => n.id === id);
       return node?.tags?.includes(targetFramework.name.toLowerCase());
     }))
  );

  const antiPatternsFound = antiPatterns.map(p => ({
    pattern: p.name,
    locations: (p.instances || []).slice(0, 5),
    suggested_fix: p.description || 'Refactor to follow framework best practices',
  }));

  if (opts.topic === 'routing' || !opts.topic) {
    const routeCount = cas.route_table?.length || 0;
    if (routeCount > 0) {
      const routes = cas.route_table || [];
      const hasAuth = routes.some((r: any) => r.auth || r.guards?.some((guard: string) => isAuthenticationGuardName(guard)));
      if (!hasAuth && routeCount > 5) {
        recommendations.push({
          topic: 'routing',
          current_approach: 'Routes without authentication guards',
          recommended_approach: 'Add authentication middleware or guards to protected routes',
          migration_effort: 'moderate',
        });
      }
    }
  }

  if (opts.topic === 'testing' || !opts.topic) {
    const testSummary = cas.test_summary;
    if (testSummary) {
      const coverage = testSummary.coverage?.overall_percentage || 0;
      if (coverage < 50) {
        recommendations.push({
          topic: 'testing',
          current_approach: `${coverage}% test coverage`,
          recommended_approach: 'Increase test coverage to at least 70%',
          migration_effort: 'significant',
        });
      }
    }
  }

  return {
    framework: {
      name: targetFramework.name,
      version: targetFramework.version,
    },
    detected_patterns: detectedPatterns,
    recommendations,
    anti_patterns_found: antiPatternsFound,
  };
}

export function getUsageExamples(
  cas: CASOutput,
  nodeId: string,
  opts: { limit?: number; include_tests?: boolean } = {}
) {
  const node = cas.nodes.find(n => n.id === nodeId);
  if (!node) return { error: `Node not found: ${nodeId}` };

  const limit = opts.limit || 10;
  const includeTests = opts.include_tests || false;

  const callers = getCallers(cas, nodeId, 1, 100);

  let usageNodes = callers.callers.map(c => cas.nodes.find(n => n.id === c.node_id)).filter(Boolean) as CASNode[];

  if (!includeTests) {
    usageNodes = usageNodes.filter(n =>
      !n.source?.file?.includes('.test.') &&
      !n.source?.file?.includes('.spec.') &&
      !n.source?.file?.includes('__tests__')
    );
  }

  const usagePatterns: Record<string, { count: number; locations: Array<{ file: string; line: number; snippet: string }> }> = {};

  for (const usageNode of usageNodes.slice(0, 50)) {
    const patternKey = usageNode.type;
    if (!usagePatterns[patternKey]) {
      usagePatterns[patternKey] = { count: 0, locations: [] };
    }
    usagePatterns[patternKey].count++;
    if (usagePatterns[patternKey].locations.length < 3) {
      usagePatterns[patternKey].locations.push({
        file: usageNode.source?.file || 'unknown',
        line: usageNode.source?.line || 0,
        snippet: `${usageNode.name} calls ${node.name}`,
      });
    }
  }

  const patterns = Object.entries(usagePatterns)
    .map(([pattern, data]) => ({
      pattern_description: `Used by ${pattern}`,
      frequency: data.count,
      example_locations: data.locations,
    }))
    .sort((a, b) => b.frequency - a.frequency)
    .slice(0, 5);

  return {
    node: { id: node.id, name: node.name, type: node.type },
    usage_count: callers.total,
    usage_patterns: patterns,
    common_mistakes: [],
  };
}

export function getConfiguration(
  cas: CASOutput,
  opts: {
    scope?: 'all' | 'runtime' | 'build' | 'test';
    affecting_node_id?: string;
  } = {}
) {
  const scope = opts.scope || 'all';
  const config = cas.configuration || {};

  const configNodes = cas.nodes.filter(n =>
    n.type === 'config' ||
    n.type === 'configuration' ||
    n.name.toLowerCase().includes('config') ||
    n.source?.file?.includes('config')
  );

  let filteredNodes = configNodes;

  if (scope === 'runtime') {
    filteredNodes = configNodes.filter(n =>
      !n.source?.file?.includes('test') &&
      !n.source?.file?.includes('jest') &&
      !n.source?.file?.includes('webpack') &&
      !n.source?.file?.includes('vite') &&
      !n.source?.file?.includes('rollup')
    );
  } else if (scope === 'build') {
    filteredNodes = configNodes.filter(n =>
      n.source?.file?.includes('webpack') ||
      n.source?.file?.includes('vite') ||
      n.source?.file?.includes('rollup') ||
      n.source?.file?.includes('tsconfig') ||
      n.source?.file?.includes('babel')
    );
  } else if (scope === 'test') {
    filteredNodes = configNodes.filter(n =>
      n.source?.file?.includes('test') ||
      n.source?.file?.includes('jest') ||
      n.source?.file?.includes('vitest')
    );
  }

  let scopedEnvVars = config.environment_variables || [];
  let scopedFeatureFlags = config.feature_flags || [];

  if (opts.affecting_node_id) {
    const targetNode = cas.nodes.find(n => n.id === opts.affecting_node_id);
    if (!targetNode) return { error: `Node not found: ${opts.affecting_node_id}` };

    const relatedConfigs = filteredNodes.filter(cn => {
      const configEdges = cas.edges.filter(e =>
        (e.source === cn.id && e.target === opts.affecting_node_id) ||
        (e.target === cn.id && e.source === opts.affecting_node_id)
      );
      return configEdges.length > 0;
    });

    if (relatedConfigs.length > 0) {
      filteredNodes = relatedConfigs;
    }

    // Node-scoped process.env.* discovery: cas.configuration.environment_variables is only
    // ever populated from .env-shaped FILES (see buildConfiguration in orchestrator.ts) — a
    // plain `export const X = process.env.X === 'true'` in an ordinary source file (e.g.
    // config.ts) is invisible to that mechanism no matter what affecting_node_id is passed,
    // even though the target node directly imports and branches on it (bug #4, 2026-07-04
    // impact benchmark: QuotaEnforcementInterceptor imports ENFORCE_API_QUOTAS from
    // '../../../config' and gates its entire behavior on it, yet get_configuration scoped to
    // that class returned an empty environment_variables array). Walk the 'references' edges
    // (see the extractIdentifierReferences fix for bug #1) from affecting_node_id to any
    // variable node whose initializer literally reads process.env.*, and surface those
    // directly — real, evidence-based (regex over the actual captured initializer text), not
    // fabricated, and additive to whatever cas.configuration already found.
    const PROCESS_ENV_RE = /process\.env\.([A-Za-z_][A-Za-z0-9_]*)/;
    const referencedVarIds = new Set(
      cas.edges
        .filter(e => e.type === 'references' && e.source === opts.affecting_node_id)
        .map(e => e.target)
    );
    const discoveredEnvVars: NonNullable<typeof scopedEnvVars> = [];
    for (const varId of referencedVarIds) {
      const varNode = cas.nodes.find(n => n.id === varId);
      if (!varNode || varNode.type !== 'variable') continue;
      const initializer = (varNode.metadata as any)?.value;
      if (typeof initializer !== 'string') continue;
      const match = PROCESS_ENV_RE.exec(initializer);
      if (!match) continue;
      const envVarName = match[1];
      const alreadyKnown = scopedEnvVars.some(ev => ev.name === envVarName);
      if (alreadyKnown) continue;
      discoveredEnvVars.push({
        name: envVarName,
        description: `Discovered via direct process.env read in '${varNode.name}' (${varNode.source?.file}:${varNode.source?.line}), referenced by the target node.`,
        used_by: [opts.affecting_node_id],
      });
    }

    if (discoveredEnvVars.length > 0 || relatedConfigs.length > 0) {
      // Node-scoped result: only what's actually connected to this node (the discovered
      // process.env reads plus any cas.configuration entries whose used_by/affected_nodes
      // already names this node) — not the whole repo's env var list.
      scopedEnvVars = [
        ...scopedEnvVars.filter(ev => ev.used_by?.includes(opts.affecting_node_id!)),
        ...discoveredEnvVars,
      ];
      scopedFeatureFlags = scopedFeatureFlags.filter(ff => ff.affected_nodes?.includes(opts.affecting_node_id!));
    }
  }

  return {
    scope,
    config_files: [...new Set(filteredNodes.map(n => n.source?.file).filter(Boolean))],
    config_nodes: filteredNodes.slice(0, 20).map(n => ({
      id: n.id,
      name: n.name,
      type: n.type,
      file: n.source?.file,
      line: n.source?.line,
    })),
    environment_variables: scopedEnvVars,
    feature_flags: scopedFeatureFlags,
  };
}

export function getLevel(
  cas: CASOutput,
  level: number,
  opts: {
    limit?: number;
    offset?: number;
    edge_limit?: number;
    include_edges?: boolean;
    include_entry_exit?: boolean;
  } = {}
) {
  const levelDef = cas.progressive_levels?.level_definitions?.find(
    d => d.level === level
  ) || null;

  const allNodes = cas.nodes.filter(n => n.level === level);
  const totalNodes = allNodes.length;
  const limit = opts.limit ?? 50;
  const offset = opts.offset ?? 0;
  const nodes = allNodes.slice(offset, offset + limit);
  const nodeIds = new Set(nodes.map(n => n.id));

  const nodeResponse = nodes.map(n => ({
    id: n.id,
    name: n.name,
    type: n.type,
    qualified_name: n.qualified_name,
    category: n.category,
    file: n.source?.file,
    line: n.source?.line,
    parent: n.parent,
    children_count: n.children?.length ?? 0,
  }));

  let internalEdges: ReturnType<typeof trimEdge>[] = [];
  let crossLevelEdges: Array<ReturnType<typeof trimEdge> & { external_id: string }> = [];
  let nodeRefs: Record<string, { name: string; type: string; level: number }> = {};
  let totalInternalEdges = 0;
  let totalCrossLevelEdges = 0;

  if (opts.include_edges !== false) {
    const edgeLimit = opts.edge_limit ?? 200;

    const relevantEdges = cas.edges.filter(
      e => nodeIds.has(e.source) || nodeIds.has(e.target)
    );

    const internal = relevantEdges.filter(
      e => nodeIds.has(e.source) && nodeIds.has(e.target)
    );
    const crossLevel = relevantEdges.filter(
      e => !nodeIds.has(e.source) || !nodeIds.has(e.target)
    );

    totalInternalEdges = internal.length;
    totalCrossLevelEdges = crossLevel.length;

    internalEdges = internal.slice(0, edgeLimit).map(trimEdge);

    const remainingLimit = Math.max(0, edgeLimit - internalEdges.length);
    crossLevelEdges = crossLevel.slice(0, remainingLimit).map(e => {
      const externalId = nodeIds.has(e.source) ? e.target : e.source;
      const externalNode = cas.nodes.find(n => n.id === externalId);

      if (externalNode && !nodeRefs[externalId]) {
        nodeRefs[externalId] = {
          name: externalNode.name,
          type: externalNode.type,
          level: externalNode.level ?? -1,
        };
      }

      return {
        ...trimEdge(e),
        external_id: externalId,
      };
    });
  }

  let entryPoints: Array<{ id: string; type: string; name: string; source_node?: string }> = [];
  let exitPoints: Array<{ id: string; type: string; name: string; source_node?: string }> = [];
  let totalEntryPoints = 0;
  let totalExitPoints = 0;

  if (opts.include_entry_exit !== false) {
    const epLimit = 25;

    const filteredEntry = (cas.entry_points || []).filter(ep =>
      (ep.source_node && nodeIds.has(ep.source_node)) ||
      (ep.handler?.node_id && nodeIds.has(ep.handler.node_id))
    );
    totalEntryPoints = filteredEntry.length;
    entryPoints = filteredEntry.slice(0, epLimit).map(ep => ({
      id: ep.id,
      type: ep.type,
      name: ep.name,
      source_node: ep.source_node,
    }));

    const filteredExit = (cas.exit_points || []).filter(ep =>
      ep.source_node && nodeIds.has(ep.source_node)
    );
    totalExitPoints = filteredExit.length;
    exitPoints = filteredExit.slice(0, epLimit).map(ep => ({
      id: ep.id,
      type: ep.type,
      name: typeof ep.name === 'string'
        ? ep.name
        : (ep.target?.endpoint || ep.target?.resource || ep.target?.service_id || 'unknown'),
      source_node: ep.source_node,
    }));
  }

  return {
    level,
    definition: levelDef ? {
      name: levelDef.name,
      description: levelDef.description,
    } : null,
    pagination: {
      total_nodes: totalNodes,
      offset,
      limit,
      has_more: offset + limit < totalNodes,
    },
    edges_summary: opts.include_edges !== false ? {
      internal_count: totalInternalEdges,
      cross_level_count: totalCrossLevelEdges,
      internal_returned: internalEdges.length,
      cross_level_returned: crossLevelEdges.length,
    } : null,
    entry_exit_summary: opts.include_entry_exit !== false ? {
      entry_count: totalEntryPoints,
      exit_count: totalExitPoints,
      entry_returned: entryPoints.length,
      exit_returned: exitPoints.length,
    } : null,
    available_levels: cas.progressive_levels?.level_definitions?.map(d => ({
      level: d.level,
      name: d.name,
      node_count: d.node_count,
    })) || [],
    nodes: nodeResponse,
    internal_edges: internalEdges.length > 0 ? internalEdges : undefined,
    cross_level_edges: crossLevelEdges.length > 0 ? crossLevelEdges : undefined,
    node_refs: Object.keys(nodeRefs).length > 0 ? nodeRefs : undefined,
    entry_points: entryPoints.length > 0 ? entryPoints : undefined,
    exit_points: exitPoints.length > 0 ? exitPoints : undefined,
  };
}

export async function getChangesSince(
  projectPath: string,
  since: string,
  opts: { limit?: number } = {}
): Promise<ChangeHistoryEntry[]> {
  return loadChangeHistory(projectPath, {
    since,
    limit: opts.limit || 50,
  });
}

export async function getChangesBetween(
  projectPath: string,
  from: string,
  to: string,
  opts: { limit?: number } = {}
): Promise<ChangeHistoryEntry[]> {
  return loadChangeHistory(projectPath, {
    since: from,
    until: to,
    limit: opts.limit || 50,
  });
}

export async function getChangesForNode(
  cas: CASOutput,
  projectPath: string,
  nodeId: string,
  opts: {
    since?: string;
    includeCallers?: boolean;
    includeCallees?: boolean;
    depth?: number;
    limit?: number;
  } = {}
): Promise<ChangeHistoryEntry[]> {
  const allHistory = await loadChangeHistory(projectPath, {
    since: opts.since,
    limit: 500,
  });

  const relevantNodeIds = new Set<string>([nodeId]);

  if (opts.includeCallers || opts.includeCallees) {
    const maxDepth = opts.depth || 1;

    for (let d = 0; d < maxDepth; d++) {
      const currentIds = Array.from(relevantNodeIds);
      for (const id of currentIds) {
        for (const edge of cas.edges) {
          if (opts.includeCallers && edge.target === id && edge.type === 'calls') {
            relevantNodeIds.add(edge.source);
          }
          if (opts.includeCallees && edge.source === id && edge.type === 'calls') {
            relevantNodeIds.add(edge.target);
          }
        }
      }
    }
  }

  const filteredHistory = allHistory.filter(entry => {
    for (const nodeChange of entry.changes.nodes) {
      if (relevantNodeIds.has(nodeChange.nodeId)) {
        return true;
      }
    }
    return false;
  });

  return filteredHistory.slice(0, opts.limit || 25);
}

export async function getChangesForFile(
  cas: CASOutput,
  projectPath: string,
  filePath: string,
  opts: {
    since?: string;
    includeImporters?: boolean;
    includeImported?: boolean;
    limit?: number;
  } = {}
): Promise<ChangeHistoryEntry[]> {
  const allHistory = await loadChangeHistory(projectPath, {
    since: opts.since,
    limit: 500,
  });

  const relevantFiles = new Set<string>([normalizeFilePathForMatch(filePath)]);
  const addRelevantFile = (value: string) => relevantFiles.add(normalizeFilePathForMatch(value));

  if (opts.includeImporters || opts.includeImported) {
    for (const node of cas.nodes) {
      const nodeFile = node.source?.file;
      if (!nodeFile) continue;

      if (opts.includeImported && pathsReferToSameFile(nodeFile, filePath)) {
        const imports = (node.metadata as Record<string, unknown>)?.imports;
        if (Array.isArray(imports)) {
          for (const imp of imports) {
            if (typeof imp === 'string') addRelevantFile(imp);
          }
        }
      }

      if (opts.includeImporters) {
        const imports = (node.metadata as Record<string, unknown>)?.imports;
        if (Array.isArray(imports) && imports.some(imp => typeof imp === 'string' && pathsReferToSameFile(imp, filePath))) {
          addRelevantFile(nodeFile);
        }
      }
    }
  }

  const relevantFileList = Array.from(relevantFiles);
  const filteredHistory = allHistory.filter(entry => {
    for (const fileChange of entry.changes.files) {
      if (relevantFileList.some(relevantFile => pathsReferToSameFile(fileChange.path, relevantFile))) {
        return true;
      }
    }
    return false;
  });

  return filteredHistory.slice(0, opts.limit || 25);
}

export async function getChangesForEntryPoint(
  cas: CASOutput,
  projectPath: string,
  entryPointId: string,
  opts: {
    since?: string;
    includeFullChain?: boolean;
    limit?: number;
  } = {}
): Promise<ChangeHistoryEntry[]> {
  const ep = (cas.entry_points || []).find(e => e.id === entryPointId);
  if (!ep) return [];

  const relevantNodeIds = new Set<string>();

  if (ep.source_node) {
    relevantNodeIds.add(ep.source_node);
  }

  if (ep.handler?.node_id) {
    relevantNodeIds.add(ep.handler.node_id);
  }

  for (const nodeId of ep.connected_nodes || []) {
    relevantNodeIds.add(nodeId);
  }

  if (opts.includeFullChain && cas.call_chains) {
    for (const chain of cas.call_chains) {
      if (chain.entry_point?.entry_point_id === entryPointId ||
          chain.entry_point?.node_id === ep.handler?.node_id) {
        for (const step of chain.call_path) {
          relevantNodeIds.add(step.node_id);
        }
      }
    }
  }

  const allHistory = await loadChangeHistory(projectPath, {
    since: opts.since,
    limit: 500,
  });

  const filteredHistory = allHistory.filter(entry => {
    for (const entryPointChange of entry.changes.entryPoints) {
      if (entryPointChange.entryPointId === entryPointId) {
        return true;
      }
    }

    for (const nodeChange of entry.changes.nodes) {
      if (relevantNodeIds.has(nodeChange.nodeId)) {
        return true;
      }
    }
    return false;
  });

  return filteredHistory.slice(0, opts.limit || 25);
}

export async function getChangeSummary(
  projectPath: string,
  opts: {
    since?: string;
    until?: string;
    groupBy: 'file' | 'module' | 'author' | 'intent' | 'day' | 'week';
  }
): Promise<ChangeAggregate[]> {
  const history = await loadChangeHistory(projectPath, {
    since: opts.since,
    until: opts.until,
    limit: 1000,
  });

  const groups = new Map<string, {
    changes: number;
    filesChanged: Set<string>;
    nodesAdded: number;
    nodesModified: number;
    nodesDeleted: number;
    linesAdded: number;
    linesRemoved: number;
    risks: string[];
  }>();

  for (const entry of history) {
    let key: string;
    let label: string;

    switch (opts.groupBy) {
      case 'file': {
        for (const fc of entry.changes.files) {
          key = fc.path;
          label = fc.path;
          const group = groups.get(key) || createEmptyGroup();
          group.changes++;
          group.filesChanged.add(fc.path);
          group.linesAdded += fc.linesAdded;
          group.linesRemoved += fc.linesRemoved;
          group.risks.push(entry.impact.riskLevel);
          groups.set(key, group);
        }
        continue;
      }
      case 'author':
        key = entry.author || 'unknown';
        label = entry.author || 'Unknown Author';
        break;
      case 'intent':
        key = entry.intent.type;
        label = entry.intent.type.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
        break;
      case 'day': {
        const date = new Date(entry.timestamp);
        key = date.toISOString().split('T')[0];
        label = key;
        break;
      }
      case 'week': {
        const date = new Date(entry.timestamp);
        const weekStart = new Date(date);
        weekStart.setDate(date.getDate() - date.getDay());
        key = weekStart.toISOString().split('T')[0];
        label = `Week of ${key}`;
        break;
      }
      case 'module':
      default: {
        const firstFile = entry.changes.files[0]?.path || 'unknown';
        const parts = firstFile.split('/');
        key = parts.length > 1 ? parts.slice(0, 2).join('/') : parts[0];
        label = key;
        break;
      }
    }

    const group = groups.get(key) || createEmptyGroup();
    group.changes++;
    for (const fc of entry.changes.files) {
      group.filesChanged.add(fc.path);
      group.linesAdded += fc.linesAdded;
      group.linesRemoved += fc.linesRemoved;
    }
    for (const nc of entry.changes.nodes) {
      if (nc.changeType === 'added') group.nodesAdded++;
      else if (nc.changeType === 'modified') group.nodesModified++;
      else if (nc.changeType === 'deleted') group.nodesDeleted++;
    }
    group.risks.push(entry.impact.riskLevel);
    groups.set(key, { ...group, label } as any);
  }

  const results: ChangeAggregate[] = [];
  for (const [key, group] of groups) {
    const avgRisk = calculateAvgRisk(group.risks);
    const maxRisk = calculateMaxRisk(group.risks);
    const criticalChanges = group.risks.filter(r => r === 'critical').length;

    results.push({
      key,
      label: (group as any).label || key,
      counts: {
        changes: group.changes,
        filesChanged: group.filesChanged.size,
        nodesAdded: group.nodesAdded,
        nodesModified: group.nodesModified,
        nodesDeleted: group.nodesDeleted,
        linesAdded: group.linesAdded,
        linesRemoved: group.linesRemoved,
      },
      impact: {
        avgRisk,
        maxRisk,
        criticalChanges,
      },
      trend: 'stable',
      velocity: group.changes,
    });
  }

  return results.sort((a, b) => b.counts.changes - a.counts.changes);
}

function createEmptyGroup() {
  return {
    changes: 0,
    filesChanged: new Set<string>(),
    nodesAdded: 0,
    nodesModified: 0,
    nodesDeleted: 0,
    linesAdded: 0,
    linesRemoved: 0,
    risks: [] as string[],
  };
}

function calculateAvgRisk(risks: string[]): number {
  if (risks.length === 0) return 0;
  const riskValues: Record<string, number> = { low: 1, medium: 2, high: 3, critical: 4 };
  const sum = risks.reduce((acc, r) => acc + (riskValues[r] || 0), 0);
  return sum / risks.length;
}

function calculateMaxRisk(risks: string[]): 'low' | 'medium' | 'high' | 'critical' {
  if (risks.includes('critical')) return 'critical';
  if (risks.includes('high')) return 'high';
  if (risks.includes('medium')) return 'medium';
  return 'low';
}

export async function getHotSpots(
  cas: CASOutput,
  projectPath: string,
  opts: {
    since?: string;
    limit?: number;
    metric?: 'change-count' | 'churn-lines' | 'bug-fix-rate';
  } = {}
): Promise<HeatMapData> {
  const metric = opts.metric || 'change-count';
  const history = await loadChangeHistory(projectPath, {
    since: opts.since,
    limit: 1000,
  });

  const fileStats = new Map<string, {
    changeCount: number;
    linesChurned: number;
    bugFixes: number;
    totalChanges: number;
  }>();

  for (const entry of history) {
    const isBugFix = entry.intent.type === 'bug-fix';
    for (const fc of entry.changes.files) {
      const stats = fileStats.get(fc.path) || {
        changeCount: 0,
        linesChurned: 0,
        bugFixes: 0,
        totalChanges: 0,
      };
      stats.changeCount++;
      stats.linesChurned += fc.linesAdded + fc.linesRemoved;
      stats.totalChanges++;
      if (isBugFix) stats.bugFixes++;
      fileStats.set(fc.path, stats);
    }
  }

  const data: Array<{ id: string; value: number; raw: number; label: string }> = [];

  for (const [filePath, stats] of fileStats) {
    let raw: number;
    switch (metric) {
      case 'change-count':
        raw = stats.changeCount;
        break;
      case 'churn-lines':
        raw = stats.linesChurned;
        break;
      case 'bug-fix-rate':
        raw = stats.totalChanges > 0 ? stats.bugFixes / stats.totalChanges : 0;
        break;
    }
    data.push({ id: filePath, value: 0, raw, label: filePath.split('/').pop() || filePath });
  }

  data.sort((a, b) => b.raw - a.raw);

  const maxRaw = data.length > 0 ? Math.max(...data.map(d => d.raw)) : 1;
  const minRaw = data.length > 0 ? Math.min(...data.map(d => d.raw)) : 0;
  const range = maxRaw - minRaw || 1;

  for (const d of data) {
    d.value = (d.raw - minRaw) / range;
  }

  const limit = opts.limit || 20;
  const topData = data.slice(0, limit);

  return {
    type: metric === 'change-count' ? 'churn'
        : metric === 'churn-lines' ? 'churn'
        : 'bugs',
    resolution: 'file',
    data: topData,
    scale: {
      min: minRaw,
      max: maxRaw,
      median: data.length > 0 ? data[Math.floor(data.length / 2)].raw : 0,
    },
    hotSpots: topData.slice(0, 5).map(d => ({
      id: d.id,
      value: d.raw,
      reason: metric === 'change-count' ? `${d.raw} changes`
            : metric === 'churn-lines' ? `${d.raw} lines churned`
            : `${(d.raw * 100).toFixed(1)}% bug fix rate`,
    })),
  };
}

export async function getAnalysisAt(
  projectPath: string,
  timestamp: string
): Promise<CASOutput | null> {
  return getStorageAnalysisAt(projectPath, timestamp);
}

export async function getAnalysisSnapshots(
  projectPath: string
): Promise<Array<{ id: string; timestamp: string }>> {
  return listAnalysisSnapshots(projectPath);
}

export function getComponentParents(
  cas: CASOutput,
  nodeId: string,
  limit: number = 50
): {
  total: number;
  limit: number;
  truncated: boolean;
  parents: Array<{
    node_id: string;
    name: string;
    type: string;
    file: string;
    props_passed: string[];
    jsx_line?: number;
  }>;
} {
  const parents: Array<{
    node_id: string;
    name: string;
    type: string;
    file: string;
    props_passed: string[];
    jsx_line?: number;
  }> = [];

  for (const edge of cas.edges) {
    if (edge.target === nodeId && edge.type === 'renders') {
      const parentNode = cas.nodes.find(n => n.id === edge.source);
      if (parentNode && (parentNode.type === 'functional_component' || parentNode.type === 'class_component')) {
        parents.push({
          node_id: parentNode.id,
          name: parentNode.name,
          type: parentNode.type,
          file: parentNode.source?.file || 'unknown',
          props_passed: (edge.metadata as any)?.props_passed || [],
          jsx_line: (edge.metadata as any)?.jsx_line,
        });
      }
    }
  }

  const total = parents.length;
  const truncated = total > limit;

  return {
    total,
    limit,
    truncated,
    parents: parents.slice(0, limit),
  };
}

export function getComponentChildren(
  cas: CASOutput,
  nodeId: string,
  limit: number = 50
): {
  total: number;
  limit: number;
  truncated: boolean;
  children: Array<{
    node_id: string;
    name: string;
    type: string;
    file: string;
    props_passed: string[];
    jsx_line?: number;
  }>;
} {
  const children: Array<{
    node_id: string;
    name: string;
    type: string;
    file: string;
    props_passed: string[];
    jsx_line?: number;
  }> = [];

  for (const edge of cas.edges) {
    if (edge.source === nodeId && edge.type === 'renders') {
      const childNode = cas.nodes.find(n => n.id === edge.target);
      if (childNode && (childNode.type === 'functional_component' || childNode.type === 'class_component')) {
        children.push({
          node_id: childNode.id,
          name: childNode.name,
          type: childNode.type,
          file: childNode.source?.file || 'unknown',
          props_passed: (edge.metadata as any)?.props_passed || [],
          jsx_line: (edge.metadata as any)?.jsx_line,
        });
      }
    }
  }

  const total = children.length;
  const truncated = total > limit;

  return {
    total,
    limit,
    truncated,
    children: children.slice(0, limit),
  };
}

export function getComponentMetrics(
  cas: CASOutput,
  nodeId: string
): {
  node_id: string;
  name: string;
  type: string;
  file: string;
  metrics: {
    usage_count: number;
    usage_locations: string[];
    rendered_components_count: number;
    is_leaf: boolean;
    is_shared: boolean;
    is_highly_shared: boolean;
    props: Array<{ name: string; type: string; required: boolean }>;
    state_count: number;
    hooks_count: number;
  };
  parents: Array<{ node_id: string; name: string }>;
  children: Array<{ node_id: string; name: string }>;
} | null {
  const node = cas.nodes.find(n => n.id === nodeId);
  if (!node || (node.type !== 'functional_component' && node.type !== 'class_component')) {
    return null;
  }

  const attributes = (node.metadata as any)?.attributes || {};

  const parentsResult = getComponentParents(cas, nodeId, 100);
  const childrenResult = getComponentChildren(cas, nodeId, 100);

  return {
    node_id: node.id,
    name: node.name,
    type: node.type,
    file: node.source?.file || 'unknown',
    metrics: {
      usage_count: attributes.usage_count || parentsResult.total,
      usage_locations: attributes.usage_locations || parentsResult.parents.map(p => p.name),
      rendered_components_count: attributes.rendered_components_count || childrenResult.total,
      is_leaf: attributes.is_leaf ?? (childrenResult.total === 0),
      is_shared: attributes.is_shared ?? (parentsResult.total >= 2),
      is_highly_shared: attributes.is_highly_shared ?? (parentsResult.total >= 5),
      props: attributes.props || [],
      state_count: attributes.state_count || 0,
      hooks_count: attributes.hooks_count || 0,
    },
    parents: parentsResult.parents.map(p => ({ node_id: p.node_id, name: p.name })),
    children: childrenResult.children.map(c => ({ node_id: c.node_id, name: c.name })),
  };
}

export function getSharedComponents(
  cas: CASOutput,
  opts: { min_usage?: number; limit?: number } = {}
): Array<{
  node_id: string;
  name: string;
  file: string;
  usage_count: number;
  usage_locations: string[];
}> {
  const minUsage = opts.min_usage || 2;
  const limit = opts.limit || 50;

  const components: Array<{
    node_id: string;
    name: string;
    file: string;
    usage_count: number;
    usage_locations: string[];
  }> = [];

  for (const node of cas.nodes) {
    if (node.type !== 'functional_component' && node.type !== 'class_component') {
      continue;
    }

    const attributes = (node.metadata as any)?.attributes || {};
    const usageCount = attributes.usage_count || 0;

    if (usageCount >= minUsage) {
      components.push({
        node_id: node.id,
        name: node.name,
        file: node.source?.file || 'unknown',
        usage_count: usageCount,
        usage_locations: attributes.usage_locations || [],
      });
    }
  }

  components.sort((a, b) => b.usage_count - a.usage_count);

  return components.slice(0, limit);
}
