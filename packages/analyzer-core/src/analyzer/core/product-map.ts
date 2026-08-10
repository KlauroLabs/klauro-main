import {
  CASOutput,
  CASEdge,
  CASProductMap,
  CASProductMapCapability,
  CASProductMapCommunicationGraph,
  CASProductMapDeployableTopology,
  CASProductMapJourney,
  CASProductMapRuntimeTopology,
  CASUserJourney,
  SystemCapability,
} from '../../types/cas.types';
import { exposureScore } from './data-lineage';

// #129 — humanizeDomainSlug (mechanical kebab-case->Title Case rendering of
// `primary_domain`) was removed. `primary_domain` is a composed/heuristic
// slug ("feed-integration-category", not a phrase a person wrote), so
// title-casing its tokens produced strings like "Feed Integration Category"
// that read as a human-authored label but are actually just capitalized
// internal tokens — a faked label, not a derived one. See identity.domain /
// identity.domain_label's doc comments in cas.types.ts and this function's
// two former call sites (here and query.ts's primary_domain_label) for the
// full reasoning. The slug itself (`domain`) is unaffected: orchestrator.ts
// still compares primary_domain strings token-by-token across analysis runs
// (reuse detection, truncation/plumbing gates), so it keeps shipping exactly
// as before — only the fabricated-looking humanized rendering is gone.

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

/**
 * INVARIANT (2026-08-10 live comprehension audit): `description_source` and
 * the PRESENCE of `description` text must never disagree — a source can only
 * ever describe text that actually exists. This used to unconditionally
 * default a falsy `capability.description_source` to `'deterministic'`
 * (`capability.description_source || 'deterministic'`), regardless of
 * whether `capability.description` held any text. A capability whose AI
 * description attempt was rejected AND had no deterministic fallback text —
 * `description_source` left `undefined` and `description` empty/absent by
 * design, both honestly recording "not described" (see
 * `capability_description_degradations` on `EnhancedSystemPurpose`) — got
 * stamped `description_source: 'deterministic'` here anyway, the moment it
 * reached this view. Confirmed live: a Django "Process Forms" capability and
 * a Go "Integrate with External Services" capability both shipped
 * `description_source: 'deterministic'` with the `description` key absent
 * entirely. Two upstream fixes (orchestrator.ts's per-capability repair
 * loop) already closed every path that could leave `system_capabilities`
 * itself in that state — this was a THIRD, independent site: a view built
 * straight off the CAS that re-derives provenance with its own (buggy)
 * default, never routing through `capabilityDescriptionTarget`/
 * `validateElementDescription`. The fix is the invariant, not just this one
 * call site: only ever infer 'deterministic' provenance when there is real
 * text to attribute it to; otherwise pass the source through as-is (honest
 * "no provenance because no text", matching identity.description_source's
 * documented contract just above it in cas.types.ts).
 *
 * HARDENED (same audit, second pass): the first version above only stopped
 * this view from ADDING a new instance of the mismatch — `if
 * (!capability.description) return capability.description_source;` still
 * forwarded an ALREADY-mismatched capability (description_source set with no
 * text) unchanged, e.g. a stored analysis computed before this invariant
 * existed, or a future write site upstream that reintroduces the bug the
 * repair loop and orchestrator.ts's `enforceCapabilityDescriptionProvenance
 * Invariant` choke point were meant to prevent. This view is the last stop
 * before a customer sees the capability, so it must not merely decline to
 * make things worse — it must actively enforce the invariant on whatever it
 * is handed, same as the orchestrator-side choke point.
 */
function resolveCapabilityDescriptionProvenance(
  capability: Pick<SystemCapability, 'description' | 'description_source'>,
): SystemCapability['description_source'] | undefined {
  if (!capability.description) return undefined;
  return capability.description_source || 'deterministic';
}

/**
 * The journey's PRIMARY entities — what it terminally PRODUCES: terminal
 * entities it created/updated/deleted plus terminal_effects.entities_written.
 * A read-only journey writes nothing, so its terminal READS are its actual
 * subject and serve as the fallback. Non-write reads on a journey that DOES
 * write never count: "reads a shared entity somewhere along the chain" is
 * exactly the non-discriminating overlap that pastes every journey onto every
 * capability touching that entity. A journey attaches to the few capabilities
 * anchored on what it produces, not to everything it brushes against.
 */
function journeyPrimaryEntityNames(journey: CASUserJourney): Set<string> {
  const written = new Set<string>();
  for (const terminal of journey.terminal_entities || []) {
    if (terminal.access !== 'read') written.add(normalizeEntityName(terminal.name));
  }
  for (const name of journey.terminal_effects?.entities_written || []) {
    written.add(normalizeEntityName(name));
  }
  if (written.size > 0) return written;

  const read = new Set<string>();
  for (const terminal of journey.terminal_entities || []) {
    read.add(normalizeEntityName(terminal.name));
  }
  for (const name of journey.terminal_effects?.entities_read || []) {
    read.add(normalizeEntityName(name));
  }
  return read;
}

/**
 * ALL entities a journey's call path touches — read OR write — unlike
 * journeyPrimaryEntityNames' narrower "what it terminally PRODUCES" set.
 * journeyPrimaryEntityNames exists to keep journey<->capability DISPLAY
 * attribution (the `journeys` list a capability ships, and risk_level)
 * precise: pasting a journey onto every capability it merely brushes against
 * would make that list noise. tests_present is a different, coarser question
 * — "is ANY of this capability's surface exercised by a test at all" — where
 * a journey that only READS one of the capability's entities (e.g. "list API
 * keys" exercising the APIKey capability's read path without ever writing
 * one) is still real, honest evidence of coverage. Restricting tests_present
 * to the same primary-produced-only set as display attribution silently
 * dropped that evidence and was one source of capabilities reporting
 * tests_present:false while their own entity's journeys carried real
 * tests_covering counts in the same response.
 */
function journeyTouchedEntityNames(journey: CASUserJourney): Set<string> {
  const touched = new Set<string>();
  for (const terminal of journey.terminal_entities || []) touched.add(normalizeEntityName(terminal.name));
  for (const name of journey.terminal_effects?.entities_written || []) touched.add(normalizeEntityName(name));
  for (const name of journey.terminal_effects?.entities_read || []) touched.add(normalizeEntityName(name));
  return touched;
}

/**
 * Whether ANY journey carries real test evidence for this capability, using a
 * DELIBERATELY wider net than `linked` (see journeyTouchedEntityNames):
 * structural entry-point family (same as linkJourneysToCapability's strongest
 * branch) OR any-entity-touched overlap, not just primary-produced. `linked`
 * stays the strict, precise list used for display/risk; this is the coarser
 * boolean the cross-surface invariant (capabilities/journeys/health.tests
 * must never contradict each other) depends on.
 */
function capabilityHasTestEvidence(
  capability: SystemCapability,
  journeys: CASUserJourney[],
  capabilityEntities: Set<string>
): boolean {
  const entryPointIds = new Set(capability.operations.map(operation => operation.entry_point_id));
  return journeys.some(journey => {
    if ((journey.tests_covering || []).length === 0) return false;
    if (entryPointIds.has(journey.entry_point_id)) return true;
    if (capabilityEntities.size === 0) return false;
    for (const name of journeyTouchedEntityNames(journey)) {
      if (capabilityEntities.has(name)) return true;
    }
    return false;
  });
}

function linkJourneysToCapability(
  capability: SystemCapability,
  capabilityEntityNames: string[],
  journeys: CASUserJourney[],
  primaryNamesByJourney: Map<string, Set<string>>
): CASUserJourney[] {
  const entryPointIds = new Set(capability.operations.map(operation => operation.entry_point_id));
  const capabilityEntities = new Set(capabilityEntityNames.map(normalizeEntityName));

  return journeys.filter(journey => {
    // PRIMARY: the journey is a flow-derived view (journey-builder.ts) and
    // inherited that flow's own capability_relationships directly — the
    // same evidence-gated M:N edge flows_to_capabilities measures (0.8384
    // live on a real repo). This is the strongest link: it is the actual
    // relationship the flow layer already proved, not a re-derived guess.
    if (journey.capability_relationships?.some(rel => rel.capability_id === capability.id)) return true;
    // Entry-point family: the capability's own operations reference this
    // journey's entry point — the strongest, structural attachment.
    if (entryPointIds.has(journey.entry_point_id)) return true;
    if (capabilityEntities.size === 0) return false;
    // Otherwise the journey's PRIMARY (terminal produced) entity must be one
    // of the capability's anchor entities — never any-shared-entity overlap.
    const primaryNames = primaryNamesByJourney.get(journey.id);
    if (!primaryNames) return false;
    for (const name of primaryNames) {
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
  const primaryNamesByJourney = new Map(journeys.map(journey => [journey.id, journeyPrimaryEntityNames(journey)]));
  const entityNameById = new Map((cas.data_entities || []).map(entity => [entity.id, entity.name]));
  const capabilityOrder = new Map((cas.system_capabilities || []).map((capability, index) => [capability.name, index]));

  const capabilities = (cas.system_capabilities || []).map(capability => {
    const entityNames = (capability.related_entities || []).map(reference => entityNameById.get(reference) || reference);
    const linked = linkJourneysToCapability(capability, entityNames, journeys, primaryNamesByJourney);
    const linkedSorted = [...linked].sort(
      (a, b) => criticalityRank(a.criticality) - criticalityRank(b.criticality) || a.name.localeCompare(b.name)
    );
    const capabilityEntities = new Set(entityNames.map(normalizeEntityName));
    const testsPresent = linked.some(journey => (journey.tests_covering || []).length > 0)
      || capabilityHasTestEvidence(capability, journeys, capabilityEntities);
    return {
      name: capability.name,
      description: capability.description,
      description_source: resolveCapabilityDescriptionProvenance(capability),
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

  // The description-vs-capability cross-check (orchestrator.ts's
  // description_capability_gaps, EnhancedSystemPurpose) exists specifically
  // so the product can admit when its own AI description names an entity
  // no shipped capability is anchored on — a real, evidence-derived honesty
  // signal that, before this, no consumer-facing tool surfaced anywhere
  // (get_summary / get_conceptual_analysis / get_product_map /
  // run_answer_pack / get_agent_context all omitted it): the field existed
  // but nothing a reader would call ever showed it, so it did no work.
  // Reported here alongside every other "here is what this analysis could
  // not fully resolve" caveat, distinguishing the two dispositions plainly
  // rather than collapsing them into one vague warning.
  const capabilityGaps = cas.enhanced_system_purpose?.description_capability_gaps || [];
  const reinjected = capabilityGaps.filter(gap => gap.disposition === 'reinjected-from-candidate');
  const unanchored = capabilityGaps.filter(gap => gap.disposition === 'no-structural-candidate');
  if (unanchored.length > 0) {
    caveats.push(
      `Description names ${unanchored.length} ${unanchored.length === 1 ? 'entity' : 'entities'} `
      + `with no capability built for ${unanchored.length === 1 ? 'it' : 'them'} in this catalog `
      + `(${unanchored.slice(0, 5).map(gap => gap.entity_name).join(', ')}${unanchored.length > 5 ? ', ...' : ''}); `
      + 'the description may be overreaching relative to the shipped capability list.'
    );
  }
  if (reinjected.length > 0) {
    caveats.push(
      `${reinjected.length} ${reinjected.length === 1 ? 'capability was' : 'capabilities were'} restored into this `
      + `catalog after the description referenced ${reinjected.length === 1 ? 'an entity' : 'entities'} `
      + `(${reinjected.slice(0, 5).map(gap => gap.entity_name).join(', ')}${reinjected.length > 5 ? ', ...' : ''}) `
      + `a pre-AI candidate already supported but reconciliation had dropped.`
    );
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
 * Project the deployable-to-deployable communication graph out of the
 * communication-seams pass. This is a pure re-read of already-computed Camp-B
 * structural facts (docs/cas/DETERMINISM-BOUNDARY.md): the seams pass already
 * classified every exit-point / messaging / passive-state fact into sync/async/
 * passive seams and rolled them up to a deployable-level inventory. We surface
 * that inventory as the topology's edge graph — the infra RUNTIME_DEPENDS_ON
 * links alone are sparse (often one or zero edges), while this carries HOW
 * components talk (modality) and how much (per-modality counts). Returns
 * undefined when no deployable-level seam inventory exists (nothing to add).
 */
function buildCommunicationGraph(cas: CASOutput): CASProductMapCommunicationGraph | undefined {
  const inventory = cas.communication_seams?.deployable_inventory;
  if (!inventory || inventory.counts.total === 0) return undefined;

  const edges = [...inventory.component_seams]
    .map(edge => ({
      source: edge.source,
      target: edge.target,
      // Deterministic modality order (sync, async, passive) rather than the
      // inventory's insertion order, so the same facts serialize identically.
      modalities: (['sync', 'async', 'passive'] as const).filter(m => edge.modalities.includes(m)),
      sync: edge.sync,
      async: edge.async,
      passive: edge.passive,
      total: edge.total,
    }))
    // Busiest seams first; ties broken lexicographically for a stable order.
    .sort(
      (a, b) =>
        b.total - a.total ||
        a.source.localeCompare(b.source) ||
        a.target.localeCompare(b.target),
    );

  return {
    counts: {
      sync: inventory.counts.sync,
      async: inventory.counts.async,
      passive: inventory.counts.passive,
      total: inventory.counts.total,
    },
    edges,
  };
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

  const communication = buildCommunicationGraph(cas);

  // Enrich each deployable's depends_on with its outbound communication seams to
  // OTHER named deployables — the sparse RUNTIME_DEPENDS_ON links miss most real
  // runtime coupling. We only fold in edges whose target is itself a deployable
  // in this topology (external targets like `external_api` stay in the top-level
  // `communication` graph, not in depends_on, which means "peer deployables").
  if (communication) {
    const topologyNames = new Set(deployables.map(d => d.name));
    const dependsOn = new Map<string, Set<string>>();
    for (const edge of communication.edges) {
      if (edge.source === edge.target) continue;
      if (!topologyNames.has(edge.source) || !topologyNames.has(edge.target)) continue;
      if (!dependsOn.has(edge.source)) dependsOn.set(edge.source, new Set());
      dependsOn.get(edge.source)!.add(edge.target);
    }
    for (const deployable of deployables) {
      const peers = dependsOn.get(deployable.name);
      if (!peers) continue;
      const merged = new Set([...deployable.depends_on, ...peers]);
      deployable.depends_on = [...merged].sort((a, b) => a.localeCompare(b));
    }
  }

  return {
    edge_count: topologyEdges.length,
    deployables,
    ...(communication ? { communication } : {}),
  };
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
      // #129 — no `domain_label` here (see CASProductMap.identity.domain_label's
      // doc comment for why: `domain` is a composed slug, not a phrase, so
      // mechanically title-casing it does not produce something a
      // non-technical reader would actually write).
      // Comprehension is AI-only (docs/cas/DETERMINISM-BOUNDARY.md): 'deterministic'
      // is NOT a valid comprehension provenance. When AI hasn't run (or failed),
      // the domain/description provenance is left UNSET rather than stamped
      // 'deterministic' on empty output — never claim a deterministic authorship
      // for a comprehension field.
      domain_source: purpose?.domain_source,
      description: purpose?.inferred_description || cas.system?.description || '',
      description_source: purpose?.description_source || (cas.system?.description ? 'manual' : undefined),
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
