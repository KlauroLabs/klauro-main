import { strict as assert } from 'assert';
import { test } from 'node:test';
import * as fs from 'fs';
import * as path from 'path';
import type { CASUserJourney } from '../../../packages/analyzer-core/src/types/cas.types';
import {
  compressJourneySteps,
  displayJourneySteps,
  humanizeIdentifier,
  journeyDetailMarkdown,
  journeyEffectPhrases,
  journeyGuardPhrase,
  journeyHeadline,
  journeyListMarkdown,
  journeyStepPhrase,
  journeyTestPhrase,
  journeyTitle,
  storedJourneyNameHeadline,
  storedJourneyNameParts,
} from './journey-presentation';
import { getUserJourneys, productMapToMarkdown } from './query';
import { buildJourneyContextForAgent } from './agent-adoption';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const inspector = require('../scripts/create-analysis-inspector.js');

const fixturePath = path.join(__dirname, '..', 'fixtures', 'journeys', 'real-journeys.json');
const fixtures = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as Record<string, CASUserJourney>;
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

test('journeyTitle strips outcome arrows and entry suffixes from stored names', () => {
  assert.equal(journeyTitle(truckspy), 'Create company');
  assert.equal(journeyTitle(washup), 'Update location event');
  assert.equal(journeyTitle(klauro), 'Delete work order');
});

test('journeyHeadline reads as a single narrative line with entry, outcome, and facts', () => {
  const headline = journeyHeadline(truckspy);
  assert.equal(
    headline,
    'Create company: POST /api/web/partner/companies -> creates Company, Partner; 24 steps, guarded (authorization: IsGranted), no auth guard, no tests'
  );
  assert.ok(!headline.includes('node_id'));
  assert.ok(!headline.includes('method_'));
});

test('journeyHeadline reports unguarded journeys and test counts', () => {
  assert.ok(journeyHeadline(klauro).includes('guarded (auth: require_auth)'));
  assert.ok(journeyHeadline(klauro).endsWith('1 test'));
  assert.equal(journeyGuardPhrase({ security_boundaries: [] }), 'unguarded');
  assert.equal(journeyTestPhrase({ tests_covering: [] }), 'no tests');
});

test('journeyGuardPhrase distinguishes guard kinds instead of conflating them with authentication', () => {
  assert.equal(
    journeyGuardPhrase({ security_boundaries: [{ name: 'ThrottlerGuard', mechanism: 'entry-guard' }] }),
    'rate-limited (ThrottlerGuard), no auth guard'
  );
  assert.equal(
    journeyGuardPhrase({ security_boundaries: [{ name: 'GlobalAuthGuard', mechanism: 'entry-guard' }] }),
    'guarded (auth: GlobalAuthGuard)'
  );
  assert.equal(
    journeyGuardPhrase({ security_boundaries: [
      { name: 'GlobalAuthGuard', mechanism: 'entry-guard' },
      { name: 'ThrottlerGuard', mechanism: 'entry-guard' },
    ] }),
    'guarded (auth: GlobalAuthGuard; rate-limited: ThrottlerGuard)'
  );
  assert.equal(
    journeyGuardPhrase({ security_boundaries: [
      { name: 'OrganizationGuard', mechanism: 'entry-guard' },
      { name: 'ThrottlerGuard', mechanism: 'entry-guard' },
    ] }),
    'guarded (authorization: OrganizationGuard; rate-limited: ThrottlerGuard), no auth guard'
  );
  assert.equal(
    journeyGuardPhrase({ security_boundaries: [{ name: 'MysteryGuard', mechanism: 'entry-guard' }] }),
    'guarded (MysteryGuard), no auth guard'
  );
});

test('journeyGuardPhrase prefers the stored boundary kind over name classification', () => {
  assert.equal(
    journeyGuardPhrase({ security_boundaries: [{ name: 'CustomGate', mechanism: 'entry-guard', kind: 'authentication' }] }),
    'guarded (auth: CustomGate)'
  );
  assert.equal(
    journeyGuardPhrase({ security_boundaries: [{ name: 'CustomGate', mechanism: 'entry-guard', kind: 'rate-limiting' }] }),
    'rate-limited (CustomGate), no auth guard'
  );
});

test('displayJourneySteps drops entry-duplicate and consecutive-duplicate steps', () => {
  const steps = displayJourneySteps(washup);
  const labels = steps.map(step => humanizeIdentifier(step.name));
  assert.ok(!labels.includes('PATCH /location_events/:id'), 'route step should not repeat the entry');
  assert.ok(labels.length < (washup.steps || []).length);
});

test('compressJourneySteps keeps short chains intact and compresses long ones', () => {
  const short = compressJourneySteps((klauro.steps || []));
  assert.equal(short.omitted, 0);
  assert.equal(short.leading.length, (klauro.steps || []).length);

  const long = compressJourneySteps(truckspy.steps || []);
  assert.equal(long.leading.length, 3);
  assert.equal(long.trailing.length, 2);
  assert.equal(long.omitted, (truckspy.steps || []).length - 5);
});

test('journeyStepPhrase humanizes step names and marks omitted middles', () => {
  const phrase = journeyStepPhrase(truckspy);
  assert.ok(phrase.startsWith('create company -> company manager -> validate company name'));
  assert.ok(phrase.includes('intermediate steps)'));
  assert.ok(!phrase.includes('method_src_'));
});

test('journeyEffectPhrases renders terminal effects as short phrases, not JSON', () => {
  const phrases = journeyEffectPhrases(truckspy);
  assert.equal(phrases[0], 'writes Company, Partner');
  assert.ok(phrases[1].startsWith('reads Device, ModernSubscriptionQuantity'));
  assert.ok(phrases[1].includes('+2 more'));
});

test('journeyDetailMarkdown leads with title and headline and tucks provenance last', () => {
  const markdown = journeyDetailMarkdown(klauro);
  const lines = markdown.split('\n');
  assert.equal(lines[0], '## Delete work order');
  assert.ok(lines[2].startsWith('Delete work order: DELETE /work_orders/:id -> deletes WorkOrder'));
  assert.ok(markdown.includes('- Tests: 1 test'));
  assert.ok(lines[lines.length - 1].startsWith('_entry_point:'), 'provenance must be the last line');
  const provenanceIndex = markdown.indexOf('entry_point:');
  const stepsIndex = markdown.indexOf('- Steps');
  assert.ok(provenanceIndex > stepsIndex, 'provenance stays after the readable body');
});

test('journeyListMarkdown renders one headline per journey with counts up front', () => {
  const markdown = journeyListMarkdown([truckspy, washup], { total: 2, offset: 0, byKind: { 'user-facing': 2, system: 0, scheduled: 0 } });
  assert.ok(markdown.startsWith('# User Journeys'));
  assert.ok(markdown.includes('2 journeys (2 user-facing), showing 2.'));
  assert.ok(markdown.includes('- Create company: POST /api/web/partner/companies'));
  assert.ok(markdown.includes(`(id: ${washup.id})`));
});

test('storedJourneyNameParts splits the deterministic stored name format', () => {
  const parts = storedJourneyNameParts('Create company -> Company created (+7 more) (POST /api/web/partner/companies)');
  assert.equal(parts.title, 'Create company');
  assert.equal(parts.outcome, 'Company created +7 more');
  assert.equal(parts.entry, 'POST /api/web/partner/companies');
  assert.equal(
    storedJourneyNameHeadline('Create company -> Company created (+7 more) (POST /api/web/partner/companies)'),
    'Create company: POST /api/web/partner/companies -> Company created +7 more'
  );
  assert.equal(storedJourneyNameHeadline('Sync inventory'), 'Sync inventory');
});

test('storedJourneyNameParts handles intent-named frontend journeys with file-path provenance', () => {
  const parts = storedJourneyNameParts('View crypto assets table -> useConnectionHoldings (GET /dashboard/widgets/crypto-assets-table.tsx)');
  assert.equal(parts.title, 'View crypto assets table');
  assert.equal(parts.outcome, 'useConnectionHoldings');
  assert.equal(parts.entry, 'GET /dashboard/widgets/crypto-assets-table.tsx');
  assert.equal(storedJourneyNameParts('Update machine settings -> Machine updated').title, 'Update machine settings');
});

function casWithJourneys(): any {
  return {
    cas_version: '1.11.0',
    system: { name: 'fixture', type: 'service', root_path: '/repo/fixture' },
    nodes: [],
    edges: [],
    entry_points: [],
    exit_points: [],
    user_journeys: [truckspy, washup, klauro],
    user_journey_summary: { total_discovered: 3, included: 3, by_kind: { 'user-facing': 3, system: 0, scheduled: 0 } },
  };
}

test('getUserJourneys list mode includes title and headline per journey', () => {
  const result = getUserJourneys(casWithJourneys()) as any;
  assert.equal(result.journeys[0].title, 'Create company');
  assert.ok(result.journeys[0].headline.includes('creates Company, Partner'));
  assert.equal(result.journeys[0].name, truckspy.name, 'stored name stays available');
});

test('getUserJourneys list mode carries a compact source->sink path so no second detail call is needed', () => {
  const result = getUserJourneys(casWithJourneys()) as any;
  const item = result.journeys[0];
  // The reaching-chain (source=entry -> path=steps -> sink=terminal_entities) is
  // visible in the list item itself, matching the compression-bounded detail phrase.
  assert.equal(item.path, journeyStepPhrase(truckspy));
  assert.ok(item.path.startsWith('create company -> company manager -> validate company name'));
  // Token-bounded: long chains stay compressed, never the raw 24-step dump.
  assert.ok(item.path.includes('intermediate steps)'), 'long chains stay compressed in the list');
  assert.ok(!item.path.includes('method_src_'), 'raw node ids never leak into the path');
});

test('getUserJourneys list mode includes the step chain by default (no 2nd call needed)', () => {
  const result = getUserJourneys(casWithJourneys()) as any;
  const item = result.journeys[0];
  assert.ok(Array.isArray(item.steps), 'list item carries a steps array');
  assert.ok(item.steps.length > 0, 'steps array is non-empty for a journey with steps');
  // Each compact step exposes exactly the fields needed to act on it further
  // (e.g. feed node_id into get_coding_context) without re-fetching detail.
  for (const step of item.steps) {
    assert.ok(step.node_id, 'each step carries its node_id');
    assert.ok(step.name, 'each step carries its name');
    assert.ok(step.layer, 'each step carries its layer');
    assert.equal(typeof step.depth, 'number', 'each step carries its depth');
  }
});

test('getUserJourneys list mode drops steps when include_steps is false', () => {
  const result = getUserJourneys(casWithJourneys(), { includeSteps: false }) as any;
  assert.equal(result.journeys[0].steps, undefined, 'steps omitted when explicitly opted out');
  // step_count and the compact path phrase remain available either way.
  assert.ok(result.journeys[0].step_count > 0);
  assert.ok(result.journeys[0].path);
});

test('getUserJourneys markdown mode renders a readable journey brief', () => {
  const result = getUserJourneys(casWithJourneys(), { format: 'markdown' }) as any;
  assert.ok(result.markdown.startsWith('# User Journeys'));
  assert.ok(result.markdown.includes('- Create company: POST /api/web/partner/companies'));
  assert.ok(!result.markdown.includes('handler_node_id'));
});

test('getUserJourneys markdown detail renders the full readable journey', () => {
  const result = getUserJourneys(casWithJourneys(), { journeyId: klauro.id, format: 'markdown' }) as any;
  assert.ok(result.markdown.startsWith('## Delete work order'));
  assert.ok(result.markdown.includes('- Boundaries: require_auth (authentication, entry-guard)'));

  const missing = getUserJourneys(casWithJourneys(), { journeyId: 'nope', format: 'markdown' }) as any;
  assert.ok(missing.markdown.includes("No journey with id 'nope'"));
});

test('getUserJourneys json detail keeps the full stored journey plus presentation fields', () => {
  const result = getUserJourneys(casWithJourneys(), { journeyId: truckspy.id }) as any;
  assert.equal(result.journey.title, 'Create company');
  assert.ok(result.journey.headline.length > 0);
  assert.equal(result.journey.steps.length, (truckspy.steps || []).length, 'full chain stays available');
});

test('inspector journey tab data carries title, headline, and compressed display steps', () => {
  const data = inspector.journeyData(casWithJourneys());
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

test('inspector rendered journeys tab shows the headline and intermediate-step marker', () => {
  const cas = casWithJourneys();
  const html = inspector.renderHtml({
    generated_at: new Date().toISOString(),
    analysis_count: 1,
    analyses: [inspector.buildAnalysisEntry(cas, { name: 'fixture', file: 'fixture.json', analyzed_at: new Date().toISOString() }, '/repo/fixture')],
  });
  assert.ok(html.includes('intermediate step'));
  assert.ok(html.includes('class="headline"'));
});

test('product map markdown renders journey headlines instead of machine names', () => {
  const map: any = {
    identity: { name: 'fixture', domain: 'field-service', domain_source: 'deterministic', description: '', description_source: 'deterministic' },
    capabilities: [{
      name: 'Company Management', description: 'Company lifecycle.', description_source: 'deterministic', category: 'core', criticality: 'critical',
      journeys: [{ id: truckspy.id, name: truckspy.name }], entities: ['Company'], tests_present: false, risk_level: 'medium',
    }],
    journeys: {
      total: 3, user_facing: 3, system: 0, scheduled: 0,
      top: [{ id: truckspy.id, name: truckspy.name, kind: 'user-facing', criticality: 'critical', boundaries: ['IsGranted', 'IsGranted'], tests: 0 }],
    },
    data: { entities: 0, sensitive: [], exposure_highlights: [] },
    conventions: { paradigms: [], open_deviations: { error: 0, warning: 0, info: 0 } },
    health: { status: 'healthy', tests: { total: 0, passing: 0, failing: 0 }, implementation: { complete: 0, partial: 0, stubs: 0, not_implemented: 0, deprecated: 0 }, top_risks: [] },
    coverage_caveats: [],
  };
  const markdown = productMapToMarkdown(map);
  assert.ok(markdown.includes('- Create company: POST /api/web/partner/companies -> Company created +7 more; guarded (authorization: IsGranted), no auth guard, no tests [user-facing, critical]'));
  assert.ok(markdown.includes('journeys: Create company'), 'capability journey link uses the short title');
  assert.ok(!markdown.includes('| boundaries:'), 'pipe-separated machine row is gone');
});

test('product map markdown renders a runtime topology section when present', () => {
  const map: any = {
    identity: { name: 'infra-app', domain: 'unknown', domain_source: 'deterministic', description: '', description_source: 'deterministic' },
    capabilities: [],
    journeys: { total: 0, user_facing: 0, system: 0, scheduled: 0, top: [] },
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
    journeys: { total: 0, user_facing: 0, system: 0, scheduled: 0, top: [] },
    data: { entities: 0, sensitive: [], exposure_highlights: [] },
    conventions: { paradigms: [], open_deviations: { error: 0, warning: 0, info: 0 } },
    health: { status: 'healthy', tests: { total: 0, passing: 0, failing: 0 }, implementation: { complete: 0, partial: 0, stubs: 0, not_implemented: 0, deprecated: 0 }, top_risks: [] },
    coverage_caveats: [],
  };
  const markdown = productMapToMarkdown(map);
  assert.ok(!markdown.includes('Runtime Topology'), 'no runtime topology header for non-infra repos');
});

test('agent context journey digest carries a one-line headline per journey', () => {
  const context = buildJourneyContextForAgent(casWithJourneys() as any, { nodeId: truckspy.entry?.handler_node_id }) as any;
  assert.ok(context);
  assert.equal(context.total_matching, 1);
  const digest = context.journeys[0];
  assert.equal(digest.id, truckspy.id);
  assert.ok(digest.headline.startsWith('Create company: POST /api/web/partner/companies'));
  assert.ok(digest.headline.length <= 160);
  assert.deepEqual(digest.boundaries, ['IsGranted']);
  assert.equal(digest.tests, 0);
  assert.ok(!('name' in digest), 'machine-y truncated name replaced by headline');
});
