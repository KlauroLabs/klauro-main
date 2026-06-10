import { buildProductMap } from '../../analyzer/core/product-map';
import {
  CASOutput,
  CASUserJourney,
  SystemCapability,
  CASEntityLineage,
  CASParadigmConformance,
} from '../../types/cas.types';

function journey(overrides: Partial<CASUserJourney> & { id: string; name: string }): CASUserJourney {
  return {
    journey_kind: 'user-facing',
    entry_point_id: `entry_${overrides.id}`,
    entry: { type: 'http', name: overrides.name },
    steps: [],
    terminal_effects: { entities_written: [], entities_read: [], external_services: [], messages_emitted: [] },
    terminal_entities: [],
    security_boundaries: [],
    tests_covering: [],
    criticality: 'medium',
    call_chain_ids: [],
    exit_point_ids: [],
    ...overrides,
  } as CASUserJourney;
}

const capabilities: SystemCapability[] = [
  {
    id: 'cap_billing',
    name: 'Billing',
    description: 'Charges customers and records payments.',
    description_source: 'ai',
    category: 'core',
    operations: [
      { entry_point_id: 'entry_j_charge', entry_point_type: 'http', action: 'create' },
    ],
    related_entities: ['Payment'],
    related_domains: ['billing'],
    criticality: 'critical',
    criticality_factors: ['handles money'],
  },
  {
    id: 'cap_reporting',
    name: 'Reporting',
    description: 'Generates usage reports.',
    category: 'supporting',
    operations: [],
    related_entities: ['Report'],
    related_domains: ['reporting'],
    criticality: 'low',
    criticality_factors: [],
  },
];

const journeys: CASUserJourney[] = [
  journey({
    id: 'j_charge',
    name: 'Charge customer',
    entry_point_id: 'entry_j_charge',
    criticality: 'critical',
    tests_covering: ['test_charge'],
    security_boundaries: [{ name: 'AuthGuard', mechanism: 'guard' }],
    terminal_entities: [{ name: 'Payment', access: 'created', terminal_kind: 'entity' }],
  }),
  journey({
    id: 'j_refund',
    name: 'Refund payment',
    criticality: 'high',
    terminal_entities: [{ name: 'Payment', access: 'updated', terminal_kind: 'entity' }],
  }),
  journey({
    id: 'j_report',
    name: 'Nightly report job',
    journey_kind: 'scheduled',
    criticality: 'low',
    terminal_effects: { entities_written: ['Report'], entities_read: [], external_services: [], messages_emitted: [] },
  }),
];

const lineage: CASEntityLineage[] = [
  {
    entity_id: 'entity_payment',
    entity_name: 'Payment',
    sensitive_fields: ['card_number'],
    writers: [],
    readers: [],
    external_recipients: [{ exit_point_id: 'exit_stripe', service: 'stripe' }],
    boundaries_crossed: [],
    journeys_carrying: ['j_charge'],
    exposure: { unguarded_paths: 1, external_transfer: true, sensitive: true },
  },
  {
    entity_id: 'entity_report',
    entity_name: 'Report',
    sensitive_fields: [],
    writers: [],
    readers: [],
    external_recipients: [],
    boundaries_crossed: [],
    journeys_carrying: [],
    exposure: { unguarded_paths: 0, external_transfer: false, sensitive: false },
  },
];

const paradigms: CASParadigmConformance[] = [
  {
    paradigm: 'service-mediated-data-access',
    description: 'Entry points reach entities through services.',
    adoption: { following_count: 18, comparable_count: 20, adoption_rate: 0.9, evidence_files: [] },
    deviations: [
      {
        file: 'src/reports/reports.controller.ts',
        node_id: 'n_reports_controller',
        kind: 'direct-entity-access' as any,
        detail: 'Controller reads Payment directly.',
        severity: 'warning',
      },
    ],
  },
];

const fullCas = {
  system: {
    id: 'sys',
    name: 'acme-billing',
    type: 'application',
    root_path: '/tmp/acme',
    technologies: {
      unanalyzed_languages: [{ name: 'Ruby', files: 12, share_of_source: 0.3 }],
    },
  },
  nodes: [],
  edges: [],
  analyzer_contributions: [],
  progressive_levels: {} as any,
  enhanced_system_purpose: {
    primary_domain: 'billing',
    domain_source: 'deterministic',
    core_concepts: ['payment'],
    inferred_description: 'A billing platform for charging customers.',
    description_source: 'ai',
    supporting_workflow_ids: [],
  },
  system_capabilities: capabilities,
  user_journeys: journeys,
  user_journey_summary: {
    total_discovered: 5,
    included: 3,
    by_kind: { 'user-facing': 2, system: 0, scheduled: 1 },
  },
  data_lineage: lineage,
  paradigm_conformance: paradigms,
  implementation_health: {
    complete_implementations: 40,
    partial_implementations: 2,
    stubs: 1,
    not_implemented: 0,
    deprecated: 0,
    experimental: 0,
    health_score: 88,
    risk_areas: [
      {
        node_id: 'n_refund',
        node_name: 'refundPayment',
        risk_type: 'incomplete',
        risk_level: 'high',
        recommendation: 'Finish refund flow.',
      },
    ],
  },
  system_health: {
    score: 81,
    status: 'watch',
    summary: 'Mostly healthy.',
    risk_areas: [],
    coherence: {
      status: 'coherent',
      paradigm_count: 1,
      primary_paradigms: ['service-mediated-data-access'],
      conflicting_paradigms: [],
      naming_convention_violations: 0,
      dependency_injection_violations: 0,
      module_boundary_violations: 0,
      duplication_signals: 0,
    },
    remediation: { immediate: [], agent_rules: [], validation_tools: [] },
  },
  test_summary: {
    total_tests: 25,
    by_type: { unit: 20, integration: 5, e2e: 0, acceptance: 0, bdd: 0, other: 0 },
    by_status: { passing: 24, failing: 1, skipped: 0, flaky: 0 },
    coverage: { overall_percentage: 72 },
    mocks: { total: 3 },
    fixtures: { total: 2 },
  },
} as unknown as CASOutput;

describe('buildProductMap', () => {
  const map = buildProductMap(fullCas);

  it('composes identity with provenance passthrough', () => {
    expect(map.identity.name).toBe('acme-billing');
    expect(map.identity.domain).toBe('billing');
    expect(map.identity.domain_source).toBe('deterministic');
    expect(map.identity.description).toBe('A billing platform for charging customers.');
    expect(map.identity.description_source).toBe('ai');
    expect(map.identity.unanalyzed_languages).toEqual([{ name: 'Ruby', files: 12, share_of_source: 0.3 }]);
  });

  it('orders capabilities by criticality and carries description provenance', () => {
    expect(map.capabilities.map(capability => capability.name)).toEqual(['Billing', 'Reporting']);
    expect(map.capabilities[0].description_source).toBe('ai');
    expect(map.capabilities[1].description_source).toBe('deterministic');
  });

  it('links capabilities to journeys via entry points and shared terminal entities', () => {
    const billing = map.capabilities[0];
    expect(billing.journeys.map(linked => linked.id)).toEqual(['j_charge', 'j_refund']);
    expect(billing.entities).toEqual(['Payment']);

    const reporting = map.capabilities[1];
    expect(reporting.journeys.map(linked => linked.id)).toEqual(['j_report']);
  });

  it('derives tests_present and risk_level from linked journeys', () => {
    const billing = map.capabilities[0];
    expect(billing.tests_present).toBe(true);
    expect(billing.risk_level).toBe('low');

    const reporting = map.capabilities[1];
    expect(reporting.tests_present).toBe(false);
    expect(reporting.risk_level).toBe('medium');
  });

  it('summarizes journeys with top entries by criticality', () => {
    expect(map.journeys.total).toBe(5);
    expect(map.journeys.user_facing).toBe(2);
    expect(map.journeys.scheduled).toBe(1);
    expect(map.journeys.top[0]).toMatchObject({
      id: 'j_charge',
      kind: 'user-facing',
      boundaries: ['AuthGuard'],
      tests: 1,
    });
  });

  it('surfaces sensitive entities and exposure highlights', () => {
    expect(map.data.entities).toBe(2);
    expect(map.data.sensitive).toEqual(['Payment']);
    expect(map.data.exposure_highlights).toHaveLength(1);
    expect(map.data.exposure_highlights[0]).toMatchObject({
      entity: 'Payment',
      unguarded_paths: 1,
      external_transfer: true,
      external_recipients: ['stripe'],
    });
  });

  it('reports paradigm adoption and open deviation counts by severity', () => {
    expect(map.conventions.paradigms).toEqual([
      expect.objectContaining({ paradigm: 'service-mediated-data-access', adoption_rate: 0.9 }),
    ]);
    expect(map.conventions.open_deviations).toEqual({ error: 0, warning: 1, info: 0 });
  });

  it('composes health from tests, implementation health, and system health', () => {
    expect(map.health.status).toBe('watch');
    expect(map.health.score).toBe(81);
    expect(map.health.tests).toMatchObject({ total: 25, passing: 24, failing: 1, coverage_percentage: 72 });
    expect(map.health.implementation).toMatchObject({ complete: 40, partial: 2, stubs: 1 });
    expect(map.health.top_risks).toEqual([
      { name: 'refundPayment', level: 'high', type: 'incomplete', recommendation: 'Finish refund flow.' },
    ]);
  });

  it('surfaces coverage caveats for unanalyzed languages and truncated journeys', () => {
    expect(map.coverage_caveats).toContain('Ruby not analyzed: 12 files (30% of source)');
    expect(map.coverage_caveats).toContain('5 journeys discovered, 3 included in detail');
  });
});

describe('buildProductMap with a minimal CAS', () => {
  const emptyCas = {
    system: { id: 'sys', name: 'bare', type: 'application', root_path: '/tmp/bare' },
    nodes: [],
    edges: [],
    analyzer_contributions: [],
    progressive_levels: {} as any,
  } as unknown as CASOutput;

  const map = buildProductMap(emptyCas);

  it('produces a graceful minimal map', () => {
    expect(map.identity).toMatchObject({
      name: 'bare',
      domain: 'unknown',
      domain_source: 'deterministic',
      description: '',
      description_source: 'deterministic',
      unanalyzed_languages: [],
    });
    expect(map.capabilities).toEqual([]);
    expect(map.journeys).toMatchObject({ total: 0, user_facing: 0, system: 0, scheduled: 0, top: [] });
    expect(map.data).toEqual({ entities: 0, sensitive: [], exposure_highlights: [] });
    expect(map.conventions).toEqual({
      paradigms: [],
      open_deviations: { error: 0, warning: 0, info: 0 },
    });
    expect(map.health.tests.total).toBe(0);
    expect(map.health.top_risks).toEqual([]);
  });

  it('flags missing tests and lineage as coverage caveats', () => {
    expect(map.coverage_caveats).toContain('No tests detected; test coverage signals are unavailable');
    expect(map.coverage_caveats).toContain('No data lineage derived; data exposure signals are unavailable');
  });
});
