import { strict as assert } from 'assert';
import { test } from 'node:test';
import * as fs from 'fs';
import * as path from 'path';
import type { CASEntryPointFlow } from '../../../packages/analyzer-core/src/types/cas.types';
import {
  compressEntryPointFlowSteps,
  displayEntryPointFlowSteps,
  humanizeIdentifier,
  entryPointFlowDetailMarkdown,
  entryPointFlowEffectPhrases,
  entryPointFlowGuardPhrase,
  entryPointFlowHeadline,
  entryPointFlowListMarkdown,
  entryPointFlowStepPhrase,
  entryPointFlowTestPhrase,
  entryPointFlowTitle,
  storedEntryPointFlowNameHeadline,
  storedEntryPointFlowNameParts,
} from './entry-point-flow-presentation';
import { getEntryPointFlows, productMapToMarkdown } from './query';
import { buildEntryPointFlowContextForAgent } from './agent-adoption';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const inspector = require('../scripts/create-analysis-inspector.js');

const fixturePath = path.join(__dirname, '..', 'fixtures', 'entry-point-flows', 'real-entry-point-flows.json');
const fixtures = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as Record<string, CASEntryPointFlow>;
const truckspy = fixtures.truckspy_create_company;
const washup = fixtures.washup_update_location_event;
const klauro = fixtures.klauro_delete_work_order;

test('humanizeIdentifier turns code identifiers into readable phrases', () => {
  assert.equal(humanizeIdentifier('createCompany'), 'create company');
  assert.equal(humanizeIdentifier('setCompanyStripeSource'), 'set company stripe source');
  assert.equal(humanizeIdentifier('validate_company_name'), 'validate company name');
  assert.equal(humanizeIdentifier('OrdersController#create'), 'create');
  assert.equal(humanizeIdentifier('CompanyManager'), 'company manager');
  assert.equal(humanizeIdentifier('parseJSONBody'), 'parse JSON body');
  assert.equal(humanizeIdentifier('PATCH /location_events/:id'), 'PATCH /location_events/:id');
});

test('entryPointFlowTitle strips outcome arrows and entry suffixes from stored names', () => {
  assert.equal(entryPointFlowTitle(truckspy), 'Create company');
  assert.equal(entryPointFlowTitle(washup), 'Update location event');
  assert.equal(entryPointFlowTitle(klauro), 'Delete work order');
});

test('entryPointFlowHeadline reads as a single narrative line with entry, outcome, and facts', () => {
  const headline = entryPointFlowHeadline(truckspy);
  assert.equal(
    headline,
    'Create company: POST /api/web/partner/companies -> creates Company, Partner; 24 steps, guarded (authorization: IsGranted), no auth guard, no tests'
  );
  assert.ok(!headline.includes('node_id'));
  assert.ok(!headline.includes('method_'));
});

test('entryPointFlowHeadline reports unguarded entryPointFlows and test counts', () => {
  assert.ok(entryPointFlowHeadline(klauro).includes('guarded (auth: require_auth)'));
  assert.ok(entryPointFlowHeadline(klauro).endsWith('1 test'));
  assert.equal(entryPointFlowGuardPhrase({ security_boundaries: [] }), 'unguarded');
  assert.equal(entryPointFlowTestPhrase({ tests_covering: [] }), 'no tests');
});

test('entryPointFlowGuardPhrase distinguishes guard kinds instead of conflating them with authentication', () => {
  assert.equal(
    entryPointFlowGuardPhrase({ security_boundaries: [{ name: 'ThrottlerGuard', mechanism: 'entry-guard' }] }),
    'rate-limited (ThrottlerGuard), no auth guard'
  );
  assert.equal(
    entryPointFlowGuardPhrase({ security_boundaries: [{ name: 'GlobalAuthGuard', mechanism: 'entry-guard' }] }),
    'guarded (auth: GlobalAuthGuard)'
  );
  assert.equal(
    entryPointFlowGuardPhrase({ security_boundaries: [
      { name: 'GlobalAuthGuard', mechanism: 'entry-guard' },
      { name: 'ThrottlerGuard', mechanism: 'entry-guard' },
    ] }),
    'guarded (auth: GlobalAuthGuard; rate-limited: ThrottlerGuard)'
  );
  assert.equal(
    entryPointFlowGuardPhrase({ security_boundaries: [
      { name: 'OrganizationGuard', mechanism: 'entry-guard' },
      { name: 'ThrottlerGuard', mechanism: 'entry-guard' },
    ] }),
    'guarded (authorization: OrganizationGuard; rate-limited: ThrottlerGuard), no auth guard'
  );
  assert.equal(
    entryPointFlowGuardPhrase({ security_boundaries: [{ name: 'MysteryGuard', mechanism: 'entry-guard' }] }),
    'guarded (MysteryGuard), no auth guard'
  );
});

test('entryPointFlowGuardPhrase prefers the stored boundary kind over name classification', () => {
  assert.equal(
    entryPointFlowGuardPhrase({ security_boundaries: [{ name: 'CustomGate', mechanism: 'entry-guard', kind: 'authentication' }] }),
    'guarded (auth: CustomGate)'
  );
  assert.equal(
    entryPointFlowGuardPhrase({ security_boundaries: [{ name: 'CustomGate', mechanism: 'entry-guard', kind: 'rate-limiting' }] }),
    'rate-limited (CustomGate), no auth guard'
  );
});

test('displayEntryPointFlowSteps drops entry-duplicate and consecutive-duplicate steps', () => {
  const steps = displayEntryPointFlowSteps(washup);
  const labels = steps.map(step => humanizeIdentifier(step.name));
  assert.ok(!labels.includes('PATCH /location_events/:id'), 'route step should not repeat the entry');
  assert.ok(labels.length < (washup.steps || []).length);
});

test('compressEntryPointFlowSteps keeps short chains intact and compresses long ones', () => {
  const short = compressEntryPointFlowSteps((klauro.steps || []));
  assert.equal(short.omitted, 0);
  assert.equal(short.leading.length, (klauro.steps || []).length);

  const long = compressEntryPointFlowSteps(truckspy.steps || []);
  assert.equal(long.leading.length, 3);
  assert.equal(long.trailing.length, 2);
  assert.equal(long.omitted, (truckspy.steps || []).length - 5);
});

test('entryPointFlowStepPhrase humanizes step names and marks omitted middles', () => {
  const phrase = entryPointFlowStepPhrase(truckspy);
  assert.ok(phrase.startsWith('create company -> company manager -> validate company name'));
  assert.ok(phrase.includes('intermediate steps)'));
  assert.ok(!phrase.includes('method_src_'));
});

test('entryPointFlowEffectPhrases renders terminal effects as short phrases, not JSON', () => {
  const phrases = entryPointFlowEffectPhrases(truckspy);
  assert.equal(phrases[0], 'writes Company, Partner');
  assert.ok(phrases[1].startsWith('reads Device, ModernSubscriptionQuantity'));
  assert.ok(phrases[1].includes('+2 more'));
});

test('entryPointFlowDetailMarkdown leads with title and headline and tucks provenance last', () => {
  const markdown = entryPointFlowDetailMarkdown(klauro);
  const lines = markdown.split('\n');
  assert.equal(lines[0], '## Delete work order');
  assert.ok(lines[2].startsWith('Delete work order: DELETE /work_orders/:id -> deletes WorkOrder'));
  assert.ok(markdown.includes('- Tests: 1 test'));
  assert.ok(lines[lines.length - 1].startsWith('_entry_point:'), 'provenance must be the last line');
  const provenanceIndex = markdown.indexOf('entry_point:');
  const stepsIndex = markdown.indexOf('- Steps');
  assert.ok(provenanceIndex > stepsIndex, 'provenance stays after the readable body');
});

test('entryPointFlowListMarkdown renders one headline per entryPointFlow with counts up front', () => {
  const markdown = entryPointFlowListMarkdown([truckspy, washup], { total: 2, offset: 0, byKind: { 'user-facing': 2, system: 0, scheduled: 0 } });
  assert.ok(markdown.startsWith('# Entry-point flows'));
  assert.ok(markdown.includes('2 entry-point flows (2 user-facing), showing 2.'));
  assert.ok(markdown.includes('- Create company: POST /api/web/partner/companies'));
  assert.ok(markdown.includes(`(id: ${washup.id})`));
});

test('storedEntryPointFlowNameParts splits the deterministic stored name format', () => {
  const parts = storedEntryPointFlowNameParts('Create company -> Company created (+7 more) (POST /api/web/partner/companies)');
  assert.equal(parts.title, 'Create company');
  assert.equal(parts.outcome, 'Company created +7 more');
  assert.equal(parts.entry, 'POST /api/web/partner/companies');
  assert.equal(
    storedEntryPointFlowNameHeadline('Create company -> Company created (+7 more) (POST /api/web/partner/companies)'),
    'Create company: POST /api/web/partner/companies -> Company created +7 more'
  );
  assert.equal(storedEntryPointFlowNameHeadline('Sync inventory'), 'Sync inventory');
});

test('storedEntryPointFlowNameParts handles intent-named frontend entryPointFlows with file-path provenance', () => {
  const parts = storedEntryPointFlowNameParts('View crypto assets table -> useConnectionHoldings (GET /dashboard/widgets/crypto-assets-table.tsx)');
  assert.equal(parts.title, 'View crypto assets table');
  assert.equal(parts.outcome, 'useConnectionHoldings');
  assert.equal(parts.entry, 'GET /dashboard/widgets/crypto-assets-table.tsx');
  assert.equal(storedEntryPointFlowNameParts('Update machine settings -> Machine updated').title, 'Update machine settings');
});

function casWithEntryPointFlows(): any {
  return {
    cas_version: '1.11.0',
    system: { name: 'fixture', type: 'service', root_path: '/repo/fixture' },
    nodes: [],
    edges: [],
    entry_points: [],
    exit_points: [],
    entry_point_flows: [truckspy, washup, klauro],
    entry_point_flow_summary: { total_discovered: 3, included: 3, by_kind: { 'user-facing': 3, system: 0, scheduled: 0 } },
  };
}

test('getEntryPointFlows list mode includes title and headline per entryPointFlow', () => {
  const result = getEntryPointFlows(casWithEntryPointFlows()) as any;
  assert.equal(result.entry_point_flows[0].title, 'Create company');
  assert.ok(result.entry_point_flows[0].headline.includes('creates Company, Partner'));
  assert.equal(result.entry_point_flows[0].name, truckspy.name, 'stored name stays available');
});

test('getEntryPointFlows list mode carries a compact source->sink path so no second detail call is needed', () => {
  const result = getEntryPointFlows(casWithEntryPointFlows()) as any;
  const item = result.entry_point_flows[0];
  // The reaching-chain (source=entry -> path=steps -> sink=terminal_entities) is
  // visible in the list item itself, matching the compression-bounded detail phrase.
  assert.equal(item.path, entryPointFlowStepPhrase(truckspy));
  assert.ok(item.path.startsWith('create company -> company manager -> validate company name'));
  // Token-bounded: long chains stay compressed, never the raw 24-step dump.
  assert.ok(item.path.includes('intermediate steps)'), 'long chains stay compressed in the list');
  assert.ok(!item.path.includes('method_src_'), 'raw node ids never leak into the path');
});

test('getEntryPointFlows list mode includes the step chain by default (no 2nd call needed)', () => {
  const result = getEntryPointFlows(casWithEntryPointFlows()) as any;
  const item = result.entry_point_flows[0];
  assert.ok(Array.isArray(item.steps), 'list item carries a steps array');
  assert.ok(item.steps.length > 0, 'steps array is non-empty for a entryPointFlow with steps');
  // Each compact step exposes exactly the fields needed to act on it further
  // (e.g. feed node_id into get_coding_context) without re-fetching detail.
  for (const step of item.steps) {
    assert.ok(step.node_id, 'each step carries its node_id');
    assert.ok(step.name, 'each step carries its name');
    assert.ok(step.layer, 'each step carries its layer');
    assert.equal(typeof step.depth, 'number', 'each step carries its depth');
  }
});

test('getEntryPointFlows list mode drops steps when include_steps is false', () => {
  const result = getEntryPointFlows(casWithEntryPointFlows(), { includeSteps: false }) as any;
  assert.equal(result.entry_point_flows[0].steps, undefined, 'steps omitted when explicitly opted out');
  // step_count and the compact path phrase remain available either way.
  assert.ok(result.entry_point_flows[0].step_count > 0);
  assert.ok(result.entry_point_flows[0].path);
});

test('getEntryPointFlows markdown mode renders a readable entryPointFlow brief', () => {
  const result = getEntryPointFlows(casWithEntryPointFlows(), { format: 'markdown' }) as any;
  assert.ok(result.markdown.startsWith('# Entry-point flows'));
  assert.ok(result.markdown.includes('- Create company: POST /api/web/partner/companies'));
  assert.ok(!result.markdown.includes('handler_node_id'));
});

test('getEntryPointFlows markdown detail renders the full readable entryPointFlow', () => {
  const result = getEntryPointFlows(casWithEntryPointFlows(), { flowId: klauro.id, format: 'markdown' }) as any;
  assert.ok(result.markdown.startsWith('## Delete work order'));
  assert.ok(result.markdown.includes('- Boundaries: require_auth (authentication, entry-guard)'));

  const missing = getEntryPointFlows(casWithEntryPointFlows(), { flowId: 'nope', format: 'markdown' }) as any;
  assert.ok(missing.markdown.includes("No entry-point flow with id 'nope'"));
});

test('getEntryPointFlows json detail keeps the full stored entryPointFlow plus presentation fields', () => {
  const result = getEntryPointFlows(casWithEntryPointFlows(), { flowId: truckspy.id }) as any;
  assert.equal(result.entry_point_flow.title, 'Create company');
  assert.ok(result.entry_point_flow.headline.length > 0);
  assert.equal(result.entry_point_flow.steps.length, (truckspy.steps || []).length, 'full chain stays available');
});

test('inspector entryPointFlow tab data carries title, headline, and compressed display steps', () => {
  const data = inspector.entryPointFlowData(casWithEntryPointFlows());
  const card = data.items[0];
  assert.equal(card.title, 'Create company');
  assert.equal(
    card.headline,
    'Create company: POST /api/web/partner/companies -> creates Company, Partner; 24 steps, guarded (authorization: IsGranted), no auth guard, no tests'
  );
  assert.equal(card.display_steps.leading.length, 3);
  assert.equal(card.display_steps.trailing.length, 2);
  assert.ok(card.display_steps.omitted > 0);
  assert.equal(card.display_steps.leading[0].label, 'create company');
  assert.ok(card.steps.every((step: any) => typeof step.label === 'string' && step.label.length > 0));
  assert.equal(card.name, truckspy.name, 'stored name stays available');
});

test('inspector rendered entryPointFlows tab shows the headline and intermediate-step marker', () => {
  const cas = casWithEntryPointFlows();
  const html = inspector.renderHtml({
    generated_at: new Date().toISOString(),
    analysis_count: 1,
    analyses: [inspector.buildAnalysisEntry(cas, { name: 'fixture', file: 'fixture.json', analyzed_at: new Date().toISOString() }, '/repo/fixture')],
  });
  assert.ok(html.includes('intermediate step'));
  assert.ok(html.includes('class="headline"'));
});

test('product map markdown renders entryPointFlow headlines instead of machine names', () => {
  const map: any = {
    identity: { name: 'fixture', domain: 'field-service', domain_source: 'deterministic', description: '', description_source: 'deterministic' },
    capabilities: [{
      name: 'Company Management', description: 'Company lifecycle.', description_source: 'deterministic', category: 'core', criticality: 'critical',
      entry_point_flows: [{ id: truckspy.id, name: truckspy.name }], entities: ['Company'], tests_present: false, risk_level: 'medium',
    }],
    entry_point_flows: {
      total: 3, user_facing: 3, system: 0, scheduled: 0,
      top: [{ id: truckspy.id, name: truckspy.name, kind: 'user-facing', criticality: 'critical', boundaries: ['IsGranted', 'IsGranted'], tests: 0 }],
    },
    journeys: { total: 0, representative: 0, top: [] },
    data: { entities: 0, sensitive: [], exposure_highlights: [] },
    conventions: { paradigms: [], open_deviations: { error: 0, warning: 0, info: 0 } },
    health: { status: 'healthy', tests: { total: 0, passing: 0, failing: 0 }, implementation: { complete: 0, partial: 0, stubs: 0, not_implemented: 0, deprecated: 0 }, top_risks: [] },
    coverage_caveats: [],
  };
  const markdown = productMapToMarkdown(map);
  assert.ok(markdown.includes('- Create company: POST /api/web/partner/companies -> Company created +7 more; guarded (authorization: IsGranted), no auth guard, no tests [user-facing, critical]'));
  assert.ok(markdown.includes('entry-point flows: Create company'), 'capability entryPointFlow link uses the short title');
  assert.ok(!markdown.includes('| boundaries:'), 'pipe-separated machine row is gone');
});

test('product map markdown renders exposure highlight fields as labels, never [object Object]', () => {
  const map: any = {
    identity: { name: 'legacy-app', domain: 'crypto', domain_source: 'ai', description: '', description_source: 'ai' },
    capabilities: [],
    entry_point_flows: { total: 0, user_facing: 0, system: 0, scheduled: 0, top: [] },
    journeys: { total: 0, representative: 0, top: [] },
    data: {
      entities: 1,
      sensitive: ['DexTrade'],
      // Legacy/cross-repo analyses can carry OBJECTS instead of bare strings.
      exposure_highlights: [{
        entity: 'DexTrade',
        sensitive_fields: [{ name: 'walletAddress' }, 'txHash'],
        unguarded_paths: 2,
        external_transfer: true,
        external_recipients: [{ service: 'binance' }, 'coinbase'],
      }],
    },
    conventions: { paradigms: [], open_deviations: { error: 0, warning: 0, info: 0 } },
    health: { status: 'healthy', tests: { total: 0, passing: 0, failing: 0 }, implementation: { complete: 0, partial: 0, stubs: 0, not_implemented: 0, deprecated: 0 }, top_risks: [] },
    coverage_caveats: [],
  };
  const markdown = productMapToMarkdown(map);
  assert.ok(!markdown.includes('[object Object]'), 'no [object Object] leaks into the rendered map');
  assert.ok(markdown.includes('sensitive fields: walletAddress, txHash'), 'object-shaped sensitive fields render their names');
  assert.ok(markdown.includes('external transfer to binance, coinbase'), 'object-shaped recipients render their service names');
});

test('product map markdown renders a runtime topology section when present', () => {
  const map: any = {
    identity: { name: 'infra-app', domain: 'unknown', domain_source: 'deterministic', description: '', description_source: 'deterministic' },
    capabilities: [],
    entry_point_flows: { total: 0, user_facing: 0, system: 0, scheduled: 0, top: [] },
    journeys: { total: 0, representative: 0, top: [] },
    data: { entities: 0, sensitive: [], exposure_highlights: [] },
    conventions: { paradigms: [], open_deviations: { error: 0, warning: 0, info: 0 } },
    health: { status: 'healthy', tests: { total: 0, passing: 0, failing: 0 }, implementation: { complete: 0, partial: 0, stubs: 0, not_implemented: 0, deprecated: 0 }, top_risks: [] },
    runtime_topology: {
      edge_count: 5,
      deployables: [{
        name: 'api',
        deploys: ['api/Dockerfile'],
        exposes: ['port:8080'],
        routes: ['/orders'],
        channels: ['orders'],
        databases: [],
        storage: [],
        depends_on: ['worker'],
      }],
    },
    coverage_caveats: [],
  };
  const markdown = productMapToMarkdown(map);
  assert.ok(markdown.includes('## Runtime Topology (5 infra->code edges)'), 'section header with edge count');
  assert.ok(markdown.includes('- **api**'), 'per-deployable heading');
  assert.ok(markdown.includes('deploys: api/Dockerfile'));
  assert.ok(markdown.includes('exposes: port:8080'));
  assert.ok(markdown.includes('routes: /orders'));
  assert.ok(markdown.includes('depends on: worker'));
});

test('product map markdown omits runtime topology when absent', () => {
  const map: any = {
    identity: { name: 'plain', domain: 'unknown', domain_source: 'deterministic', description: '', description_source: 'deterministic' },
    capabilities: [],
    entry_point_flows: { total: 0, user_facing: 0, system: 0, scheduled: 0, top: [] },
    journeys: { total: 0, representative: 0, top: [] },
    data: { entities: 0, sensitive: [], exposure_highlights: [] },
    conventions: { paradigms: [], open_deviations: { error: 0, warning: 0, info: 0 } },
    health: { status: 'healthy', tests: { total: 0, passing: 0, failing: 0 }, implementation: { complete: 0, partial: 0, stubs: 0, not_implemented: 0, deprecated: 0 }, top_risks: [] },
    coverage_caveats: [],
  };
  const markdown = productMapToMarkdown(map);
  assert.ok(!markdown.includes('Runtime Topology'), 'no runtime topology header for non-infra repos');
});

test('agent context entryPointFlow digest carries a one-line headline per entryPointFlow', () => {
  const context = buildEntryPointFlowContextForAgent(casWithEntryPointFlows() as any, { nodeId: truckspy.entry?.handler_node_id }) as any;
  assert.ok(context);
  assert.equal(context.total_matching, 1);
  const digest = context.entry_point_flows[0];
  assert.equal(digest.id, truckspy.id);
  assert.ok(digest.headline.startsWith('Create company: POST /api/web/partner/companies'));
  assert.ok(digest.headline.length <= 160);
  assert.deepEqual(digest.boundaries, ['IsGranted']);
  assert.equal(digest.tests, 0);
  assert.ok(!('name' in digest), 'machine-y truncated name replaced by headline');
});
