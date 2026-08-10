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
    system_capabilities: [
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
    data_entities: [],
    user_journeys: [
      {
        id: 'journey_ep1',
        name: 'Fetch Feed',
        journey_kind: 'user-facing',
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
  // This is the false-negative this fix closes: journeyPrimaryEntityNames only
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
    system_capabilities: [
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
    data_entities: [{ id: 'entity_apikey', name: 'APIKey' } as any],
    user_journeys: [
      {
        id: 'journey_list',
        name: 'List API Keys',
        journey_kind: 'user-facing',
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
    system_capabilities: [
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
    data_entities: [],
    user_journeys: [
      {
        id: 'journey_ep1',
        name: 'Fetch Feed',
        journey_kind: 'user-facing',
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
    system_capabilities: [
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
    data_entities: [{ id: 'entity_feed', name: 'Feed' } as any],
    user_journeys: [
      {
        id: 'journey_ep1',
        name: 'Fetch Feed',
        journey_kind: 'user-facing',
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
        journey_kind: 'user-facing',
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
  const journeyByName = new Map(map.journeys.top.map(j => [j.name, j]));

  // A capability structurally anchored on a real-tests journey must agree
  // with that journey's own reported test count.
  assert.equal(capByName.get('Feed Ingestion')!.tests_present, true);
  assert.ok((journeyByName.get('Fetch Feed')?.tests ?? 0) > 0);

  // health.tests must reflect test_summary regardless of journey/capability
  // linkage — this is the field the customer report showed as 1151 passing
  // while every capability said tests_present:false.
  assert.equal(map.health.tests.total, 1151);
  assert.equal(map.health.tests.passing, 1151);

  // An honestly-untested capability must stay false — the invariant is
  // "never contradict real evidence", not "always report true".
  assert.equal(capByName.get('Navigation Metadata')!.tests_present, false);
});
