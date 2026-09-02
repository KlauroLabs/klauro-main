import {
  capabilityCatalogAiPhaseStatus,
  capabilityCanRepairRejectedOutcomeProposal,
  capabilityDescriptionProductLanguageFailure,
  capabilityCitesRequiredEvidence,
  capabilityEvidenceSubjectTokens,
  capabilityOutcomeMisusesCoordination,
  capabilityOutcomeRestatesDeliveryOperation,
  capabilityOutcomeScopeFailure,
  capabilityOutcomeUsesDeliverySubject,
  capabilityEvidencePublicationFailure,
  capabilityOutcomeNameUnsupportedTokens,
  narrowCapabilityEvidenceCandidates,
  capabilityRequiresCatalogCoverage,
  catalogCountBounds,
  catalogEntityCandidateGroups,
  catalogEvidenceCandidates,
  catalogRequiredEvidenceCandidates,
  classifyCapabilityEvidence,
  catalogMinimumCapabilityCount,
  catalogRelatedEntityIds,
  demoteCoveredImplementationAggregates,
  hasFirstPartyCorroboratedCatalogOperations,
  synchronizeCapabilityCatalogCoverage,
  uniquelyMatchingCapabilityEntityIds,
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

describe('narrowCapabilityEvidenceCandidates', () => {
  test('removes a broad sibling when a cited candidate matches the distinctive outcome', () => {
    const article = candidate('article', 'Article Slug', 'supporting', ['Read', 'Update', 'Delete']);
    const favorite = candidate('favorite', 'Favorite', 'core', ['Create', 'Delete']);
    const route = candidate('favorite-route', 'Delete /api/articles/{slug}/favorite', 'supporting', ['Create', 'Delete']);

    expect(narrowCapabilityEvidenceCandidates(
      'Favorite an article', [article, favorite, route],
    ).map(item => item.id)).toEqual(['favorite', 'favorite-route']);
  });

  test('preserves separately evidenced subjects in a genuinely combined outcome', () => {
    const projects = candidate('projects', 'Projects', 'core', ['Create', 'Update']);
    const issues = candidate('issues', 'Issues', 'core', ['Create', 'Update']);

    expect(narrowCapabilityEvidenceCandidates(
      'Manage projects and issues', [projects, issues],
    ).map(item => item.id)).toEqual(['projects', 'issues']);
  });
});

describe('catalogEvidenceCandidates', () => {
  test('keeps internally executed product behavior corroborated by first-party concepts', () => {
    const selected = catalogEvidenceCandidates([
      candidate('product', 'Product', 'core', ['Coordinate', 'Generate']),
      candidate('cart', 'Cart', 'supporting', ['Read', 'Update']),
      candidate('cart-notification', 'Cart Notification', 'supporting', ['Read', 'Process']),
      candidate('placeholder', 'Placeholder', 'supporting', ['Coordinate', 'Coordinate', 'Coordinate']),
      candidate('widths', 'Widths', 'supporting', ['Read', 'Generate']),
    ], [], [], 'app', { concepts: ['product', 'cart', 'storefront'], productDocSummary: 'Generate product results for shoppers.' });

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

  test('does not promote internal aggregates from loose first-party lexical overlap alone', () => {
    const selected = catalogEvidenceCandidates([
      candidate('quantity', 'Quantity', 'core', ['Update']),
      candidate('renderer', 'Renderer', 'core', ['Generate', 'Generate']),
      candidate('user', 'User', 'core', ['Read', 'Update']),
    ], [], [], 'app', {
      concepts: ['quantity', 'commerce', 'user', 'update'],
      productDocSummary: 'A commerce example with CRUD and authentication patterns.',
    });

    expect(selected.map(item => [item.id, item.evidence_role])).toEqual([
      ['quantity', 'supporting-mechanism'],
      ['renderer', 'supporting-mechanism'],
      ['user', 'supporting-mechanism'],
    ]);
  });

  test('promotes an internal core aggregate when one first-party clause names its action and subject', () => {
    const selected = catalogEvidenceCandidates([
      candidate('quantity', 'Quantity', 'core', ['Update']),
      candidate('user', 'User profiles', 'core', ['Read', 'Update']),
    ], [], [], 'app', {
      productDocSummary: 'Operators update quantities while readers browse unrelated articles.',
    });

    expect(selected.map(item => [item.id, item.evidence_role])).toEqual([
      ['quantity', 'product-outcome'],
      ['user', 'supporting-mechanism'],
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
      ['workspace-ui', 'product-outcome'],
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
  test('keeps verification, internal, and uncorroborated public evidence auditable without making them mandatory outcomes', () => {
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
      ['review', 'unresolved'],
    ]);
    expect(catalogRequiredEvidenceCandidates(classified)).toEqual([]);
  });

  test('keeps a bare-noun public surface as evidence instead of inventing a mandatory outcome', () => {
    const bareSurface = candidate('jobsites', 'Job Sites', 'core', ['Read']);
    bareSurface.related_entities = ['entity_job'];
    bareSurface.evidence_kind = 'behavior-surface';
    bareSurface.operations[0].entry_point_id = 'jobsites-page';
    const [classified] = classifyCapabilityEvidence(
      [bareSurface],
      [entity('entity_job', 'Job', 'persisted-entity', true)],
      undefined,
      { entryPoints: [{
        id: 'jobsites-page', source_node: 'jobsites-node', type: 'page',
        name: 'Job Sites', interaction_reach: 'external',
      }] as any, userJourneys: [{
        id: 'jobsites-journey', name: 'View job sites', journey_kind: 'user-facing',
        entry_point_id: 'jobsites-page', entry: { type: 'page', name: 'Job Sites' }, steps: [],
        terminal_effects: { entities_written: [], entities_read: ['Job'], external_services: [], messages_emitted: [] },
        terminal_entities: [], security_boundaries: [], tests_covering: [], criticality: 'medium',
        call_chain_ids: [], exit_point_ids: [],
      }] as any },
    );

    expect(classified.evidence_role).toBe('unresolved');
    expect(catalogRequiredEvidenceCandidates([classified])).toEqual([]);
  });

  test('keeps route and UI event delivery surfaces as evidence rather than outcomes', () => {
    const route = candidate('jobsites', 'Get /Job/Job Sites/:User Id', 'core', ['Read', 'Click']);
    route.related_entities = ['entity_job'];
    route.operations[0].entry_point_id = 'jobsites-page';
    route.operations[1].entry_point_id = 'jobsites-click';
    const handler = candidate('category-click', 'Manage Categories Click', 'core', ['Click', 'Click']);
    handler.related_entities = ['entity_category'];
    handler.operations.forEach((operation, index) => { operation.entry_point_id = `category-click-${index}`; });
    const classified = classifyCapabilityEvidence(
      [route, handler],
      [
        entity('entity_job', 'Job', 'persisted-entity', true),
        entity('entity_category', 'Category', 'persisted-entity', true),
      ],
      { productDocSummary: 'Organize job applications into categories and filter them by job site.' },
      {
        entryPoints: [
          { id: 'jobsites-page', source_node: 'jobsites-node', type: 'http', name: 'GET /job/job-sites/:userId', interaction_reach: 'external' },
          { id: 'jobsites-click', source_node: 'jobsites-click-node', type: 'event', name: 'Jobsites click', interaction_reach: 'external' },
        ] as any,
        userJourneys: [
          {
            id: 'jobsites-journey', name: 'View job sites', journey_kind: 'user-facing',
            entry_point_id: 'jobsites-page', entry: { type: 'http', name: 'Job Sites' }, steps: [],
            terminal_effects: { entities_written: [], entities_read: ['Job'], external_services: [], messages_emitted: [] },
            terminal_entities: [], security_boundaries: [], tests_covering: [], criticality: 'medium',
            call_chain_ids: [], exit_point_ids: [],
          },
          {
            id: 'category-journey', name: 'Organize applications', journey_kind: 'user-facing',
            entry_point_id: 'category-click-0', entry: { type: 'event', name: 'Categories click' }, steps: [],
            terminal_effects: { entities_written: ['Category'], entities_read: [], external_services: [], messages_emitted: [] },
            terminal_entities: [], security_boundaries: [], tests_covering: [], criticality: 'medium',
            call_chain_ids: [], exit_point_ids: [],
          },
        ] as any,
      },
    );

    expect(classified.map(item => item.evidence_role)).toEqual(['unresolved', 'unresolved']);
    expect(catalogRequiredEvidenceCandidates(classified)).toEqual([]);
  });

  test('keeps uncorroborated production-mounted test routes out of required product outcomes', () => {
    const verification = candidate('capability_test', 'Get API test family access', 'core', ['Read', 'Read']);
    verification.structural_label = 'API test';
    verification.operations = [
      { entry_point_id: 'test-index', entry_point_type: 'http', action: 'read', trigger: { method: 'GET', path: '/api/v1/test' } },
      { entry_point_id: 'test-scope', entry_point_type: 'http', action: 'read', trigger: { method: 'GET', path: '/api/v1/test_scope_required' } },
    ];
    const [classified] = classifyCapabilityEvidence(
      [verification],
      [],
      { productDocTitle: 'Personal finance for everyone', productDocSummary: 'Track accounts, transactions, budgets, and investments.' },
      { entryPoints: [
        { id: 'test-index', source_node: 'route-index', type: 'http', name: 'GET /api/v1/test', trigger: { method: 'GET', path: '/api/v1/test' }, handler: { node_id: 'handler-index', method_name: 'index', file: 'app/controllers/api/v1/test_controller.rb' } },
        { id: 'test-scope', source_node: 'route-scope', type: 'http', name: 'GET /api/v1/test_scope_required', trigger: { method: 'GET', path: '/api/v1/test_scope_required' }, handler: { node_id: 'handler-scope', method_name: 'scope_required', file: 'app/controllers/api/v1/test_controller.rb' } },
      ] },
    );

    expect(classified.evidence_role).toBe('verification-harness');
    expect(classified.evidence_role_reasons).toEqual(['test-named-entry-points-without-product-corroboration']);
    expect(catalogRequiredEvidenceCandidates([classified])).toEqual([]);
  });

  test('keeps internal supporting history available without making its entity family mandatory', () => {
    const ambiguous = candidate('cap_history', 'History', 'supporting', ['Coordinate', 'Read']);
    ambiguous.structural_label = 'History Management';
    ambiguous.related_entities = ['entity_changehistoryentry'];
    const [classified] = classifyCapabilityEvidence(
      [ambiguous],
      [entity('entity_changehistoryentry', 'ChangeHistoryEntry', 'domain-shape', true)],
    );

    expect(classified.evidence_role).toBe('unresolved');
    expect(catalogRequiredEvidenceCandidates([classified])).toEqual([]);
    expect(catalogEvidenceCandidates([ambiguous], [], [entity(
      'entity_changehistoryentry', 'ChangeHistoryEntry', 'domain-shape', true,
    )])).toEqual([classified]);
  });

  test('keeps a user-facing terminal entity outcome mandatory', () => {
    const outcome = candidate('orders', 'Review customer orders', 'supporting', ['Read']);
    outcome.related_entities = ['entity_order'];
    outcome.operations[0].entry_point_id = 'orders-page';
    const [classified] = classifyCapabilityEvidence(
      [outcome],
      [entity('entity_order', 'Order', 'persisted-entity', true)],
      undefined,
      { userJourneys: [{
        id: 'orders-journey', name: 'Review orders', journey_kind: 'user-facing', entry_point_id: 'orders-page',
        entry: { type: 'page', name: 'orders' }, steps: [],
        terminal_effects: { entities_written: [], entities_read: ['Order'], external_services: [], messages_emitted: [] },
        terminal_entities: [], security_boundaries: [], tests_covering: [], criticality: 'high', call_chain_ids: [], exit_point_ids: [],
      }] },
    );

    expect(classified.evidence_role).toBe('product-outcome');
    expect(catalogRequiredEvidenceCandidates([classified])).toEqual([classified]);
  });

  test('uses terminality to rank a CRUD family without declaring the CRUD inventory a mandatory outcome', () => {
    const crud = candidate('rules', 'delete and read and update and create rule', 'core', ['Delete', 'Read', 'Update', 'Create']);
    crud.related_entities = ['entity_rule'];
    crud.operations.forEach((operation, index) => { operation.entry_point_id = `rules-${index}`; });
    const [classified] = classifyCapabilityEvidence(
      [crud],
      [entity('entity_rule', 'Rule', 'persisted-entity', true)],
      undefined,
      { userJourneys: crud.operations.map((operation, index) => ({
        id: `journey-${index}`, name: `Rule operation ${index}`, journey_kind: 'user-facing' as const,
        entry_point_id: operation.entry_point_id, entry: { type: 'http', name: 'rules' }, steps: [],
        terminal_effects: { entities_written: ['Rule'], entities_read: [], external_services: [], messages_emitted: [] },
        terminal_entities: [], security_boundaries: [], tests_covering: [], criticality: 'high' as const,
        call_chain_ids: [], exit_point_ids: [],
      })) },
    );

    expect(classified.evidence_role).toBe('unresolved');
    expect(classified.evidence_role_reasons).toContain('potential-user-outcome-requires-catalog-resolution');
    expect(capabilityRequiresCatalogCoverage(classified)).toBe(false);
  });

  test('does not promote a mechanism-shaped settings workflow from terminal reach alone', () => {
    const settings = candidate('prompt-settings', 'Rule Prompt Settings Workflow', 'core', ['Update']);
    settings.evidence_kind = 'behavior-surface';
    settings.operations[0].entry_point_id = 'prompt-settings-update';
    const [classified] = classifyCapabilityEvidence([settings], [], undefined, {
      userJourneys: [{
        id: 'settings-journey', name: 'Update rule prompt settings', journey_kind: 'user-facing',
        entry_point_id: 'prompt-settings-update', entry: { type: 'http', name: 'settings' }, steps: [],
        terminal_effects: { entities_written: [], entities_read: [], external_services: [], messages_emitted: [] },
        terminal_entities: [], security_boundaries: [], tests_covering: [], criticality: 'low',
        call_chain_ids: [], exit_point_ids: [],
      }],
    });

    expect(classified.evidence_role).toBe('supporting-mechanism');
    expect(capabilityRequiresCatalogCoverage(classified)).toBe(false);
  });

  test('does not promote a UI gesture from terminal functions and framework dependencies alone', () => {
    const registration = candidate('register', 'Register', 'supporting', ['Handle']);
    registration.operations[0].entry_point_type = 'event';
    const [classified] = classifyCapabilityEvidence([registration], [], undefined, {
      userJourneys: [{
        id: 'register-journey', name: 'Register Change', journey_kind: 'user-facing', entry_point_id: 'register_0',
        entry: { type: 'event', name: 'change' }, steps: [],
        terminal_effects: {
          entities_written: [], entities_read: [],
          external_services: ['@chakra-ui/react', 'react', 'react-router-dom'],
          messages_emitted: [],
        },
        terminal_entities: [{ name: 'authenticate', access: 'read', node_id: 'authenticate', terminal_kind: 'node' }],
        security_boundaries: [], tests_covering: [], criticality: 'low', call_chain_ids: [], exit_point_ids: [],
      }],
    });

    expect(classified.evidence_role).toBe('supporting-mechanism');
    expect(capabilityRequiresCatalogCoverage(classified)).toBe(false);
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

  test('keeps first-party delivery surfaces as supporting context without making each namespace a mandatory capability', () => {
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

    expect(classified.evidence_role).toBe('supporting-mechanism');
    expect(classified.evidence_role_reasons).toEqual(['first-party-product-delivery-surface-supports-outcome']);
    expect(capabilityRequiresCatalogCoverage(classified)).toBe(false);
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

  test('grounds cautious appearance outcomes in multiple visual profile fields', () => {
    const merchant = candidate('family-merchants', 'Family merchants', 'core', ['Create', 'Read', 'Update', 'Delete']);
    merchant.evidence_examples = ['entity evidence: name color icon_url logo_url website_url'];

    expect(capabilityOutcomeNameUnsupportedTokens(
      'Customize merchant appearance', [merchant], {},
    )).toEqual([]);
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

    const article = candidate('article', 'Article', 'core', ['Create', 'Update']);
    article.operations[0].entry_point_id = 'entry_route_articles_create';
    const follow = candidate('follow', 'Follow', 'core', ['Create', 'Delete']);
    follow.operations[0].entry_point_id = 'entry_route_profiles_username_follow';
    const favorite = candidate('favorite', 'Favorite', 'core', ['Create', 'Delete']);
    favorite.operations[0].entry_point_id = 'entry_route_articles_slug_favorite';
    const publicationSignal = {};
    expect(capabilityOutcomeNameUnsupportedTokens(
      'Create and publish articles', [article], publicationSignal,
    )).toEqual([]);
    expect(capabilityOutcomeNameUnsupportedTokens(
      'Follow and unfollow users', [follow], publicationSignal,
    )).toEqual([]);
    expect(capabilityOutcomeNameUnsupportedTokens(
      'Favorite and unfavorite articles', [favorite], publicationSignal,
    )).toEqual([]);
    const authentication = candidate('auth', 'Auth', 'core', ['Create']);
    authentication.related_domains = ['auth'];
    authentication.operations[0].entry_point_id = 'entry_route_authentication_login';
    expect(capabilityOutcomeNameUnsupportedTokens(
      'Authenticate user sessions', [authentication], {},
    )).toEqual([]);
    const user = candidate('user', 'User', 'core', ['Read', 'Update']);
    user.operations[0].entry_point_id = 'entry_route_user';
    expect(capabilityOutcomeNameUnsupportedTokens(
      'Update user profile', [user], {},
    )).toEqual([]);


  });

  test('derives repair subject terms from product evidence without leaking structural scaffolding', () => {
    const history = candidate('cap_history', 'History', 'supporting', ['Read']);
    history.structural_label = 'History Management';
    history.related_domains = ['change history'];
    history.related_entities = ['entity_change_history_entry'];

    expect(capabilityEvidenceSubjectTokens(history, ['ChangeHistoryEntry'])).toEqual(['change', 'history']);
  });

  test('derives product subjects from non-surface operation paths', () => {
    const follow = candidate('follow', 'Follow', 'core', ['Create', 'Delete']);
    follow.operations = follow.operations.map((operation, index) => ({
      ...operation,
      entry_point_id: `entry_route_profiles_username_follow_${index}`,
      entry_point_type: 'http',
      path_or_command: '/api/profiles/{username}/follow',
      trigger: { method: index === 0 ? 'POST' : 'DELETE', path: '/api/profiles/{username}/follow' },
    }));

    expect(capabilityEvidenceSubjectTokens(follow)).toEqual(expect.arrayContaining(['follow', 'profile']));
  });

  test('derives recurring operation subjects while rejecting explicit delivery scaffolding', () => {
    const fabric = candidate('fabric', 'Fab MCP Tool Surface', 'internal', ['Handle']);
    fabric.evidence_kind = 'behavior-surface';
    fabric.evidence_examples = ['claim_work', 'extend_work', 'list_active_work', 'release_work'];

    expect(capabilityEvidenceSubjectTokens(fabric)).toEqual(['fab', 'work']);
    expect(capabilityOutcomeRestatesDeliveryOperation('Release work in codebase analysis', [fabric])).toBe(false);
    expect(capabilityOutcomeRestatesDeliveryOperation('Release work through MCP tools', [fabric])).toBe(true);
    expect(capabilityOutcomeRestatesDeliveryOperation('Coordinate overlapping work', [fabric])).toBe(false);
    expect(capabilityOutcomeRestatesDeliveryOperation('Handle Fab work surfaces', [fabric])).toBe(true);
    expect(capabilityOutcomeMisusesCoordination('Coordinate overlapping work', [fabric])).toBe(false);
    expect(capabilityOutcomeMisusesCoordination('Coordinate CAS behavior relationships', [{
      ...fabric,
      name: 'CAS relationship graph',
      structural_label: 'CAS relationship graph',
      related_domains: ['codebase analysis'],
      evidence_examples: ['get_relationships', 'trace_behavior'],
    }])).toBe(true);
    expect(capabilityOutcomeRestatesDeliveryOperation('Coordinate work with', [fabric])).toBe(true);
    fabric.evidence_examples = ['analyze_codebase', 'sync_codebase', 'get_codebase_summary'];
    expect(capabilityOutcomeRestatesDeliveryOperation('Analyze codebases', [fabric], { productDocSummary: 'The product analyzes codebases.' })).toBe(false);
    expect(capabilityOutcomeRestatesDeliveryOperation('Analyze codebases', [fabric])).toBe(false);
    expect(capabilityOutcomeRestatesDeliveryOperation('Analyze codebases', [fabric], undefined, true)).toBe(false);
    expect(capabilityOutcomeRestatesDeliveryOperation(
      'Manage job applications',
      [{ ...fabric, name: 'Job', structural_label: 'Job', evidence_examples: ['add_job', 'edit_job', 'delete_job'] }],
      { productDocSummary: 'Users manage and track job applications.' },
    )).toBe(false);
    expect(capabilityOutcomeRestatesDeliveryOperation('Evaluate analysis truth', [{ ...fabric, evidence_examples: ['evaluate_analysis_truth'] }])).toBe(false);
    expect(capabilityOutcomeRestatesDeliveryOperation('Evaluate analysis truth', [{ ...fabric, evidence_examples: ['evaluate_analysis_truth'] }], undefined, true)).toBe(false);
    expect(capabilityOutcomeRestatesDeliveryOperation('Correlate runtime events with codebase behavior', [{
      ...fabric,
      evidence_examples: ['correlate_runtime_events_with_codebase_behavior'],
    }], { productDocSummary: 'Correlates runtime events with codebase behavior.' })).toBe(false);
    expect(capabilityOutcomeRestatesDeliveryOperation('Correlate runtime events with codebase behavior', [{
      ...fabric,
      evidence_examples: ['correlate_runtime_events_with_codebase_behavior'],
    }], { productDocSummary: 'Correlates static understanding with runtime evidence.' })).toBe(false);
    expect(capabilityOutcomeRestatesDeliveryOperation('Analyze codebase', [{
      ...fabric,
      evidence_examples: ['analyze_codebase'],
    }], { productDocSummary: 'Turns codebase analysis into behavior-level comprehension.' })).toBe(false);
    expect(capabilityOutcomeRestatesDeliveryOperation('Claim work in the fab', [{
      ...fabric,
      evidence_examples: ['claim_work'],
    }], { productDocSummary: 'Fabric enables collaboration across overlapping work.' })).toBe(false);
    expect(capabilityOutcomeRestatesDeliveryOperation('Understand Fab work surfaces', [fabric])).toBe(true);
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
    expect(capabilityOutcomeUsesDeliverySubject('Analyze codebase', [{ ...fabric, name: 'Analysis Tool Surface', structural_label: 'Analysis Tool Surface', related_domains: ['analysis'] }], 'Evaluates analysis truth for the selected codebase.')).toBe(true);
    expect(capabilityOutcomeUsesDeliverySubject('Understand workspace capability map', [fabric], 'Shows workspace capability relationships.')).toBe(false);
    expect(capabilityOutcomeScopeFailure('Analyze codebase', [{
      ...fabric,
      name: 'Analysis Tool Surface',
      structural_label: 'Analysis Tool Surface',
      related_domains: ['analysis'],
      evidence_examples: ['analyze_codebase'],
    }], { productDocSummary: 'Klauro analyzes any codebase.' })).toEqual([]);
    const notes = { ...fabric, name: 'Notes Modal Change', structural_label: 'Notes Modal Change', evidence_examples: ['note created'] };
    expect(capabilityOutcomeScopeFailure(
      'Attach notes to job entries', [notes], { productDocSummary: 'Users add notes to job applications.' },
    )).toEqual([]);
    expect(capabilityOutcomeScopeFailure('Claim work in the fab', [{
      ...fabric,
      evidence_examples: ['claim_work'],
    }], { productDocSummary: 'Fabric enables collaboration across overlapping work.' })).toEqual([]);
    const understanding = { ...fabric, name: 'Software behavior comprehension', structural_label: 'Software behavior comprehension', related_domains: ['software behavior'] };
    expect(capabilityOutcomeScopeFailure(
      'Help human understanding of software behavior', [understanding],
      { productDocSummary: 'Helps people understand software behavior.' }, false, '', ['human'],
    )).toEqual([]);
    expect(capabilityOutcomeScopeFailure(
      'Help human developers understand software behavior', [understanding],
      { productDocSummary: 'Helps people understand software behavior.' }, false, '', ['human'],
    )).toEqual(['developer']);
    const jobApplications = candidate('job-application', 'Job Applications', 'core', ['Create', 'Update']);
    jobApplications.structural_label = 'Job Application Status';
    expect(capabilityOutcomeScopeFailure(
      'Track job applications and update their status', [jobApplications],
      { productDocSummary: 'Users track job applications and update application status.' },
    )).toEqual([]);
    expect(capabilityOutcomeScopeFailure(
      'Track job applications and update their awards', [jobApplications],
      { productDocSummary: 'Users track job applications and update application status.' },
    )).toEqual(['award']);
    expect(capabilityOutcomeScopeFailure(
      'Track their awards', [jobApplications],
      { productDocSummary: 'Users track job applications and update application status.' },
    )).not.toEqual([]);
    const statistics = candidate('statistics', 'Job Application Stats', 'core', ['Read']);
    statistics.structural_label = 'Job Application Statistics';
    statistics.related_domains = ['job-stats'];
    expect(capabilityOutcomeScopeFailure('View job application statistics', [statistics])).toEqual([]);
    expect(capabilityOutcomeScopeFailure('View job application awards', [statistics])).toEqual(['award']);
    const articles = candidate('articles', 'Articles', 'core', ['List', 'Create', 'Update', 'Delete']);
    articles.operations = [
      { entry_point_id: 'list', entry_point_type: 'http', action: 'List', trigger: { method: 'GET' } },
      { entry_point_id: 'create', entry_point_type: 'http', action: 'Create', trigger: { method: 'POST' } },
      { entry_point_id: 'update', entry_point_type: 'http', action: 'Update', trigger: { method: 'PUT' } },
      { entry_point_id: 'delete', entry_point_type: 'http', action: 'Delete', trigger: { method: 'DELETE' } },
    ];
    expect(capabilityOutcomeScopeFailure(
      'Create, update, and delete articles', [articles],
    )).toEqual([]);
    expect(capabilityOutcomeNameUnsupportedTokens('Coordinate work across overlapping codebase areas', [{
      ...fabric,
      evidence_examples: ['fab_claim_work', 'fab_check_collision', 'fab_release_work'],
    }], { productDocSummary: 'Fabric coordinates overlapping work across a codebase.' })).toEqual([]);
  });

  test('lets validated catalog outcomes resolve ambiguous product evidence without promoting supporting-only evidence', () => {
    const authored = candidate('authored', 'Expose product result', 'core', ['Expose']);
    const supporting = { ...candidate('support', 'Warm cache', 'supporting', ['Warm']), evidence_role: 'supporting-mechanism' as const };
    const unresolved = { ...candidate('ambiguous', 'Inspect recorded state', 'supporting', ['Read']), evidence_role: 'unresolved' as const };
    const verification = { ...candidate('proof', 'Exercise proof', 'supporting', ['Run']), evidence_role: 'verification-harness' as const };
    const product = { ...candidate('product', 'Review result', 'core', ['Review']), evidence_role: 'product-outcome' as const };

    authored.criticality_factors = ['catalog-candidate:support', 'catalog-candidate:proof'];
    expect(capabilityCitesRequiredEvidence(authored, [supporting, unresolved, verification, product])).toBe(false);
    expect(capabilityEvidencePublicationFailure(authored, [supporting, unresolved, verification, product]))
      .toBe('supporting-or-verification-evidence-only');
    authored.criticality_factors.push('catalog-candidate:ambiguous');
    expect(capabilityCitesRequiredEvidence(authored, [supporting, unresolved, verification, product])).toBe(true);
    authored.criticality_factors.push('catalog-candidate:product');
    expect(capabilityCitesRequiredEvidence(authored, [supporting, unresolved, verification, product])).toBe(true);
    authored.criticality_factors = [];
    expect(capabilityEvidencePublicationFailure(authored, [supporting, unresolved, verification, product]))
      .toBe('uncited-candidate-evidence');
  });

  test('publishes a first-party outcome grounded by supporting delivery evidence without promoting the delivery namespace itself', () => {
    const surface = {
      ...candidate('fabric', 'Fabric MCP Tool Surface', 'internal', ['Claim', 'Check', 'Release']),
      evidence_kind: 'behavior-surface' as const,
      evidence_role: 'supporting-mechanism' as const,
      evidence_examples: ['claim_work', 'check_collision', 'release_work'],
    };
    const authored = candidate('authored', 'Coordinate overlapping agent work', 'core', ['Coordinate']);
    authored.criticality_factors = ['catalog-candidate:fabric'];

    expect(capabilityEvidencePublicationFailure(authored, [surface], {
      productDocSummary: 'Fabric coordinates real-time collaboration across overlapping agent work.',
    })).toBeUndefined();
    expect(capabilityRequiresCatalogCoverage(surface)).toBe(false);
    expect(capabilityEvidencePublicationFailure(authored, [surface], {
      productDocSummary: 'A parcel tracking application for dispatch teams.',
    })).toBe('supporting-or-verification-evidence-only');
  });
});

describe('catalogEntityCandidateGroups', () => {
  test('does not turn structural or entity family counts into capability quotas', () => {
    expect(catalogCountBounds(37, 0, 37)).toEqual({ min: 0, max: 20 });
    expect(catalogMinimumCapabilityCount(37, 37)).toBe(0);
    expect(catalogCountBounds(2, 1, 1, 5)).toEqual({ min: 0, max: 5 });
    expect(catalogMinimumCapabilityCount(2, 1, 5)).toBe(0);
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

  test('does not transitively collapse distinct entity families through a multi-entity candidate', () => {
    const jobs = candidate('jobs', 'Manage jobs', 'core', ['Write']);
    jobs.related_entities = ['entity_job'];
    const notes = candidate('notes', 'Manage notes', 'core', ['Write']);
    notes.related_entities = ['entity_note'];
    const workspace = candidate('workspace', 'Review workspace', 'core', ['Read']);
    workspace.related_entities = ['entity_job', 'entity_note'];

    expect(catalogEntityCandidateGroups([jobs, notes, workspace])).toEqual([
      ['jobs', 'workspace'],
      ['notes', 'workspace'],
    ]);
  });

  test('lets specific compound-entity outcomes cover their broad parent entity family', () => {
    const family = candidate('family', 'Family', 'core', ['Coordinate']);
    family.related_entities = ['entity_family', 'entity_familymerchant'];
    const merchants = candidate('family-merchants', 'Manage family merchants', 'core', ['Read', 'Write']);
    merchants.related_entities = ['entity_familymerchant'];

    const groups = catalogEntityCandidateGroups([family, merchants]);

    expect(groups).toContainEqual(['family', 'family-merchants']);
    expect(groups).not.toContainEqual(['family']);
  });

  test('lets entity-free route outcomes cover a parent entity family when they share exact operations', () => {
    const sharedOperation = {
      entry_point_id: 'family-merchants-index', entry_point_type: 'http' as const,
      action: 'Read', path_or_command: '/family_merchants',
    };
    const family = candidate('family', 'Family', 'core', ['Coordinate']);
    family.related_entities = ['entity_family', 'entity_familymerchant'];
    family.operations = [sharedOperation];
    const merchants = candidate('family-merchants', 'Manage family merchants', 'core', ['Read']);
    merchants.related_entities = [];
    merchants.operations = [sharedOperation];

    const groups = catalogEntityCandidateGroups([family, merchants]);

    expect(groups).toContainEqual(['family', 'family-merchants']);
    expect(groups).not.toContainEqual(['family']);
  });

  test('links a route resource to one exact semantic entity without guessing among duplicates', () => {
    const entities = [
      { id: 'entity_familymerchant', name: 'FamilyMerchant' },
      { id: 'entity_familyexport', name: 'FamilyExport' },
    ] as CASDataEntity[];
    expect(uniquelyMatchingCapabilityEntityIds('family-merchants', entities))
      .toEqual(['entity_familymerchant']);
    expect(uniquelyMatchingCapabilityEntityIds('family', entities)).toEqual([]);
    expect(uniquelyMatchingCapabilityEntityIds('plaid-items', [
      { id: 'entity_plaiditem', name: 'PlaidItem' } as CASDataEntity,
    ])).toEqual(['entity_plaiditem']);
  });

  test('does not require a mixed implementation aggregate when specific outcomes cover every public operation', () => {
    const merchantRead = {
      entry_point_id: 'merchant-index', entry_point_type: 'http' as const,
      action: 'Read', path_or_command: '/family_merchants',
    };
    const exportRead = {
      entry_point_id: 'export-index', entry_point_type: 'http' as const,
      action: 'Read', path_or_command: '/family_exports',
    };
    const aggregate = candidate('family', 'Family synchronization', 'core', ['Coordinate']);
    aggregate.evidence_role = 'product-outcome';
    aggregate.evidence_role_reasons = ['product-entity'];
    aggregate.operations = [
      { entry_point_id: 'family-model', entry_point_type: 'internal', action: 'Coordinate', path_or_command: 'app/models/family.rb' },
      merchantRead,
      exportRead,
    ];
    const merchants = candidate('family-merchants', 'Manage family merchants', 'core', ['Read']);
    merchants.evidence_role = 'product-outcome';
    merchants.operations = [merchantRead];
    const exports = candidate('family-exports', 'Manage family exports', 'core', ['Read']);
    exports.evidence_role = 'product-outcome';
    exports.operations = [exportRead];

    const classified = demoteCoveredImplementationAggregates([aggregate, merchants, exports]);

    expect(classified[0].evidence_role).toBe('supporting-mechanism');
    expect(classified[0].evidence_role_reasons).toContain('public-surface-covered-by-specific-outcomes');
    expect(classified.slice(1).every(item => item.evidence_role === 'product-outcome')).toBe(true);
  });

  test('treats an entity-free subflow as delivery evidence for its entity-backed outcome', () => {
    const imports = candidate('imports', 'Import financial data', 'core', ['Create', 'Read']);
    imports.related_entities = ['entity_import'];
    imports.evidence_role = 'unresolved';
    const upload = candidate('import-upload', 'read and update upload', 'core', ['Read', 'Update']);
    upload.evidence_kind = 'behavior-surface';
    upload.evidence_role = 'product-outcome';
    upload.related_domains = ['import-upload'];

    const classified = demoteCoveredImplementationAggregates([imports, upload]);

    expect(classified[1].evidence_role).toBe('supporting-mechanism');
    expect(classified[1].evidence_role_reasons).toContain('entity-free-subflow-covered-by-entity-evidence');
  });

  test('does not require an all-public aggregate when smaller outcomes cover every operation', () => {
    const sessionRead = { entry_point_id: 'session-index', entry_point_type: 'http' as const, action: 'Read', path_or_command: '/sessions' };
    const passwordUpdate = { entry_point_id: 'password-update', entry_point_type: 'http' as const, action: 'Update', path_or_command: '/password' };
    const aggregate = candidate('auth', 'Account access', 'core', ['Read', 'Update']);
    aggregate.evidence_role = 'product-outcome';
    aggregate.operations = [sessionRead, passwordUpdate];
    const sessions = candidate('sessions', 'Access sessions', 'core', ['Read']);
    sessions.evidence_role = 'product-outcome';
    sessions.operations = [sessionRead];
    const passwords = candidate('passwords', 'Recover passwords', 'core', ['Update']);
    passwords.evidence_role = 'product-outcome';
    passwords.operations = [passwordUpdate];

    const classified = demoteCoveredImplementationAggregates([aggregate, sessions, passwords]);

    expect(classified[0].evidence_role).toBe('supporting-mechanism');
    expect(classified.slice(1).every(item => item.evidence_role === 'product-outcome')).toBe(true);
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

  test('requires the same cited delivery surface to support the first-party outcome', () => {
    const health = {
      ...candidate('health', 'Health MCP Tool Surface', 'internal', ['Check']),
      evidence_kind: 'behavior-surface' as const,
      evidence_role: 'supporting-mechanism' as const,
      evidence_examples: ['health_check'],
    };
    const proof = {
      ...candidate('proof', 'Coordination proof', 'supporting', ['Coordinate']),
      evidence_role: 'verification-harness' as const,
    };
    const authored = candidate('authored', 'Coordinate overlapping agent work', 'core', ['Coordinate']);
    authored.criticality_factors = ['catalog-candidate:health', 'catalog-candidate:proof'];

    expect(hasFirstPartyCorroboratedCatalogOperations(authored, [health, proof], {
      productDocSummary: 'Fabric coordinates real-time collaboration across overlapping agent work.',
    })).toBe(false);
    expect(capabilityEvidencePublicationFailure(authored, [health, proof], {
      productDocSummary: 'Fabric coordinates real-time collaboration across overlapping agent work.',
    })).toBe('supporting-or-verification-evidence-only');
  });

  test('requires operation-bearing delivery evidence and specific first-party product language', () => {
    const surface = {
      ...candidate('fabric', 'Fabric MCP Tool Surface', 'internal', []),
      evidence_kind: 'behavior-surface' as const,
      evidence_role: 'supporting-mechanism' as const,
      evidence_examples: ['claim_work', 'check_collision', 'release_work'],
    };
    const authored = candidate('authored', 'Coordinate overlapping agent work', 'core', ['Coordinate']);
    authored.criticality_factors = ['catalog-candidate:fabric'];

    expect(hasFirstPartyCorroboratedCatalogOperations(authored, [surface], {
      productDocSummary: 'Fabric coordinates real-time collaboration across overlapping agent work.',
    })).toBe(false);
    surface.operations = candidate('fabric', 'Fabric MCP Tool Surface', 'internal', ['Claim', 'Check', 'Release']).operations;
    expect(hasFirstPartyCorroboratedCatalogOperations(authored, [surface], {
      productDocSummary: 'A software platform for agents and work.',
    })).toBe(false);
  });
});

describe('capabilityDescriptionProductLanguageFailure', () => {
  test('rejects delivery namespaces and implementation inventories', () => {
    expect(capabilityDescriptionProductLanguageFailure(
      'Connects runtime observations to static structure through runtime MCP surfaces.',
      [],
    )).toBe('delivery-surface-scaffolding');
    expect(capabilityDescriptionProductLanguageFailure(
      'Builds a graph from nodes, methods, and call chains discovered in source.',
      [],
    )).toBe('implementation-graph-inventory');
    expect(capabilityDescriptionProductLanguageFailure(
      'Job entries surface attached notes created through modal and click interactions.',
      [],
    )).toBe('ui-delivery-scaffolding');
    expect(capabilityDescriptionProductLanguageFailure(
      'Surfaces a new note creation capability by exposing a note creation form and managing note data.',
      [],
    )).toBe('ui-delivery-scaffolding');
    expect(capabilityDescriptionProductLanguageFailure(
      'Users update their personal details through the profile edit form.',
      [],
    )).toBe('ui-delivery-scaffolding');

    expect(capabilityDescriptionProductLanguageFailure(
      'Categorize and seamlessly manage job applications.',
      [],
    )).toBe('marketing-language');
    expect(capabilityDescriptionProductLanguageFailure(
      'Categorize and seamlessly manage job applications.',
      [], [], [], ['seamlessly manage job applications'],
    )).toBeUndefined();
  });

  test('rejects copied operation phrases while preserving independently phrased product value', () => {
    expect(capabilityDescriptionProductLanguageFailure(
      'Get observations and correlate event data for each requested analysis.',
      [],
      ['["Get","get_observations",null,"message"]', '["Correlate","correlate_event_data",null,"message"]'],
    )).toBe('delivery-operation-restatement');
    expect(capabilityDescriptionProductLanguageFailure(
      'Connects production behavior to the software model so teams can investigate discrepancies.',
      [],
      ['["Get","get_observations",null,"message"]', '["Correlate","correlate_event_data",null,"message"]'],
    )).toBeUndefined();
    expect(capabilityDescriptionProductLanguageFailure(
      'Correlates event data with static behavior to reveal production discrepancies.',
      [],
      ['["Correlate","correlate_event_data",null,"message"]'],
    )).toBe('delivery-operation-restatement');
    expect(capabilityDescriptionProductLanguageFailure(
      'Users can maintain impersonation sessions over time as the access they represent changes.',
      ['ImpersonationSession'],
      ['["create","/impersonation_sessions","POST","http"]'],
    )).toBeUndefined();
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

describe('user-facing lifecycle evidence', () => {
  test('repairs rejected AI proposals only for product or unresolved evidence', () => {
    expect(capabilityCanRepairRejectedOutcomeProposal(candidate('product', 'Product', 'core', []))).toBe(false);
    expect(capabilityCanRepairRejectedOutcomeProposal({ ...candidate('product', 'Product', 'core', []), evidence_role: 'product-outcome' })).toBe(true);
    expect(capabilityCanRepairRejectedOutcomeProposal({ ...candidate('unresolved', 'Unresolved', 'core', []), evidence_role: 'unresolved' })).toBe(true);
    expect(capabilityCanRepairRejectedOutcomeProposal({ ...candidate('support', 'Support', 'supporting', []), evidence_role: 'supporting-mechanism' })).toBe(false);
    expect(capabilityCanRepairRejectedOutcomeProposal({ ...candidate('test', 'Test', 'supporting', []), evidence_role: 'verification-harness' })).toBe(false);
  });

  test('makes a cohesive public create/delete lifecycle mandatory without requiring entity inference', () => {
    const following = candidate('following', 'Follow profiles', 'supporting', ['Follow', 'Unfollow']);
    following.operations = [
      { entry_point_id: 'follow', entry_point_type: 'http', action: 'Follow profile', trigger: { method: 'POST', path: '/profiles/{username}/follow' } },
      { entry_point_id: 'unfollow', entry_point_type: 'http', action: 'Unfollow profile', trigger: { method: 'DELETE', path: '/profiles/{username}/follow' } },
    ];

    const [classified] = classifyCapabilityEvidence([following], [], undefined, {
      entryPoints: [
        { id: 'follow', source_node: 'follow-route', type: 'http', name: 'POST /profiles/{username}/follow', interaction_reach: 'external', trigger: { method: 'POST', path: '/profiles/{username}/follow' } },
        { id: 'unfollow', source_node: 'unfollow-route', type: 'http', name: 'DELETE /profiles/{username}/follow', interaction_reach: 'external', trigger: { method: 'DELETE', path: '/profiles/{username}/follow' } },
      ] as any,
    });

    expect(classified.evidence_role).toBe('product-outcome');
    expect(classified.evidence_role_reasons).toContain('user-facing-lifecycle-breadth');
    expect(capabilityRequiresCatalogCoverage(classified)).toBe(true);
  });

  test('lets first-party purpose make a noun-labeled public lifecycle mandatory without trusting the label as the outcome', () => {
    const budgets = candidate('budgets', 'Budgets', 'core', ['Read', 'Update']);
    budgets.related_entities = ['entity_budget'];
    budgets.operations = [
      { entry_point_id: 'list-budgets', entry_point_type: 'http', action: 'Read', trigger: { method: 'GET', path: '/budgets' } },
      { entry_point_id: 'update-budget', entry_point_type: 'http', action: 'Update', trigger: { method: 'PATCH', path: '/budgets/{id}' } },
    ];
    const entries = budgets.operations.map(operation => ({
      id: operation.entry_point_id, source_node: operation.entry_point_id, type: 'http',
      name: operation.action, interaction_reach: 'external', trigger: operation.trigger,
    })) as any;
    const budget = entity('entity_budget', 'Budget', 'persisted-entity', true);

    const [documented] = classifyCapabilityEvidence(
      [budgets], [budget], { productDocSummary: 'Users review and adjust budgets for household spending.' },
      { entryPoints: entries },
    );
    const [undocumented] = classifyCapabilityEvidence([budgets], [budget], undefined, { entryPoints: entries });

    expect(documented.evidence_role).toBe('product-outcome');
    expect(documented.evidence_role_reasons).toContain('user-facing-lifecycle-breadth');
    expect(undocumented.evidence_role).toBe('unresolved');
  });

  test('does not promote an internal lifecycle or a generated behavior-surface family', () => {
    const internal = candidate('cache', 'Manage cache', 'supporting', ['Create', 'Delete']);
    internal.operations[0].trigger = { method: 'POST' };
    internal.operations[1].trigger = { method: 'DELETE' };
    const surface = { ...internal, id: 'surface', evidence_kind: 'behavior-surface' as const };
    surface.operations = surface.operations.map((operation, index) => ({
      ...operation,
      entry_point_id: `surface-${index}`,
      entry_point_type: 'http',
    }));

    const classified = classifyCapabilityEvidence([internal, surface], [], undefined, {
      entryPoints: surface.operations.map(operation => ({
        id: operation.entry_point_id,
        source_node: operation.entry_point_id,
        type: 'http',
        name: operation.action,
        interaction_reach: 'external',
        trigger: operation.trigger,
      })) as any,
    });

    expect(classified.map(item => item.evidence_role)).toEqual([
      'supporting-mechanism',
      'supporting-mechanism',
    ]);
  });
});

describe('shell executable evidence roles', () => {
  test('does not promote a filesystem executable without product command registration', () => {
    const shell = candidate('report-export', 'Export reports', 'core', ['Export']);
    shell.operations[0].entry_point_id = 'shell-entry';
    shell.operations[0].entry_point_type = 'cli';
    const [classified] = classifyCapabilityEvidence([shell], [], { productDocSummary: 'Users export reports.' }, {
      entryPoints: [{
        id: 'shell-entry', source_node: 'shell-file', source_analyzer: 'shell', type: 'cli', name: 'Shell script: export',
        metadata: { source_analyzer: 'shell', cli_origin: 'filesystem-executable', cli_product_role: 'supporting-mechanism' },
      }],
      userJourneys: [{
        id: 'shell-journey', name: 'Export reports', journey_kind: 'user-facing', entry_point_id: 'shell-entry',
        entry: { type: 'cli', name: 'export' }, steps: [], terminal_effects: { entities_written: [], entities_read: [], external_services: ['storage'], messages_emitted: [] },
        terminal_entities: [], security_boundaries: [], tests_covering: [], criticality: 'medium', call_chain_ids: [], exit_point_ids: [],
      }],
    });
    expect(classified.evidence_role).toBe('supporting-mechanism');
    expect(classified.evidence_role_reasons).toEqual(['filesystem-executable-without-product-command-registration']);
  });
});



describe("catalog coverage synchronization", () => {
  test("preserves a provider deadline state without converting a capability quota into rejection", () => {
    const purpose = {
      capability_catalog_coverage: {
        evidence_families: 7,
        product_evidence_candidates: 7,
        supporting_evidence_candidates: 0,
        verification_evidence_candidates: 0,
        unresolved_evidence_candidates: 0,
        candidate_dispositions: [],
        actual_publishable_capabilities: 4,
        published_capabilities: 0,
        minimum_published_capabilities: 5,
        status: "unavailable" as const,
        reason: "ai-catalog-hard-deadline-exceeded: catalog omitted cap_chat",
      },
    } as any;
    synchronizeCapabilityCatalogCoverage(purpose, 0, 0);
    expect(purpose.capability_catalog_coverage.status).toBe("unavailable");
    expect(purpose.capability_catalog_coverage.reason).toBe("ai-catalog-hard-deadline-exceeded: catalog omitted cap_chat");
    expect(purpose.ai_phase_status).toBe("degraded");
  });
});


test('uses verified flow dependency subjects when grounding an outcome name', () => {
  const rules = candidate('rules', 'Rules', 'core', ['Update']);
  rules.related_entities = ['entity_rule'];
  rules.depends_on = [{
    from_capability: 'bulk-transactions', to_capability: 'rules', dependency_type: 'shares-data', strength: 'common',
    evidence: { shared_services: [], shared_nodes: [], shared_entities: ['Rule', 'Transaction', 'Category'] },
    description: 'Bulk transaction updates share rule and category data',
  }];

  expect(capabilityEvidenceSubjectTokens(rules)).toEqual(expect.arrayContaining(['rule', 'transaction', 'category']));
});
