import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildProductMap } from './product-map';
import type { CASOutput } from '../../types/cas.types';

// Regression coverage for the recurring customer-visible defect: capabilities
// reporting tests_present:false while journeys in the SAME response (and
// health.tests) carry real, nonzero test counts. Two prior fixes addressed
// the ANALYZER side (tagging test-file nodes with metadata.is_test across Go
// then seven more languages) but never locked in the CONSUMER side —
// product-map.ts's buildCapabilities, which derives capability tests_present
// from linked journeys' tests_covering, not from the analyzer tags directly.
// Without a test here the same contradiction can regress silently a third
// time even when every analyzer keeps tagging tests correctly.

function baseCas(overrides: Partial<CASOutput> = {}): CASOutput {
  return {
    nodes: [],
    edges: [],
    system: { name: 'test-system' },
    ...overrides,
  } as unknown as CASOutput;
}

test('capability tests_present is true when its own entry point backs a tested journey (structural match)', () => {
  const cas = baseCas({
    capabilities: [
      {
        id: 'cap1',
        name: 'Feed Ingestion',
        description: 'Fetches and stores feed items.',
        category: 'core',
        criticality: 'high',
        operations: [{ entry_point_id: 'ep1', entry_point_type: 'http', action: 'get' }],
        related_entities: [],
      },
    ],
    entities: [],
    entry_point_flows: [
      {
        id: 'journey_ep1',
        name: 'Fetch Feed',
        flow_kind: 'user-facing',
        entry_point_id: 'ep1',
        entry: { type: 'http', name: 'GET /feed' },
        steps: [],
        terminal_effects: { entities_written: [], entities_read: [], external_services: [], messages_emitted: [] },
        terminal_entities: [],
        security_boundaries: [],
        tests_covering: ['test_fetch_feed'],
        risk: 'low',
        criticality: 'high',
        call_chain_ids: [],
        exit_point_ids: [],
      },
    ],
  } as any);

  const map = buildProductMap(cas);
  assert.equal(map.capabilities.length, 1);
  assert.equal(map.capabilities[0].tests_present, true);
});

test('capability tests_present is true from a READ-only journey that touches one of its entities (widened entity-touch evidence)', () => {
  // This is the false-negative this fix closes: entryPointFlowPrimaryEntityNames only
  // returns an entity a journey WRITES, falling back to reads only when the
  // journey has zero writes anywhere. A capability's own operations may not
  // literally be the entry point a read-only test exercises (e.g. an
  // integration test hitting the handler through a different registered
  // route, or a table-driven unit test calling the handler directly) — in
  // that case the ONLY link back to the capability is the shared entity, and
  // the strict "primary produced entity" attribution used for the capability's
  // displayed `journeys` list is too narrow for the boolean tests_present
  // signal.
  const cas = baseCas({
    capabilities: [
      {
        id: 'cap1',
        name: 'API Key Management',
        description: 'Issues and manages API keys.',
        category: 'core',
        criticality: 'high',
        operations: [{ entry_point_id: 'ep_create', entry_point_type: 'http', action: 'post' }],
        related_entities: ['entity_apikey'],
      },
    ],
    entities: [{ id: 'entity_apikey', name: 'APIKey' } as any],
    entry_point_flows: [
      {
        id: 'journey_list',
        name: 'List API Keys',
        flow_kind: 'user-facing',
        entry_point_id: 'ep_list', // deliberately NOT one of the capability's own operations
        entry: { type: 'http', name: 'GET /api-keys' },
        steps: [],
        terminal_effects: { entities_written: [], entities_read: ['APIKey'], external_services: [], messages_emitted: [] },
        terminal_entities: [{ name: 'APIKey', access: 'read' }],
        security_boundaries: [],
        tests_covering: ['test_list_api_keys'],
        risk: 'low',
        criticality: 'medium',
        call_chain_ids: [],
        exit_point_ids: [],
      },
    ],
  } as any);

  const map = buildProductMap(cas);
  assert.equal(map.capabilities[0].tests_present, true);
});

test('capability tests_present stays false (honest) when no journey has any real test evidence', () => {
  const cas = baseCas({
    capabilities: [
      {
        id: 'cap1',
        name: 'Feed Ingestion',
        description: 'x',
        category: 'core',
        criticality: 'high',
        operations: [{ entry_point_id: 'ep1', entry_point_type: 'http', action: 'get' }],
        related_entities: [],
      },
    ],
    entities: [],
    entry_point_flows: [
      {
        id: 'journey_ep1',
        name: 'Fetch Feed',
        flow_kind: 'user-facing',
        entry_point_id: 'ep1',
        entry: { type: 'http', name: 'GET /feed' },
        steps: [],
        terminal_effects: { entities_written: [], entities_read: [], external_services: [], messages_emitted: [] },
        terminal_entities: [],
        security_boundaries: [],
        tests_covering: [],
        risk: 'low',
        criticality: 'high',
        call_chain_ids: [],
        exit_point_ids: [],
      },
    ],
  } as any);

  const map = buildProductMap(cas);
  assert.equal(map.capabilities[0].tests_present, false);
});

// THE CROSS-SURFACE INVARIANT (the fix the task called for beyond the
// individual bug): capabilities, journeys, and health.tests must never
// contradict each other in the same product_map response. Concretely: if a
// journey structurally or evidentially tied to a capability carries real
// tests_covering, that capability's tests_present must be true, and
// health.tests.total must be consistent with test_summary. This is the guard
// that makes a THIRD regression of this exact customer-visible contradiction
// impossible to land silently.
test('INVARIANT: tests_present never contradicts journeys.tests or health.tests in the same product_map', () => {
  const cas = baseCas({
    test_summary: {
      total_tests: 1151,
      by_status: { passing: 1151, failing: 0, skipped: 0 },
      coverage: { overall_percentage: 0 },
    } as any,
    capabilities: [
      {
        id: 'cap1',
        name: 'Feed Ingestion',
        description: 'x',
        category: 'core',
        criticality: 'high',
        operations: [{ entry_point_id: 'ep1', entry_point_type: 'http', action: 'get' }],
        related_entities: ['entity_feed'],
      },
      {
        id: 'cap2',
        name: 'Navigation Metadata',
        description: 'y',
        category: 'supporting',
        criticality: 'medium',
        operations: [{ entry_point_id: 'ep2', entry_point_type: 'http', action: 'get' }],
        related_entities: [],
      },
    ],
    entities: [{ id: 'entity_feed', name: 'Feed' } as any],
    entry_point_flows: [
      {
        id: 'journey_ep1',
        name: 'Fetch Feed',
        flow_kind: 'user-facing',
        entry_point_id: 'ep1',
        entry: { type: 'http', name: 'GET /feed' },
        steps: [],
        terminal_effects: { entities_written: ['Feed'], entities_read: [], external_services: [], messages_emitted: [] },
        terminal_entities: [{ name: 'Feed', access: 'write' }],
        security_boundaries: [],
        tests_covering: Array.from({ length: 21 }, (_, i) => `test_${i}`),
        risk: 'low',
        criticality: 'high',
        call_chain_ids: [],
        exit_point_ids: [],
      },
      {
        id: 'journey_ep2',
        name: 'Get Nav Metadata',
        flow_kind: 'user-facing',
        entry_point_id: 'ep2',
        entry: { type: 'http', name: 'GET /nav' },
        steps: [],
        terminal_effects: { entities_written: [], entities_read: [], external_services: [], messages_emitted: [] },
        terminal_entities: [],
        security_boundaries: [],
        tests_covering: [], // genuinely untested journey — must stay honest
        risk: 'low',
        criticality: 'medium',
        call_chain_ids: [],
        exit_point_ids: [],
      },
    ],
  } as any);

  const map = buildProductMap(cas);

  const capByName = new Map(map.capabilities.map(c => [c.name, c]));
  const entryPointFlowByName = new Map(map.entry_point_flows.top.map(j => [j.name, j]));

  // A capability structurally anchored on a real-tests journey must agree
  // with that journey's own reported test count.
  assert.equal(capByName.get('Feed Ingestion')!.tests_present, true);
  assert.ok((entryPointFlowByName.get('Fetch Feed')?.tests ?? 0) > 0);

  // health.tests must reflect test_summary regardless of journey/capability
  // linkage — this is the field the customer report showed as 1151 passing
  // while every capability said tests_present:false.
  assert.equal(map.health.tests.total, 1151);
  assert.equal(map.health.tests.passing, 1151);

  // An honestly-untested capability must stay false — the invariant is
  // "never contradict real evidence", not "always report true".
  assert.equal(capByName.get('Navigation Metadata')!.tests_present, false);
});

// Regression for the JVM/MockMvc-shaped contradiction found on
// spring-petclinic-microservices (a real Java Spring repo, 8 genuine JUnit
// test classes): orient_capsule.dimensions.tests (get_test_summary, backed by
// cas.test_suites) correctly reported 8, while product_map.health.tests
// reported 0/0/0 and every capability reported tests_present:false —
// four surfaces, two answers, from one CAS. Root cause: TestFrameworkAnalyzer
// only wires `tests`/`covers` EDGES when it can trace a literal call from
// test code to production code; a MockMvc-style black-box test never makes
// that call (it dispatches through the framework), so `journey.tests_covering`
// stays empty even though a real *Test.java file exists and JavaAnalyzer
// tagged its methods `category: 'test'`. cas.test_suites (buildTestSuites'
// multi-fallback discovery, the same thing get_test_summary reads) still
// finds it via file-naming convention. This test locks in that both
// buildTestSummary (health.tests) and buildCapabilities (tests_present) now
// derive from that same evidence instead of edges alone.
test('INVARIANT: file-adjacency test evidence (no traced call edge) still satisfies tests_present, matching cas.test_suites', () => {
  const cas = baseCas({
    nodes: [
      { id: 'ep1_node', type: 'controller', name: 'VetResource', source: { file: 'src/main/java/.../VetResource.java', line: 1 } },
    ],
    test_suites: [
      {
        id: 'suite_vet_resource_test',
        name: 'VetResourceTest',
        file_path: 'src/test/java/.../VetResourceTest.java',
        test_type: 'integration',
        framework: 'junit',
        tests: [
          {
            id: 'test_should_get_a_list_of_vets',
            name: 'shouldGetAListOfVets',
            test_type: 'integration',
            status: { skipped: false, focused: false, flaky: false },
            source: { file: 'src/test/java/.../VetResourceTest.java', line: 49 },
          },
        ],
      },
    ],
    capabilities: [
      {
        id: 'cap1',
        name: 'View Vet Information',
        description: 'x',
        category: 'supporting',
        criticality: 'medium',
        operations: [{ entry_point_id: 'ep1', entry_point_type: 'http', action: 'get' }],
        related_entities: [],
      },
    ],
    entities: [],
    entry_point_flows: [
      {
        id: 'journey_ep1',
        name: 'Vets',
        flow_kind: 'user-facing',
        entry_point_id: 'ep1',
        entry: { type: 'http', name: 'GET /vets', handler_node_id: 'ep1_node' },
        steps: [],
        terminal_effects: { entities_written: [], entities_read: [], external_services: [], messages_emitted: [] },
        terminal_entities: [],
        security_boundaries: [],
        tests_covering: [], // no traced call edge — the MockMvc case
        risk: 'low',
        criticality: 'medium',
        call_chain_ids: [],
        exit_point_ids: [],
      },
    ],
  } as any);

  const map = buildProductMap(cas);
  assert.equal(map.capabilities[0].tests_present, true);
});

// Measured live 2026-08-10 on a 92,582-node repo (v1.0.143): 7 of 8 capabilities
// reported tests_present:false while the SAME analysis reported health.tests
// 12,632 passing — and 6 of those 8 had zero linked journeys. Every path to
// `true` was ultimately `journeys.some(...)`, so "no journey reached this
// capability" silently rendered as "this capability has no tests". A false
// negative here is worse than an unknown: a customer reads it as a finding and
// concludes the code is unsafe to change.
//
// Paired, both directions — matching stem must pass, non-matching must NOT, so
// the fix cannot degenerate into "assume tested".
test('capability tests_present is true from its OWN operations when NO journey links to it', () => {
  const cas = baseCas({
    nodes: [
      { id: 'handler1', type: 'method', name: 'pollFeeds', source: { file: 'src/feed/poller.ts' } },
    ],
    entry_points: [
      { id: 'ep-orphan', type: 'schedule', name: 'poll', source_node: 'handler1', handler: { node_id: 'handler1' } },
    ],
    // Deliberately empty: this is the shape that used to force a false negative.
    entry_point_flows: [],
    test_suites: [
      { name: 'poller', file_path: 'src/feed/poller.test.ts', tests: [] },
    ],
    capabilities: [
      {
        id: 'cap-orphan',
        name: 'Ingest Feeds On A Schedule',
        description: 'Periodically fetches new feed items so readers see fresh content.',
        category: 'core',
        criticality: 'high',
        operations: [{ entry_point_id: 'ep-orphan', entry_point_type: 'schedule', action: 'poll' }],
        related_entities: [],
      },
    ],
    entities: [],
  });
  const map = buildProductMap(cas);
  const capability = map.capabilities.find(entry => entry.name === 'Ingest Feeds On A Schedule');
  assert.ok(capability, 'capability should be present');
  assert.equal(capability!.entry_point_flows.length, 0, 'precondition: no journey links to this capability');
  assert.equal(
    capability!.tests_present,
    true,
    'a capability whose own entry-point file has a sibling test suite is tested, journey or not',
  );
});

test('capability tests_present stays false when no test suite matches its own operation files', () => {
  const cas = baseCas({
    nodes: [
      { id: 'handler2', type: 'method', name: 'sweep', source: { file: 'src/sweep/runner.ts' } },
    ],
    entry_points: [
      { id: 'ep-untested', type: 'schedule', name: 'sweep', source_node: 'handler2', handler: { node_id: 'handler2' } },
    ],
    entry_point_flows: [],
    // A real suite exists, but for UNRELATED code — the stem must not match.
    test_suites: [
      { name: 'poller', file_path: 'src/feed/poller.test.ts', tests: [] },
    ],
    capabilities: [
      {
        id: 'cap-untested',
        name: 'Sweep Expired Sessions',
        description: 'Removes sessions that have passed their expiry so stale access ends.',
        category: 'supporting',
        criticality: 'medium',
        operations: [{ entry_point_id: 'ep-untested', entry_point_type: 'schedule', action: 'sweep' }],
        related_entities: [],
      },
    ],
    entities: [],
  });
  const map = buildProductMap(cas);
  const capability = map.capabilities.find(entry => entry.name === 'Sweep Expired Sessions');
  assert.ok(capability, 'capability should be present');
  assert.equal(
    capability!.tests_present,
    false,
    'evidence-gated: an unrelated test suite must not make this capability look tested',
  );
});

test('product map excludes entity-overlap-only journeys from every capability sharing a structural entity', () => {
  const relationship = (capability_id: string) => ({
    capability_id,
    role: 'supporting',
    rationale: 'shared structural entity',
    evidence: 'entity-overlap',
  });
  const cas = baseCas({
    capabilities: [
      {
        id: 'inspect', name: 'Inspect software behavior', description: 'Shows software behavior to reviewers.',
        category: 'core', criticality: 'high', operations: [], related_entities: ['entity_graph'],
      },
      {
        id: 'runtime', name: 'Correlate runtime evidence', description: 'Connects runtime observations to static structure.',
        category: 'core', criticality: 'high', operations: [], related_entities: ['entity_graph'],
      },
    ],
    entities: [{ id: 'entity_graph', name: 'SoftwareGraph' } as any],
    entry_point_flows: [{
      id: 'journey_health', name: 'Check health', flow_kind: 'user-facing', entry_point_id: 'health',
      entry: { type: 'message', name: 'health' }, steps: [],
      terminal_effects: { entities_written: [], entities_read: ['SoftwareGraph'], external_services: [], messages_emitted: [] },
      terminal_entities: [{ name: 'SoftwareGraph', access: 'read' }], security_boundaries: [], tests_covering: [],
      risk: 'low', criticality: 'medium', call_chain_ids: [], exit_point_ids: [],
      capability_relationships: [relationship('inspect'), relationship('runtime')],
    }],
  } as any);

  const map = buildProductMap(cas);
  assert.deepEqual(map.capabilities.map(capability => capability.entry_point_flows), [[], []]);
});

test('product map keeps direct operation relationships and uniquely owned entity fallbacks', () => {
  const cas = baseCas({
    capabilities: [
      {
        id: 'agent', name: 'Ground agents in code context', description: 'Returns grounded code context to software agents.',
        category: 'core', criticality: 'high',
        operations: [{ entry_point_id: 'agent_context', entry_point_type: 'message', action: 'Get context' }],
        related_entities: ['entity_context'],
      },
    ],
    entities: [{ id: 'entity_context', name: 'AgentContext' } as any],
    entry_point_flows: [
      {
        id: 'journey_agent', name: 'Get agent context', flow_kind: 'user-facing', entry_point_id: 'agent_context',
        entry: { type: 'message', name: 'get_agent_context' }, steps: [],
        terminal_effects: { entities_written: [], entities_read: [], external_services: [], messages_emitted: [] },
        terminal_entities: [], security_boundaries: [], tests_covering: [], risk: 'low', criticality: 'high',
        call_chain_ids: [], exit_point_ids: [],
      },
      {
        id: 'journey_context_read', name: 'Review context', flow_kind: 'user-facing', entry_point_id: 'review_context',
        entry: { type: 'page', name: 'review_context' }, steps: [],
        terminal_effects: { entities_written: [], entities_read: ['AgentContext'], external_services: [], messages_emitted: [] },
        terminal_entities: [{ name: 'AgentContext', access: 'read' }], security_boundaries: [], tests_covering: [],
        risk: 'low', criticality: 'medium', call_chain_ids: [], exit_point_ids: [],
      },
    ],
  } as any);

  const map = buildProductMap(cas);
  assert.deepEqual(map.capabilities[0].entry_point_flows.map(journey => journey.id), ['journey_agent', 'journey_context_read']);
});

test('product map reuses a supplied canonical entry-point flow projection', () => {
  const projection = {
    entryPointFlows: [{
      id: 'entry_point_flow_canonical',
      name: 'Reach a verified outcome',
      flow_kind: 'user-facing',
      entry_point_id: 'entry_canonical',
      entry: { type: 'http', name: 'POST /outcome' },
      steps: [],
      terminal_effects: { entities_written: [], entities_read: [], external_services: [], messages_emitted: [] },
      terminal_entities: [],
      security_boundaries: [],
      tests_covering: [],
      risk: 'low',
      criticality: 'high',
      call_chain_ids: [],
      exit_point_ids: [],
    }],
    summary: { total_discovered: 1, included: 1, by_kind: { 'user-facing': 1, system: 0, scheduled: 0 } },
  } as any;

  const map = buildProductMap(baseCas(), projection);
  assert.equal(map.entry_point_flows.total, 1);
  assert.equal(map.entry_point_flows.top[0]?.id, 'entry_point_flow_canonical');
});

test('product map keeps entry-point flows and journeys chained from flows as separate sections', () => {
  const base = { cas_version: '1.11.0', system: { name: 'x', type: 'application' }, nodes: [], edges: [], entry_points: [], exit_points: [] } as unknown as CASOutput;
  const withoutEntryPointFlows = buildProductMap(base);
  assert.equal(withoutEntryPointFlows.journeys.total, 0);
  assert.equal(withoutEntryPointFlows.entry_point_flows.total, 0);
  const withEntryPointFlows = buildProductMap({
    ...base,
    entry_points: [{ id: 'e1', type: 'ui', name: 'send' }, { id: 'e2', type: 'ipc', name: 'deliver' }],
    flows: ['f1', 'f2'].map((id, at) => ({
      flow_id: id, name: `Flow ${id}`, intent: id, entry_point: `e${at + 1}`, entities: [],
      contract: { input: [], logic: id, side_effects: { state_changes: [], external_integrations: [] }, output: [], constraints: [] },
      steps: [{ step_id: `${id}:1`, order: 1, name: 'step', description: 'step', functions: [], entities: [] }],
    })),
    communication_seams: { seams: [{ id: 's1', modality: 'sync', confidence: 1, kind: 'exit_point', source: 'a', target: 'b', evidence: '', summary: '', metadata: { via: 'ipc', from_flow: 'f1', to_flow: 'f2' } }] },
  } as unknown as CASOutput);
  assert.equal(withEntryPointFlows.journeys.total, 1);
  assert.equal(withEntryPointFlows.journeys.shown, 1);
  assert.equal(withEntryPointFlows.journeys.top[0].flows, 2);
  assert.equal(withEntryPointFlows.journeys.top[0].programs, 2);
  assert.equal(withEntryPointFlows.journeys.top.some(journey => withEntryPointFlows.entry_point_flows.top.some(flow => flow.id === journey.id)), false);
});
