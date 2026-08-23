import {
  capabilityCatalogAiPhaseStatus,
  capabilityCitesRequiredEvidence,
  capabilityEvidenceSubjectTokens,
  capabilityOutcomeRestatesDeliveryOperation,
  capabilityOutcomeUsesDeliverySubject,
  capabilityEvidencePublicationFailure,
  capabilityOutcomeNameUnsupportedTokens,
  capabilityRequiresCatalogCoverage,
  catalogCountBounds,
  catalogEntityCandidateGroups,
  catalogEvidenceCandidates,
  catalogRequiredEvidenceCandidates,
  classifyCapabilityEvidence,
  catalogMinimumCapabilityCount,
  catalogRelatedEntityIds,
  hasFirstPartyCorroboratedCatalogOperations,
} from '../../analyzer/core/capability-catalog-evidence';
import type { CASDataEntity, SystemCapability } from '../../types/cas.types';

function candidate(id: string, name: string, category: SystemCapability['category'], actions: string[]): SystemCapability {
  return {
    id,
    name,
    structural_label: `${name} Management`,
    description: `${name} behavior backed by observed operations.`,
    category,
    criticality: 'medium',
    criticality_factors: [],
    related_entities: [],
    related_domains: [],
    operations: actions.map((action, index) => ({
      entry_point_id: `${id}_${index}`,
      entry_point_type: 'internal' as const,
      action,
    })),
  } as SystemCapability;
}

function entity(id: string, name: string, kind: CASDataEntity['kind'], lifecycle = false): CASDataEntity {
  return {
    id,
    name,
    kind,
    lifecycle: {
      created_by: lifecycle ? [`${id}_create`] : [],
      read_by: [],
      updated_by: [],
      deleted_by: [],
    },
  };
}

describe('catalogEvidenceCandidates', () => {
  test('keeps internally executed product behavior corroborated by first-party concepts', () => {
    const selected = catalogEvidenceCandidates([
      candidate('product', 'Product', 'core', ['Coordinate', 'Generate']),
      candidate('cart', 'Cart', 'supporting', ['Read', 'Update']),
      candidate('cart-notification', 'Cart Notification', 'supporting', ['Read', 'Process']),
      candidate('placeholder', 'Placeholder', 'supporting', ['Coordinate', 'Coordinate', 'Coordinate']),
      candidate('widths', 'Widths', 'supporting', ['Read', 'Generate']),
    ], [], [], 'app', { concepts: ['product', 'cart', 'storefront'] });

    expect(selected.map(item => [item.id, item.evidence_role])).toEqual([
      ['product', 'product-outcome'],
      ['cart', 'supporting-mechanism'],
      ['cart-notification', 'supporting-mechanism'],
      ['placeholder', 'supporting-mechanism'],
      ['widths', 'supporting-mechanism'],
    ]);
  });

  test('does not promote an internal supporting aggregate through a generic product-text overlap', () => {
    const analysis = candidate('analysis', 'Analysis', 'supporting', ['Read', 'Coordinate']);
    analysis.structural_label = 'Analysis';
    analysis.related_entities = ['entity_analysis_comparison'];

    const selected = catalogEvidenceCandidates(
      [analysis],
      [],
      [entity('entity_analysis_comparison', 'AnalysisComparison', 'domain-shape')],
      'app',
      { concepts: ['analysis', 'codebase', 'graph'] },
    );

    expect(selected.map(item => [item.id, item.evidence_role])).toEqual([
      ['analysis', 'supporting-mechanism'],
    ]);
  });

  test('does not promote a single internal occurrence or uncorroborated implementation family', () => {
    const selected = catalogEvidenceCandidates([
      candidate('quantity', 'Quantity', 'core', ['Update']),
      candidate('renderer', 'Renderer', 'core', ['Generate', 'Generate']),
    ], [], [], 'app', { concepts: ['quantity', 'commerce'] });

    expect(selected.map(item => [item.id, item.evidence_role])).toEqual([
      ['quantity', 'product-outcome'],
      ['renderer', 'supporting-mechanism'],
    ]);
  });

  test('keeps cohesive presentation surfaces while excluding uncorroborated delivery commands', () => {
    const interfaceSurface = candidate('workspace-ui', 'Workspace review surface', 'core', ['View', 'Compare']);
    interfaceSurface.evidence_kind = 'behavior-surface';
    interfaceSurface.operations.forEach(operation => { operation.entry_point_type = 'page'; });
    interfaceSurface.criticality_factors = ["2 page entry points form one cohesive behavior family ('workspace')"];
    const delivery = candidate('delivery', 'Artifact delivery', 'supporting', ['Deploy', 'Verify']);
    delivery.operations.forEach(operation => { operation.entry_point_type = 'cli'; });

    expect(catalogEvidenceCandidates(
      [delivery],
      [interfaceSurface],
      [],
      'app',
      { productDocSummary: 'A platform for reviewing and understanding software workspaces.' },
    ).map(item => [item.id, item.evidence_role])).toEqual([
      ['delivery', 'unresolved'],
      ['workspace-ui', 'unresolved'],
    ]);
  });

  test('keeps a command surface when first-party text establishes it as the product', () => {
    const formatter = candidate('formatter', 'Format documents', 'core', ['Format', 'Write']);
    formatter.operations.forEach(operation => { operation.entry_point_type = 'cli'; });

    expect(catalogEvidenceCandidates(
      [formatter], [], [], 'app', { manifestDescription: 'A product to format documents through commands.' },
    ).map(item => item.id)).toEqual(['formatter']);
  });

  test('requires lifecycle evidence for internally operated domain shapes', () => {
    const parcel = candidate('parcel', 'Track parcels', 'core', ['Track']);
    parcel.related_entities = ['entity_parcel'];
    const inspection = candidate('inspection', 'Record inspections', 'supporting', ['Record']);
    inspection.related_entities = ['entity_inspection'];

    const selected = catalogEvidenceCandidates(
      [parcel, inspection],
      [],
      [
        entity('entity_parcel', 'Parcel', 'domain-shape'),
        entity('entity_inspection', 'Inspection', 'domain-shape', true),
      ],
      'app',
    );

    expect(selected.map(item => [item.id, item.evidence_role])).toEqual([
      ['parcel', 'supporting-mechanism'],
      ['inspection', 'unresolved'],
    ]);
  });

  test('keeps implementation-shaped entities as evidence unless first-party text makes them the product', () => {
    const internalManifest = candidate('cas-manifest', 'CAS manifest', 'supporting', ['Generate']);
    internalManifest.related_entities = ['entity_cas_manifest'];
    const productManifest = candidate('shipping-manifest', 'Shipping manifest', 'supporting', ['Generate']);
    productManifest.related_entities = ['entity_shipping_manifest'];

    const selected = catalogEvidenceCandidates(
      [internalManifest, productManifest],
      [],
      [
        entity('entity_cas_manifest', 'CasSectionManifest', 'domain-shape', true),
        entity('entity_shipping_manifest', 'ShippingManifest', 'domain-shape', true),
      ],
      'app',
      { productDocSummary: 'A logistics product for generating and tracking shipping manifests.' },
    );

    expect(selected.map(item => [item.id, item.evidence_role])).toEqual([
      ['cas-manifest', 'supporting-mechanism'],
      ['shipping-manifest', 'unresolved'],
    ]);
  });

  test('does not turn request contracts, unperformed models, or unrelated internal shapes into product evidence', () => {
    const request = candidate('request', 'Submit transfer', 'core', ['Submit']);
    request.related_entities = ['entity_transfer_request'];
    const dormant = candidate('dormant', 'Track reservation', 'core', []);
    dormant.related_entities = ['entity_reservation'];
    const unrelated = candidate('unrelated', 'Run indexing', 'supporting', ['Index']);
    unrelated.related_entities = ['entity_parcel'];
    const internal = candidate('internal', 'Process parcels', 'internal', ['Process']);
    internal.related_entities = ['entity_parcel'];

    const selected = catalogEvidenceCandidates(
      [request, dormant, unrelated, internal],
      [],
      [
        entity('entity_transfer_request', 'TransferRequest', 'request-dto', true),
        entity('entity_reservation', 'Reservation', 'domain-shape', true),
        entity('entity_parcel', 'Parcel', 'domain-shape', true),
      ],
      'app',
    );

    expect(selected.map(item => [item.id, item.evidence_role])).toEqual([
      ['request', 'supporting-mechanism'],
      ['dormant', 'supporting-mechanism'],
      ['unrelated', 'supporting-mechanism'],
      ['internal', 'supporting-mechanism'],
    ]);
  });
});

describe('capability evidence roles', () => {
  test('keeps verification and supporting evidence auditable without making either a mandatory product family', () => {
    const verification = candidate('proof', 'Exercise analysis proof', 'supporting', ['Run']);
    verification.operations[0].entry_point_id = 'proof-entry';
    const support = candidate('cache', 'Warm result cache', 'supporting', ['Warm']);
    const product = candidate('review', 'Review software behavior', 'core', ['Review']);
    product.operations[0].entry_point_id = 'review-entry';
    product.related_entities = ['entity_analysis'];

    const classified = classifyCapabilityEvidence(
      [verification, support, product],
      [entity('entity_analysis', 'Analysis', 'persisted-entity', true)],
      undefined,
      {
        entryPoints: [
          { id: 'proof-entry', source_node: 'proof-node', type: 'cli', name: 'proof', interaction_reach: 'external' },
          { id: 'review-entry', source_node: 'review-node', type: 'page', name: 'review', interaction_reach: 'external' },
        ],
        nodes: [
          { id: 'proof-node', name: 'proof', type: 'function', level: 3, source: { file: 'src/__tests__/proof.test.ts' }, metadata: { is_test: true } } as any,
          { id: 'review-node', name: 'review', type: 'page', level: 2, source: { file: 'src/review.ts' } } as any,
        ],
      },
    );

    expect(classified.map(item => [item.id, item.evidence_role])).toEqual([
      ['proof', 'verification-harness'],
      ['cache', 'supporting-mechanism'],
      ['review', 'product-outcome'],
    ]);
    expect(catalogRequiredEvidenceCandidates(classified).map(item => item.id)).toEqual(['review']);
  });

  test('keeps ambiguous product-entity evidence mandatory instead of silently dropping it', () => {
    const ambiguous = candidate('history', 'Inspect recorded history', 'supporting', ['Read']);
    ambiguous.related_entities = ['entity_history'];
    const [classified] = classifyCapabilityEvidence(
      [ambiguous],
      [entity('entity_history', 'History', 'persisted-entity', true)],
    );

    expect(classified.evidence_role).toBe('unresolved');
    expect(catalogRequiredEvidenceCandidates([classified])).toEqual([classified]);
  });

  test('does not call a mixed resolved-test and unresolved operation family a verification harness', () => {
    const mixed = candidate('mixed', 'Exercise and publish analysis', 'supporting', ['Exercise', 'Publish']);
    mixed.operations[0].entry_point_id = 'proof-entry';
    mixed.operations[1].entry_point_id = 'unresolved-production-entry';
    const [classified] = classifyCapabilityEvidence([mixed], [], undefined, {
      entryPoints: [{ id: 'proof-entry', source_node: 'proof-node', type: 'test', name: 'proof' }],
      nodes: [{ id: 'proof-node', name: 'proof', type: 'function', level: 3, metadata: { is_test: true } } as any],
    });

    expect(classified.evidence_role).toBe('supporting-mechanism');
  });

  test('uses a terminal user journey as product evidence without relying on capability vocabulary', () => {
    const outcome = candidate('outcome', 'Present workspace changes', 'core', ['Present']);
    outcome.operations[0].entry_point_id = 'workspace-page';
    const [classified] = classifyCapabilityEvidence([outcome], [], undefined, {
      userJourneys: [{
        id: 'journey', name: 'Review changes', journey_kind: 'user-facing', entry_point_id: 'workspace-page',
        entry: { type: 'page', name: 'workspace' }, steps: [],
        terminal_effects: { entities_written: [], entities_read: ['Workspace'], external_services: [], messages_emitted: [] },
        terminal_entities: [], security_boundaries: [], tests_covering: [], criticality: 'high', call_chain_ids: [], exit_point_ids: [],
      }],
    });

    expect(classified.evidence_role).toBe('product-outcome');
  });

  test('keeps delivery surfaces as evidence even when their tools have terminal user journeys', () => {
    const surface = candidate('agent-tools', 'Agent MCP Tool Surface', 'internal', ['Handle']);
    surface.evidence_kind = 'behavior-surface';
    surface.operations[0].entry_point_id = 'search-nodes';
    const [classified] = classifyCapabilityEvidence([surface], [], {
      productDocSummary: 'The product gives AI agents behavior-level software comprehension.',
    }, {
      userJourneys: [{
        id: 'journey', name: 'Search nodes', journey_kind: 'user-facing', entry_point_id: 'search-nodes',
        entry: { type: 'message', name: 'search_nodes' }, steps: [],
        terminal_effects: { entities_written: [], entities_read: ['CASNode'], external_services: [], messages_emitted: [] },
        terminal_entities: [], security_boundaries: [], tests_covering: [], criticality: 'high', call_chain_ids: [], exit_point_ids: [],
      }],
    });

    expect(classified.evidence_role).toBe('unresolved');
    expect(classified.evidence_role_reasons).toEqual(['first-party-product-delivery-surface-requires-outcome-mapping']);
    expect(capabilityRequiresCatalogCoverage(classified)).toBe(true);
  });

  test('rejects a single tool name masquerading as the outcome of a broader cited surface', () => {
    const surface = candidate('agent-tools', 'Agent MCP Tool Surface', 'internal', ['Handle']);
    surface.structural_label = 'Agent MCP Tool Surface';
    surface.related_domains = ['software understanding'];

    expect(capabilityOutcomeNameUnsupportedTokens(
      'Install agent default config',
      [surface],
      { productDocSummary: 'Turns software graphs into behavior-level comprehension for people and AI agents.' },
    )).toEqual(expect.arrayContaining(['default', 'config']));
    expect(capabilityOutcomeNameUnsupportedTokens(
      'Explain software behavior to agents',
      [surface],
      { productDocSummary: 'Turns software graphs into behavior-level comprehension for people and AI agents.' },
    )).toEqual([]);
  });

  test('keeps focused delivery titles on recurring family subjects instead of one operation or related entity', () => {
    const surface = candidate('codebase-tools', 'Codebase MCP Tool Surface', 'internal', ['Handle']);
    surface.evidence_kind = 'behavior-surface';
    surface.structural_label = 'Codebase MCP Tool Surface';
    surface.related_domains = ['codebase'];
    surface.related_entities = ['entity_klauroconfig'];
    surface.evidence_examples = [
      'analyze_codebase',
      'analyze_codebase_remote',
      'get_codebase_agent_rules',
      'get_codebase_idioms',
      'preview_codebase_iteration',
    ];

    expect(capabilityEvidenceSubjectTokens(surface)).toEqual(['codebase']);
    expect(capabilityOutcomeNameUnsupportedTokens('Analyze codebases', [surface], {})).toEqual([]);
    expect(capabilityOutcomeNameUnsupportedTokens('Analyze codebase configuration', [surface], {})).toEqual(['configuration']);
    expect(capabilityOutcomeNameUnsupportedTokens('Review codebase idioms', [surface], {})).toEqual(['idiom']);
    expect(capabilityOutcomeRestatesDeliveryOperation('Evaluate agent tool surface', [{ ...surface, name: 'Agent Tool Surface' }], {})).toBe(true);
    expect(capabilityOutcomeRestatesDeliveryOperation('Analyze analysis surface', [{ ...surface, name: 'Analysis Tool Surface' }], {})).toBe(true);
  });

  test('separates product outcomes from command, route, and analysis-layer names without deleting their evidence', () => {
    const cas = candidate('cas', 'CAS relationship graph', 'core', ['Analyze']);
    const agent = candidate('agent-tools', 'Agent MCP Tool Surface', 'internal', ['Handle']);
    const architecture = candidate('architecture', 'Architecture review surface', 'supporting', ['Review']);
    const history = candidate('history', 'Change history', 'supporting', ['Read']);
    const signal = {
      productDocTitle: 'Klauro',
      productDocSummary: 'Klauro builds a trustworthy CAS relationship graph, turns it into behavior-level comprehension for people and AI agents, enables real-time collaboration through Fabric, and correlates static understanding with runtime evidence.',
      manifestDescription: 'Software understanding through CAS analysis and agent context.',
    };

    expect(capabilityOutcomeNameUnsupportedTokens('Search nodes', [cas, agent], signal)).toContain('node');
    expect(capabilityOutcomeNameUnsupportedTokens('Install agent default config', [agent], signal)).toEqual(expect.arrayContaining(['default', 'config']));
    expect(capabilityOutcomeNameUnsupportedTokens('Get architectural conflicts', [architecture, agent], signal)).toContain('conflict');
    expect(capabilityOutcomeNameUnsupportedTokens('Route overview', [architecture, agent], signal)).toEqual(expect.arrayContaining(['overview']));
    expect(capabilityOutcomeNameUnsupportedTokens('Run analysis layer', [history], signal)).toEqual(['layer']);
    history.related_entities = ['entity_change_history_entry'];
    expect(capabilityOutcomeNameUnsupportedTokens('Surface codebase evolution history', [history], signal)).toEqual([]);

    expect(capabilityOutcomeNameUnsupportedTokens('Build trustworthy CAS relationship graphs', [cas], signal)).toEqual([]);
    expect(capabilityOutcomeNameUnsupportedTokens('Explain software behavior to AI agents', [agent], signal)).toEqual([]);
    expect(capabilityOutcomeNameUnsupportedTokens('Correlate static understanding with runtime evidence', [cas], signal)).toEqual([]);
  });

  test('derives repair subject terms from product evidence without leaking structural scaffolding', () => {
    const history = candidate('cap_history', 'History', 'supporting', ['Read']);
    history.structural_label = 'History Management';
    history.related_domains = ['change history'];
    history.related_entities = ['entity_change_history_entry'];

    expect(capabilityEvidenceSubjectTokens(history, ['ChangeHistoryEntry'])).toEqual(['change', 'history']);
  });

  test('derives recurring operation subjects while rejecting command-shaped delivery outcomes', () => {
    const fabric = candidate('fabric', 'Fab MCP Tool Surface', 'internal', ['Handle']);
    fabric.evidence_kind = 'behavior-surface';
    fabric.evidence_examples = ['claim_work', 'extend_work', 'list_active_work', 'release_work'];

    expect(capabilityEvidenceSubjectTokens(fabric)).toEqual(['fab', 'work']);
    expect(capabilityOutcomeRestatesDeliveryOperation('Release work in codebase analysis', [fabric])).toBe(true);
    expect(capabilityOutcomeRestatesDeliveryOperation('Coordinate overlapping work', [fabric])).toBe(false);
    expect(capabilityOutcomeRestatesDeliveryOperation('Coordinate work with', [fabric])).toBe(true);
    fabric.evidence_examples = ['analyze_codebase', 'sync_codebase', 'get_codebase_summary'];
    expect(capabilityOutcomeRestatesDeliveryOperation('Analyze codebases', [fabric], { productDocSummary: 'The product analyzes codebases.' })).toBe(false);
    expect(capabilityOutcomeRestatesDeliveryOperation('Analyze codebases', [fabric])).toBe(true);
    fabric.evidence_examples = ['get_agent_context', 'get_agent_readiness', 'get_agent_tool_plan'];
    expect(capabilityOutcomeRestatesDeliveryOperation('Get agent context', [fabric])).toBe(true);
    expect(capabilityOutcomeRestatesDeliveryOperation('Review agent context', [fabric])).toBe(false);
    expect(capabilityOutcomeRestatesDeliveryOperation('Support agents with codebase context', [fabric])).toBe(false);
    expect(capabilityOutcomeNameUnsupportedTokens('Understand workspace behavior through capability and entity maps', [{
      ...fabric,
      name: 'Workspace MCP Tool Surface',
      structural_label: 'Workspace MCP Tool Surface',
      evidence_examples: ['get_workspace_capability_map', 'get_workspace_entity_map'],
    }], {})).toEqual(['entity']);
    expect(capabilityOutcomeNameUnsupportedTokens('Assess agent readiness using agent context', [{
      ...fabric,
      name: 'Agent MCP Tool Surface',
      structural_label: 'Agent MCP Tool Surface',
      evidence_examples: ['evaluate_agent_readiness', 'get_agent_context'],
    }], {})).toEqual(['readiness', 'context']);
    expect(capabilityOutcomeNameUnsupportedTokens('Assess agent readiness and task proof', [{
      ...fabric,
      name: 'Agent MCP Tool Surface',
      structural_label: 'Agent MCP Tool Surface',
      evidence_examples: ['evaluate_agent_readiness', 'evaluate_agent_task_proof', 'get_agent_context'],
    }], {})).toEqual([]);
    expect(capabilityOutcomeUsesDeliverySubject('Support agents with codebase context', [fabric])).toBe(true);
    expect(capabilityOutcomeUsesDeliverySubject('Build a relationship graph', [fabric])).toBe(false);
  });

  test('refuses to publish an authored capability grounded only in supporting or verification candidates', () => {
    const authored = candidate('authored', 'Expose product result', 'core', ['Expose']);
    const supporting = { ...candidate('support', 'Warm cache', 'supporting', ['Warm']), evidence_role: 'supporting-mechanism' as const };
    const verification = { ...candidate('proof', 'Exercise proof', 'supporting', ['Run']), evidence_role: 'verification-harness' as const };
    const product = { ...candidate('product', 'Review result', 'core', ['Review']), evidence_role: 'product-outcome' as const };

    authored.criticality_factors = ['catalog-candidate:support', 'catalog-candidate:proof'];
    expect(capabilityCitesRequiredEvidence(authored, [supporting, verification, product])).toBe(false);
    expect(capabilityEvidencePublicationFailure(authored, [supporting, verification, product]))
      .toBe('supporting-or-verification-evidence-only');
    authored.criticality_factors.push('catalog-candidate:product');
    expect(capabilityCitesRequiredEvidence(authored, [supporting, verification, product])).toBe(true);
    authored.criticality_factors = [];
    expect(capabilityEvidencePublicationFailure(authored, [supporting, verification, product]))
      .toBe('uncited-candidate-evidence');
  });
});

describe('catalogEntityCandidateGroups', () => {
  test('allows one authored capability to cover several related entity families', () => {
    expect(catalogCountBounds(37, 0, 37)).toEqual({ min: 6, max: 20 });
    expect(catalogMinimumCapabilityCount(37, 37)).toBe(6);
  });

  test('groups candidates sharing an entity while preserving unrelated product families', () => {
    const parcelRead = candidate('parcel-read', 'Review parcels', 'core', ['Read']);
    parcelRead.related_entities = ['entity_parcel'];
    const parcelWrite = candidate('parcel-write', 'Record parcels', 'core', ['Write']);
    parcelWrite.related_entities = ['entity_parcel'];
    const inspection = candidate('inspection', 'Record inspections', 'supporting', ['Write']);
    inspection.related_entities = ['entity_inspection'];

    expect(catalogEntityCandidateGroups([parcelRead, parcelWrite, inspection])).toEqual([
      ['inspection'],
      ['parcel-read', 'parcel-write'],
    ]);
  });

  test('excludes entity-free, external-only, and behavior-surface candidates', () => {
    const external = candidate('external', 'Call carrier', 'supporting', ['Call']);
    external.related_entities = ['entity_parcel'];
    external.operations[0].entry_point_type = 'external';
    const surface = candidate('surface', 'Parcel surface', 'supporting', ['Read']);
    surface.related_entities = ['entity_parcel'];
    surface.evidence_kind = 'behavior-surface';

    expect(catalogEntityCandidateGroups([external, surface])).toEqual([]);
  });
});

describe('catalogRelatedEntityIds', () => {
  test('preserves the authored entity family when structural evidence spans other entities', () => {
    expect(catalogRelatedEntityIds(
      ['entity_invoice'],
      new Set(['entity_invoice', 'entity_vehicle', 'entity_fuel_purchase']),
    )).toEqual(['entity_invoice']);
  });

  test('uses structural entity evidence when the authored catalog omits entity mapping', () => {
    expect(catalogRelatedEntityIds([], new Set(['entity_vehicle', 'entity_vehicle']))).toEqual(['entity_vehicle']);
  });
});

describe('hasFirstPartyCorroboratedCatalogOperations', () => {
  test('accepts cited operation evidence when first-party product text corroborates the authored outcome', () => {
    const structural = candidate('fabric-surface', 'Fabric collaboration', 'internal', ['Claim', 'Coordinate']);
    const authored = candidate('authored', 'Enable real-time collaboration through Fabric', 'core', ['Claim']);
    authored.criticality_factors = ['catalog-candidate:fabric-surface'];

    expect(hasFirstPartyCorroboratedCatalogOperations(
      authored,
      [structural],
      { productDocSummary: 'Fabric enables real-time collaboration when teams work on overlapping concepts.' },
    )).toBe(true);
  });

  test('rejects operation-only outcomes without both a valid citation and first-party corroboration', () => {
    const structural = candidate('fallback-route', 'Fallback route', 'supporting', ['Handle']);
    const authored = candidate('authored', 'Provide system fallback', 'supporting', ['Handle']);
    authored.criticality_factors = ['catalog-candidate:fallback-route'];

    expect(hasFirstPartyCorroboratedCatalogOperations(authored, [structural], {
      productDocSummary: 'A parcel tracking application for dispatch teams.',
    })).toBe(false);
    expect(hasFirstPartyCorroboratedCatalogOperations({
      ...authored,
      criticality_factors: [],
    }, [structural], {
      productDocSummary: 'The system provides fallback routing for resilient operations.',
    })).toBe(false);
  });
});

describe('capabilityCatalogAiPhaseStatus', () => {
  test('degrades the AI phase whenever required catalog evidence is not fully accepted', () => {
    expect(capabilityCatalogAiPhaseStatus({ evidence_families: 35, status: 'rejected' })).toBe('degraded');
    expect(capabilityCatalogAiPhaseStatus({ evidence_families: 35, status: 'partial' })).toBe('degraded');
    expect(capabilityCatalogAiPhaseStatus({ evidence_families: 35, status: 'accepted' })).toBe('complete');
    expect(capabilityCatalogAiPhaseStatus({ evidence_families: 0, status: 'unavailable' })).toBe('complete');
  });
});
