import {
  CASOutput,
  CASEdge,
  CASProductMap,
  CASProductMapCapability,
  CASProductMapDeployableTopology,
  CASProductMapJourney,
  CASProductMapRuntimeTopology,
  CASUserJourney,
  SystemCapability,
} from '../../types/cas.types';
import { exposureScore } from './data-lineage';

const CRITICALITY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const RISK_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const TOP_JOURNEY_LIMIT = 10;
const EXPOSURE_HIGHLIGHT_LIMIT = 3;
const TOP_RISK_LIMIT = 5;

function criticalityRank(value: string | undefined): number {
  return value !== undefined && value in CRITICALITY_RANK ? CRITICALITY_RANK[value] : 4;
}

function normalizeEntityName(name: string): string {
  return name.toLowerCase().replace(/^entity_/, '').replace(/[^a-z0-9]/g, '');
}

function journeyTerminalNames(journey: CASUserJourney): Set<string> {
  const names = new Set<string>();
  for (const terminal of journey.terminal_entities || []) {
    names.add(normalizeEntityName(terminal.name));
  }
  for (const written of journey.terminal_effects?.entities_written || []) {
    names.add(normalizeEntityName(written));
  }
  for (const read of journey.terminal_effects?.entities_read || []) {
    names.add(normalizeEntityName(read));
  }
  return names;
}

function linkJourneysToCapability(
  capability: SystemCapability,
  capabilityEntityNames: string[],
  journeys: CASUserJourney[],
  terminalNamesByJourney: Map<string, Set<string>>
): CASUserJourney[] {
  const entryPointIds = new Set(capability.operations.map(operation => operation.entry_point_id));
  const capabilityEntities = new Set(capabilityEntityNames.map(normalizeEntityName));

  return journeys.filter(journey => {
    if (entryPointIds.has(journey.entry_point_id)) return true;
    if (capabilityEntities.size === 0) return false;
    const terminalNames = terminalNamesByJourney.get(journey.id);
    if (!terminalNames) return false;
    for (const name of terminalNames) {
      if (capabilityEntities.has(name)) return true;
    }
    return false;
  });
}

function capabilityRiskLevel(
  capability: SystemCapability,
  linkedJourneys: CASUserJourney[],
  testsPresent: boolean
): 'low' | 'medium' | 'high' {
  const highCriticality = capability.criticality === 'critical' || capability.criticality === 'high';
  const riskyJourney = linkedJourneys.some(journey => journey.risk === 'high' || journey.risk === 'critical');
  if (riskyJourney) return 'high';
  if (highCriticality && !testsPresent) return 'high';
  if (testsPresent) return 'low';
  return 'medium';
}

function buildCapabilities(cas: CASOutput): CASProductMapCapability[] {
  const journeys = cas.user_journeys || [];
  const terminalNamesByJourney = new Map(journeys.map(journey => [journey.id, journeyTerminalNames(journey)]));
  const entityNameById = new Map((cas.data_entities || []).map(entity => [entity.id, entity.name]));
  const capabilityOrder = new Map((cas.system_capabilities || []).map((capability, index) => [capability.name, index]));

  const capabilities = (cas.system_capabilities || []).map(capability => {
    const entityNames = (capability.related_entities || []).map(reference => entityNameById.get(reference) || reference);
    const linked = linkJourneysToCapability(capability, entityNames, journeys, terminalNamesByJourney);
    const linkedSorted = [...linked].sort(
      (a, b) => criticalityRank(a.criticality) - criticalityRank(b.criticality) || a.name.localeCompare(b.name)
    );
    const testsPresent = linked.some(journey => (journey.tests_covering || []).length > 0);
    return {
      name: capability.name,
      description: capability.description,
      description_source: capability.description_source || 'deterministic',
      category: capability.category,
      criticality: capability.criticality,
      journeys: linkedSorted.map(journey => ({ id: journey.id, name: journey.name })),
      entities: [...new Set(entityNames)].sort((a, b) => a.localeCompare(b)),
      tests_present: testsPresent,
      risk_level: capabilityRiskLevel(capability, linked, testsPresent),
    } satisfies CASProductMapCapability;
  });

  return capabilities.sort(
    (a, b) =>
      (capabilityOrder.get(a.name) ?? Number.MAX_SAFE_INTEGER) -
        (capabilityOrder.get(b.name) ?? Number.MAX_SAFE_INTEGER) ||
      criticalityRank(a.criticality) - criticalityRank(b.criticality) ||
      a.name.localeCompare(b.name)
  );
}

function buildJourneys(cas: CASOutput): CASProductMap['journeys'] {
  const journeys = cas.user_journeys || [];
  const summary = cas.user_journey_summary;

  const top: CASProductMapJourney[] = [...journeys]
    .sort(
      (a, b) =>
        criticalityRank(a.criticality) - criticalityRank(b.criticality) ||
        (a.risk && b.risk ? RISK_RANK[a.risk] - RISK_RANK[b.risk] : 0) ||
        a.name.localeCompare(b.name)
    )
    .slice(0, TOP_JOURNEY_LIMIT)
    .map(journey => ({
      id: journey.id,
      name: journey.name,
      kind: journey.journey_kind,
      criticality: journey.criticality,
      boundaries: [...new Set((journey.security_boundaries || []).map(boundary => boundary.name))],
      tests: (journey.tests_covering || []).length,
    }));

  const countByKind = (kind: CASUserJourney['journey_kind']) =>
    journeys.filter(journey => journey.journey_kind === kind).length;

  return {
    total: summary?.total_discovered ?? journeys.length,
    user_facing: summary?.by_kind['user-facing'] ?? countByKind('user-facing'),
    system: summary?.by_kind.system ?? countByKind('system'),
    scheduled: summary?.by_kind.scheduled ?? countByKind('scheduled'),
    top,
  };
}

function buildData(cas: CASOutput): CASProductMap['data'] {
  const lineage = cas.data_lineage || [];

  const sensitive = lineage
    .filter(item => item.exposure.sensitive)
    .map(item => item.entity_name)
    .sort((a, b) => a.localeCompare(b));

  const highlights = [...lineage]
    .filter(item => exposureScore(item) > 0)
    .sort((a, b) => exposureScore(b) - exposureScore(a) || a.entity_name.localeCompare(b.entity_name))
    .slice(0, EXPOSURE_HIGHLIGHT_LIMIT)
    .map(item => ({
      entity: item.entity_name,
      sensitive_fields: item.sensitive_fields,
      unguarded_paths: item.exposure.unguarded_paths,
      ...(item.exposure.non_auth_guarded_paths ? { non_auth_guarded_paths: item.exposure.non_auth_guarded_paths } : {}),
      external_transfer: item.exposure.external_transfer,
      external_recipients: [...new Set(item.external_recipients.map(recipient => recipient.service))].sort((a, b) =>
        a.localeCompare(b)
      ),
    }));

  return {
    entities: lineage.length > 0 ? lineage.length : (cas.data_entities || []).length,
    sensitive,
    exposure_highlights: highlights,
  };
}

function buildConventions(cas: CASOutput): CASProductMap['conventions'] {
  const paradigms = cas.paradigm_conformance || [];
  const openDeviations = { error: 0, warning: 0, info: 0 };
  for (const paradigm of paradigms) {
    for (const deviation of paradigm.deviations) {
      openDeviations[deviation.severity] += 1;
    }
  }
  return {
    paradigms: [...paradigms]
      .sort((a, b) => b.adoption.adoption_rate - a.adoption.adoption_rate || a.paradigm.localeCompare(b.paradigm))
      .map(paradigm => ({
        paradigm: paradigm.paradigm,
        description: paradigm.description,
        adoption_rate: paradigm.adoption.adoption_rate,
        following_count: paradigm.adoption.following_count,
        comparable_count: paradigm.adoption.comparable_count,
      })),
    open_deviations: openDeviations,
  };
}

function buildHealth(cas: CASOutput): CASProductMap['health'] {
  const testSummary = cas.test_summary;
  const implementation = cas.implementation_health;
  const riskLevelRank: Record<string, number> = { high: 0, medium: 1, low: 2 };

  const seenRisks = new Set<string>();
  const topRisks = [...(implementation?.risk_areas || [])]
    .sort(
      (a, b) =>
        riskLevelRank[a.risk_level] - riskLevelRank[b.risk_level] || a.node_name.localeCompare(b.node_name)
    )
    .filter(risk => {
      const key = `${risk.node_name}|${risk.risk_type}`;
      if (seenRisks.has(key)) return false;
      seenRisks.add(key);
      return true;
    })
    .slice(0, TOP_RISK_LIMIT)
    .map(risk => ({
      name: risk.node_name,
      level: risk.risk_level,
      type: risk.risk_type,
      recommendation: risk.recommendation,
    }));

  return {
    status: cas.system_health?.status,
    score: cas.system_health?.score,
    tests: {
      total: testSummary?.total_tests ?? 0,
      passing: testSummary?.by_status.passing ?? 0,
      failing: testSummary?.by_status.failing ?? 0,
      coverage_percentage: testSummary?.coverage.overall_percentage,
    },
    implementation: {
      complete: implementation?.complete_implementations ?? 0,
      partial: implementation?.partial_implementations ?? 0,
      stubs: implementation?.stubs ?? 0,
      not_implemented: implementation?.not_implemented ?? 0,
      deprecated: implementation?.deprecated ?? 0,
      health_score: implementation?.health_score,
    },
    top_risks: topRisks,
  };
}

function buildCoverageCaveats(
  cas: CASOutput,
  unanalyzedLanguages: Array<{ name: string; files: number; share_of_source: number }>
): string[] {
  const caveats: string[] = [];

  for (const language of unanalyzedLanguages) {
    caveats.push(`${language.name} not analyzed: ${language.files} files (${language.share_of_source}% of source)`);
  }

  for (const repository of cas.system?.technologies?.nested_repositories || []) {
    const language = repository.primary_language ? `, primary language ${repository.primary_language}` : '';
    caveats.push(
      `Nested git repository ${repository.path}/ excluded from this analysis (${repository.source_files} source files${language}); analyze it separately and correlate through cross-repository links`
    );
  }

  const journeySummary = cas.user_journey_summary;
  if (journeySummary && journeySummary.total_discovered > journeySummary.included) {
    caveats.push(
      `${journeySummary.total_discovered} journeys discovered, ${journeySummary.included} included in detail`
    );
  }

  const errorCount = (cas.analysis_errors || []).length;
  if (errorCount > 0) {
    caveats.push(`${errorCount} analysis error${errorCount === 1 ? '' : 's'} recorded during analysis`);
  }

  const totalTests = cas.test_summary?.total_tests ?? 0;
  const journeysWithTests = (cas.user_journeys || []).filter(journey => (journey.tests_covering || []).length > 0).length;
  if (totalTests === 0 && journeysWithTests === 0) {
    caveats.push('No tests detected; test coverage signals are unavailable');
  } else if (totalTests === 0 && journeysWithTests > 0) {
    caveats.push('Test inventory not built for this stack; only journey-level test links are available');
  }

  if ((cas.data_lineage || []).length === 0) {
    caveats.push('No data lineage derived; data exposure signals are unavailable');
  }

  return caveats;
}

/** The infra->code topology edge types emitted by infra-topology-linker.ts. */
const RUNTIME_TOPOLOGY_EDGE_TYPES = new Set([
  'DEPLOYS',
  'EXPOSES',
  'ROUTES_TO',
  'PROVISIONS_CHANNEL',
  'PROVISIONS_DATABASE',
  'PROVISIONS_STORAGE',
  'RUNTIME_DEPENDS_ON',
]);

function edgeAttr(edge: CASEdge, key: string): string | undefined {
  const value = edge.metadata?.attributes?.[key];
  return value === undefined || value === null ? undefined : String(value);
}

/**
 * Derive a first-class runtime-topology view from the additive infra->code
 * edges (DEPLOYS, EXPOSES, ROUTES_TO, PROVISIONS_CHANNEL/DATABASE/STORAGE,
 * RUNTIME_DEPENDS_ON) that infra-topology-linker.ts appends to cas.edges.
 * Purely additive and evidence-based: reads only real edges, groups them per
 * deployable, and returns undefined when the analysis carries no infra topology
 * (so non-infra repos are unchanged).
 *
 * The linker anchors DEPLOYS/EXPOSES on the infra resource node (source) ->
 * deployable, tagging each with a `deployable` attribute; ROUTES_TO and the
 * PROVISIONS edges also hang off that same resource node, so we attribute those
 * to the deployable(s) the resource fronts. RUNTIME_DEPENDS_ON carries
 * `from`/`to` deployable names directly.
 */
function buildRuntimeTopology(cas: CASOutput): CASProductMapRuntimeTopology | undefined {
  const topologyEdges = (cas.edges || []).filter(edge => RUNTIME_TOPOLOGY_EDGE_TYPES.has(edge.type));
  if (topologyEdges.length === 0) return undefined;

  // Map each infra resource node id -> the deployable name(s) it deploys/exposes,
  // so a ROUTES_TO / PROVISIONS_* edge from the same resource can be attributed
  // to the right deployable.
  const resourceDeployables = new Map<string, Set<string>>();
  for (const edge of topologyEdges) {
    if (edge.type !== 'DEPLOYS' && edge.type !== 'EXPOSES') continue;
    const deployable = edgeAttr(edge, 'deployable');
    if (!deployable) continue;
    if (!resourceDeployables.has(edge.source)) resourceDeployables.set(edge.source, new Set());
    resourceDeployables.get(edge.source)!.add(deployable);
  }

  interface Buckets {
    deploys: Set<string>;
    exposes: Set<string>;
    routes: Set<string>;
    channels: Set<string>;
    databases: Set<string>;
    storage: Set<string>;
    depends_on: Set<string>;
  }
  const byDeployable = new Map<string, Buckets>();
  const bucketsFor = (name: string): Buckets => {
    let buckets = byDeployable.get(name);
    if (!buckets) {
      buckets = {
        deploys: new Set(),
        exposes: new Set(),
        routes: new Set(),
        channels: new Set(),
        databases: new Set(),
        storage: new Set(),
        depends_on: new Set(),
      };
      byDeployable.set(name, buckets);
    }
    return buckets;
  };

  const nodeName = new Map((cas.nodes || []).map(node => [node.id, node.name]));

  for (const edge of topologyEdges) {
    switch (edge.type) {
      case 'DEPLOYS': {
        const deployable = edgeAttr(edge, 'deployable');
        if (!deployable) break;
        bucketsFor(deployable).deploys.add(nodeName.get(edge.source) || edge.source);
        break;
      }
      case 'EXPOSES': {
        const deployable = edgeAttr(edge, 'deployable');
        if (!deployable) break;
        const joinKey = edgeAttr(edge, 'join_key');
        // The join key is the port (`port:8080`) or a service name — the concrete
        // evidence of what fronts the deployable.
        bucketsFor(deployable).exposes.add(joinKey || nodeName.get(edge.source) || edge.source);
        break;
      }
      case 'ROUTES_TO': {
        const route = edgeAttr(edge, 'route');
        if (!route) break;
        for (const deployable of resourceDeployables.get(edge.source) || []) {
          bucketsFor(deployable).routes.add(route);
        }
        break;
      }
      case 'PROVISIONS_CHANNEL':
      case 'PROVISIONS_DATABASE':
      case 'PROVISIONS_STORAGE': {
        const bucketKey =
          edge.type === 'PROVISIONS_CHANNEL' ? 'channels' : edge.type === 'PROVISIONS_DATABASE' ? 'databases' : 'storage';
        const label =
          edgeAttr(edge, 'channel') ||
          edgeAttr(edge, 'database') ||
          edgeAttr(edge, 'data_entity') ||
          edgeAttr(edge, 'service') ||
          edgeAttr(edge, 'store') ||
          nodeName.get(edge.target) ||
          nodeName.get(edge.source) ||
          edge.target;
        const owners = resourceDeployables.get(edge.source);
        if (owners && owners.size > 0) {
          for (const deployable of owners) (bucketsFor(deployable)[bucketKey] as Set<string>).add(label);
        }
        break;
      }
      case 'RUNTIME_DEPENDS_ON': {
        const from = edgeAttr(edge, 'from');
        const to = edgeAttr(edge, 'to');
        if (from && to) bucketsFor(from).depends_on.add(to);
        break;
      }
    }
  }

  const deployables: CASProductMapDeployableTopology[] = [...byDeployable.entries()]
    .map(([name, buckets]) => ({
      name,
      deploys: [...buckets.deploys].sort((a, b) => a.localeCompare(b)),
      exposes: [...buckets.exposes].sort((a, b) => a.localeCompare(b)),
      routes: [...buckets.routes].sort((a, b) => a.localeCompare(b)),
      channels: [...buckets.channels].sort((a, b) => a.localeCompare(b)),
      databases: [...buckets.databases].sort((a, b) => a.localeCompare(b)),
      storage: [...buckets.storage].sort((a, b) => a.localeCompare(b)),
      depends_on: [...buckets.depends_on].sort((a, b) => a.localeCompare(b)),
    }))
    .filter(
      // A deployable with every bucket empty carries no runtime-topology signal;
      // don't list it. (Can happen if an edge lacked a `deployable` attribute.)
      entry =>
        entry.deploys.length +
          entry.exposes.length +
          entry.routes.length +
          entry.channels.length +
          entry.databases.length +
          entry.storage.length +
          entry.depends_on.length >
        0,
    )
    .sort((a, b) => a.name.localeCompare(b.name));

  if (deployables.length === 0) return undefined;

  return { edge_count: topologyEdges.length, deployables };
}

export function buildProductMap(cas: CASOutput): CASProductMap {
  const purpose = cas.enhanced_system_purpose;
  const unanalyzedLanguages = [...(cas.system?.technologies?.unanalyzed_languages || [])].sort(
    (a, b) => b.share_of_source - a.share_of_source || a.name.localeCompare(b.name)
  );
  const nestedRepositories = [...(cas.system?.technologies?.nested_repositories || [])].sort(
    (a, b) => a.path.localeCompare(b.path)
  );
  const runtimeTopology = buildRuntimeTopology(cas);

  return {
    identity: {
      name: cas.system?.name || 'unknown',
      domain: purpose?.primary_domain || 'unknown',
      domain_source: purpose?.domain_source || 'deterministic',
      description: purpose?.inferred_description || cas.system?.description || '',
      description_source: purpose?.description_source || (cas.system?.description ? 'manual' : 'deterministic'),
      unanalyzed_languages: unanalyzedLanguages,
      ...(nestedRepositories.length > 0 ? { nested_repositories: nestedRepositories } : {}),
    },
    capabilities: buildCapabilities(cas),
    journeys: buildJourneys(cas),
    data: buildData(cas),
    conventions: buildConventions(cas),
    health: buildHealth(cas),
    ...(runtimeTopology ? { runtime_topology: runtimeTopology } : {}),
    coverage_caveats: buildCoverageCaveats(cas, unanalyzedLanguages),
  };
}
