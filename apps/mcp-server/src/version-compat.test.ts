import { strict as assert } from 'assert';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { test } from 'node:test';
import { CAS_VERSION } from '../../../packages/analyzer-core/src/types/cas.types';
import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import {
  MINIMUM_COMPATIBLE_CAS_VERSION,
  assertAnalysisVersionSupported,
  compareCasVersions,
  describeAnalysisVersion,
  getAnalysisEntry,
  getAnalysisVersionInfo,
  loadAnalysis,
  parseCasVersion,
  saveAnalysis,
} from './storage';
import {
  PILLAR_ATTESTED_CAS_VERSION,
  analysisVersionNotice,
  buildSummary,
  diffBehaviorAgainstSnapshot,
  getDataLineage,
  getEntryPoints,
  getExitPoints,
  getFlowCoverage,
  getParadigmConformance,
  getProductMap,
  getSecurityOverview,
  getSystemOverview,
  getEntryPointFlows,
  getUserJourneys,
  getWorkflows,
  searchNodes,
} from './query';
import { evaluateVersionSkewChecks } from './version-skew';

function restoreEnv(name: string, previous: string | undefined): void {
  if (previous === undefined) delete process.env[name];
  else process.env[name] = previous;
}

function makeCas(casVersion: string, overrides: Record<string, unknown> = {}): CASOutput {
  return {
    cas_version: casVersion,
    analysis_timestamp: new Date().toISOString(),
    analysis_id: `analysis-compat-${casVersion}`,
    system: {
      id: 'compat-fixture',
      name: 'compat-fixture',
      type: 'service',
      root_path: '/tmp/compat-fixture',
    },
    nodes: [
      { id: 'node-handler', type: 'function', name: 'handleRequest', source: { file: 'src/handler.ts', line: 3 } },
      { id: 'node-store', type: 'function', name: 'storeThing', source: { file: 'src/store.ts', line: 8 } },
    ],
    edges: [
      { id: 'edge-1', source: 'node-handler', target: 'node-store', type: 'calls' },
    ],
    entry_points: [
      { id: 'entry-things', type: 'http', name: 'POST /things', source_node: 'node-handler' },
    ],
    exit_points: [
      { id: 'exit-db', type: 'database', name: 'things insert', source_node: 'node-store' },
    ],
    analyzer_contributions: [],
    ...overrides,
  } as unknown as CASOutput;
}

function makeCurrentAnalysis(): CASOutput {
  return makeCas(CAS_VERSION, {
    entry_point_flows: [
      {
        id: 'journey-create-thing',
        name: 'Create thing',
        flow_kind: 'user-facing',
        criticality: 'high',
        risk: 'low',
        entry_point_id: 'entry-things',
        entry: { type: 'http', name: 'POST /things', method: 'POST', path_or_trigger: '/things' },
        terminal_entities: [{ entity_id: 'entity-thing', name: 'Thing' }],
        terminal_effects: { entities_written: ['Thing'], entities_read: [], external_services: [], messages_emitted: [] },
        steps: [],
        security_boundaries: [],
        tests_covering: [],
        call_chain_ids: [],
        exit_point_ids: [],
      },
    ],
    paradigm_conformance: [
      {
        paradigm: 'guarded-http-entry-points',
        description: 'HTTP entries pass through a guard',
        adoption: { comparable_count: 4, conforming_count: 4, rate: 1 },
        deviations: [],
      },
    ],
    data_lineage: [
      {
        entity_id: 'entity-thing',
        entity_name: 'Thing',
        sensitive_fields: [],
        writers: [{ node_id: 'node-store' }],
        readers: [],
        external_recipients: [],
        boundaries_crossed: [],
        entry_point_flows_carrying: ['journey-create-thing'],
        exposure: { sensitive: false, unguarded_paths: 0, external_transfer: false },
      },
    ],
  });
}

function makeLegacyAnalysis(casVersion = '1.9.0'): CASOutput {
  // Current shape minus everything the 1.10.0 line added: no pillar fields,
  // no idiom provenance, no embedding index, no product map.
  return makeCas(casVersion);
}

test('cas version parsing and comparison are semver-ish and lenient', () => {
  assert.deepEqual(parseCasVersion('1.10.0'), [1, 10, 0]);
  assert.equal(parseCasVersion('not-a-version'), null);
  assert.equal(parseCasVersion(undefined), null);

  assert.equal(compareCasVersions('1.9.0', '1.10.0'), -1);
  assert.equal(compareCasVersions('1.10.0', '1.10.0'), 0);
  assert.equal(compareCasVersions('2.0.0', '1.11.0'), 1);
  assert.equal(compareCasVersions(undefined, '0.0.0'), 0);
});

test('describeAnalysisVersion classifies stored versions against the floor', () => {
  // A genuinely future major line, computed from the live CAS_VERSION rather
  // than hardcoded — a literal like '2.0.0' was "newer" only while
  // CAS_VERSION sat on the 1.x line. Once CAS_VERSION itself crossed into
  // 2.x (1.11.0 -> 2.0.0 -> 2.1.0, 2026-08-09), that literal became an
  // OLDER version by definition and silently stopped exercising the
  // newer-major branch at all. Mirrors the newerMinor pattern below.
  const [futureMajor] = parseCasVersion(CAS_VERSION)!;
  const newerMajor = `${futureMajor + 1}.0.0`;

  assert.equal(describeAnalysisVersion(CAS_VERSION).status, 'current');
  assert.equal(describeAnalysisVersion('1.9.0').status, 'older-compatible');
  assert.equal(describeAnalysisVersion('1.5.0').status, 'unsupported');
  assert.equal(describeAnalysisVersion('0.9.0').status, 'unsupported');
  assert.equal(describeAnalysisVersion(newerMajor).status, 'newer-major');
  assert.equal(describeAnalysisVersion(undefined).status, 'unsupported');

  const info = describeAnalysisVersion('1.9.0');
  assert.equal(info.minimum_compatible_version, MINIMUM_COMPATIBLE_CAS_VERSION);
  assert.equal(info.current_version, CAS_VERSION);
});

test('assertAnalysisVersionSupported gives a re-analysis instruction, never a crash path', () => {
  const [futureMajor] = parseCasVersion(CAS_VERSION)!;
  const newerMajor = `${futureMajor + 1}.0.0`;

  assert.doesNotThrow(() => assertAnalysisVersionSupported(makeCurrentAnalysis(), '/tmp/p'));
  assert.doesNotThrow(() => assertAnalysisVersionSupported(makeLegacyAnalysis(), '/tmp/p'));

  assert.throws(
    () => assertAnalysisVersionSupported(makeLegacyAnalysis('1.5.0'), '/tmp/p'),
    (error: Error) => error.message.includes('Re-run analyze_codebase') && error.message.includes('1.5.0')
  );
  assert.throws(
    () => assertAnalysisVersionSupported(makeLegacyAnalysis(newerMajor), '/tmp/p'),
    (error: Error) => error.message.includes('Upgrade the Klauro MCP server')
  );
});

test('core tools answer a pre-pillar analysis without throwing', () => {
  const legacy = makeLegacyAnalysis();

  const summary = buildSummary(legacy);
  assert.equal(summary.nodes, 2);
  assert.equal(summary.analysis_version_status, 'older-compatible');
  assert.ok(summary.analysis_version_notice?.includes('Re-run analyze_codebase'));

  assert.doesNotThrow(() => getSystemOverview(legacy));
  assert.doesNotThrow(() => searchNodes(legacy, 'handleRequest'));
  assert.doesNotThrow(() => getEntryPoints(legacy));
  assert.doesNotThrow(() => getExitPoints(legacy));
  assert.doesNotThrow(() => getWorkflows(legacy));
  assert.doesNotThrow(() => getFlowCoverage(legacy));
  assert.doesNotThrow(() => getSecurityOverview(legacy));
});

test('current analyses carry no version notice', () => {
  const current = makeCurrentAnalysis();
  const summary = buildSummary(current);
  assert.equal(summary.analysis_version_status, 'current');
  assert.equal(summary.analysis_version_notice, undefined);

  const flows = getEntryPointFlows(current) as { total: number; analysis_version_notice?: string };
  assert.equal(flows.total, 1);
  assert.equal(flows.analysis_version_notice, undefined);
  const journeys = getUserJourneys(current) as { total: number; analysis_version_notice?: string };
  assert.equal(journeys.total, 0);
  assert.equal(journeys.analysis_version_notice, undefined);
});

test('pillar tools return an explicit version notice on a pre-pillar analysis', () => {
  const legacy = makeLegacyAnalysis();

  const journeys = getUserJourneys(legacy) as { total: number; analysis_version_notice?: string };
  assert.equal(journeys.total, 0);
  assert.ok(journeys.analysis_version_notice?.includes('journeys'));
  assert.ok(journeys.analysis_version_notice?.includes('Re-run analyze_codebase'));

  const flows = getEntryPointFlows(legacy) as { total: number; analysis_version_notice?: string };
  assert.equal(flows.total, 0);
  assert.ok(flows.analysis_version_notice?.includes('entry-point flows'));

  const entryPointFlowDetail = getUserJourneys(legacy, { journeyId: 'missing' }) as { journey: unknown; analysis_version_notice?: string };
  assert.equal(entryPointFlowDetail.journey, null);
  assert.ok(entryPointFlowDetail.analysis_version_notice?.includes('journeys'));

  const paradigms = getParadigmConformance(legacy) as { total: number; analysis_version_notice?: string };
  assert.equal(paradigms.total, 0);
  assert.ok(paradigms.analysis_version_notice?.includes('paradigm conformance'));

  const lineage = getDataLineage(legacy) as { total: number; analysis_version_notice?: string };
  assert.equal(lineage.total, 0);
  assert.ok(lineage.analysis_version_notice?.includes('data lineage'));
});

test('a current analysis with genuinely no pillar data stays notice-free', () => {
  // At PILLAR_ATTESTED_CAS_VERSION and later the analyzer ran pillar extraction,
  // so absence means the repository has none, not that the analysis predates them.
  const current = makeCas(CAS_VERSION);
  assert.ok(compareCasVersions(CAS_VERSION, PILLAR_ATTESTED_CAS_VERSION) >= 0);

  const journeys = getUserJourneys(current) as { total: number; analysis_version_notice?: string };
  assert.equal(journeys.total, 0);
  assert.equal(journeys.analysis_version_notice, undefined);
  assert.equal(analysisVersionNotice(current, 'entry-point flows'), undefined);
});

test('get_product_map falls back to an on-demand map with a notice on a pre-pillar analysis', () => {
  const legacy = makeLegacyAnalysis();

  const full = getProductMap(legacy) as { identity?: unknown; analysis_version_notice?: string };
  assert.ok(full.identity !== undefined);
  assert.ok(full.analysis_version_notice?.includes('computed on demand'));

  const section = getProductMap(legacy, { section: 'identity' }) as { identity?: unknown; analysis_version_notice?: string };
  assert.ok(section.analysis_version_notice?.includes('computed on demand'));

  const markdown = getProductMap(legacy, { format: 'markdown' }) as { markdown?: string };
  assert.ok(markdown.markdown?.startsWith('> '));
  assert.ok(markdown.markdown?.includes('computed on demand'));

  const current = getProductMap(makeCurrentAnalysis()) as { analysis_version_notice?: string };
  assert.equal(current.analysis_version_notice, undefined);
});

test('saveAnalysis records cas_version in the index and loadAnalysis tags the loaded analysis', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-version-compat-'));
  const projectPath = path.join(root, 'repo');
  const previousStoragePath = process.env.KLAURO_STORAGE_PATH;
  const previousCompression = process.env.KLAURO_ANALYSIS_COMPRESSION;
  process.env.KLAURO_STORAGE_PATH = path.join(root, 'storage');
  process.env.KLAURO_ANALYSIS_COMPRESSION = 'none';

  try {
    await fs.ensureDir(projectPath);

    const entry = await saveAnalysis(projectPath, makeLegacyAnalysis());
    assert.equal(entry.cas_version, '1.9.0');

    const storedEntry = await getAnalysisEntry(projectPath);
    assert.equal(storedEntry?.cas_version, '1.9.0');

    const loaded = await loadAnalysis(projectPath);
    assert.ok(loaded);
    const info = getAnalysisVersionInfo(loaded!);
    assert.equal(info.stored_version, '1.9.0');
    assert.equal(info.status, 'older-compatible');
    assert.equal(JSON.parse(JSON.stringify(loaded)).analysis_version_info, undefined);

    const unsupportedProject = path.join(root, 'ancient');
    await fs.ensureDir(unsupportedProject);
    await saveAnalysis(unsupportedProject, makeLegacyAnalysis('1.5.0'));
    const ancient = await loadAnalysis(unsupportedProject);
    assert.ok(ancient);
    assert.equal(getAnalysisVersionInfo(ancient!).status, 'unsupported');
    assert.throws(
      () => assertAnalysisVersionSupported(ancient!, unsupportedProject),
      (error: Error) => error.message.includes('Re-run analyze_codebase')
    );
  } finally {
    restoreEnv('KLAURO_STORAGE_PATH', previousStoragePath);
    restoreEnv('KLAURO_ANALYSIS_COMPRESSION', previousCompression);
    await fs.remove(root);
  }
});

test('diff_behavior flags a pre-pillar baseline snapshot instead of misattributing changes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-version-diff-'));
  const projectPath = path.join(root, 'repo');
  const previousStoragePath = process.env.KLAURO_STORAGE_PATH;
  const previousCompression = process.env.KLAURO_ANALYSIS_COMPRESSION;
  process.env.KLAURO_STORAGE_PATH = path.join(root, 'storage');
  process.env.KLAURO_ANALYSIS_COMPRESSION = 'none';

  try {
    await fs.ensureDir(projectPath);
    const { saveAnalysisSnapshot } = await import('./storage');
    const legacyBaseline = makeLegacyAnalysis();
    (legacyBaseline as { analysis_timestamp: string }).analysis_timestamp = '2026-01-01T00:00:00.000Z';
    await saveAnalysisSnapshot(projectPath, legacyBaseline);
    const current = makeCurrentAnalysis();
    (current as { analysis_timestamp: string }).analysis_timestamp = '2026-06-01T00:00:00.000Z';
    await saveAnalysisSnapshot(projectPath, current);

    const diff = await diffBehaviorAgainstSnapshot(projectPath, current) as {
      applicable: boolean;
      analysis_version_notice?: string;
    };
    assert.equal(diff.applicable, true);
    assert.ok(diff.analysis_version_notice?.includes('predates behavior pillars'));
  } finally {
    restoreEnv('KLAURO_STORAGE_PATH', previousStoragePath);
    restoreEnv('KLAURO_ANALYSIS_COMPRESSION', previousCompression);
    await fs.remove(root);
  }
});

const REAL_LEGACY_FIXTURE_PATH = path.resolve(__dirname, '..', 'fixtures', 'compat', 'testing-utilities-net-1.10.0.json');

async function loadRealLegacyFixture(): Promise<CASOutput> {
  return await fs.readJson(REAL_LEGACY_FIXTURE_PATH) as CASOutput;
}

test('a real stored 1.10.0 artifact round-trips through storage with the correct classification', async () => {
  const fixture = await loadRealLegacyFixture();
  assert.equal(fixture.cas_version, '1.10.0');
  assert.ok(fixture.nodes.length > 0, 'fixture must be a real non-empty analysis');

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-real-compat-'));
  const projectPath = path.join(root, 'testing-utilities-net');
  const previousStoragePath = process.env.KLAURO_STORAGE_PATH;
  const previousCompression = process.env.KLAURO_ANALYSIS_COMPRESSION;
  process.env.KLAURO_STORAGE_PATH = path.join(root, 'storage');
  process.env.KLAURO_ANALYSIS_COMPRESSION = 'none';

  try {
    await fs.ensureDir(projectPath);
    const entry = await saveAnalysis(projectPath, fixture);
    assert.equal(entry.cas_version, '1.10.0');

    const loaded = await loadAnalysis(projectPath);
    assert.ok(loaded);
    const info = getAnalysisVersionInfo(loaded!);
    assert.equal(info.stored_version, '1.10.0');
    assert.equal(info.status, 'older-compatible');
    assert.doesNotThrow(() => assertAnalysisVersionSupported(loaded!, projectPath));
  } finally {
    restoreEnv('KLAURO_STORAGE_PATH', previousStoragePath);
    restoreEnv('KLAURO_ANALYSIS_COMPRESSION', previousCompression);
    await fs.remove(root);
  }
});

test('core tools degrade per policy on the real 1.10.0 artifact', async () => {
  const legacy = await loadRealLegacyFixture();

  const summary = buildSummary(legacy);
  assert.equal(summary.nodes, legacy.nodes.length);
  assert.equal(summary.analysis_version_status, 'older-compatible');
  assert.ok(summary.analysis_version_notice?.includes('Re-run analyze_codebase'));

  assert.doesNotThrow(() => getSystemOverview(legacy));
  assert.doesNotThrow(() => searchNodes(legacy, 'Using_specs_for'));
  assert.doesNotThrow(() => getEntryPoints(legacy));
  assert.doesNotThrow(() => getExitPoints(legacy));
  assert.doesNotThrow(() => getWorkflows(legacy));
  assert.doesNotThrow(() => getFlowCoverage(legacy));
  assert.doesNotThrow(() => getSecurityOverview(legacy));

  const matches = searchNodes(legacy, 'Using_specs_for') as Array<{ name?: string }>;
  assert.ok(matches.length > 0, 'search over the real artifact must find its real nodes');
});

test('pillar tools return the version notice on the real 1.10.0 artifact', async () => {
  const legacy = await loadRealLegacyFixture();

  const journeys = getUserJourneys(legacy) as { total: number; analysis_version_notice?: string };
  assert.equal(journeys.total, 0);
  assert.ok(journeys.analysis_version_notice?.includes('journeys'));
  assert.ok(journeys.analysis_version_notice?.includes('1.10.0'));
  assert.ok(journeys.analysis_version_notice?.includes('Re-run analyze_codebase'));

  const paradigms = getParadigmConformance(legacy) as { total: number; analysis_version_notice?: string };
  assert.equal(paradigms.total, 0);
  assert.ok(paradigms.analysis_version_notice?.includes('paradigm conformance'));

  const lineage = getDataLineage(legacy) as { total: number; analysis_version_notice?: string };
  assert.equal(lineage.total, 0);
  assert.ok(lineage.analysis_version_notice?.includes('data lineage'));

  const map = getProductMap(legacy) as { identity?: unknown; analysis_version_notice?: string };
  assert.ok(map.identity !== undefined);
  assert.ok(map.analysis_version_notice?.includes('computed on demand'));
});

test('a newer-minor analysis classifies as newer-compatible and loads without degradation', () => {
  const [major, minor] = parseCasVersion(CAS_VERSION)!;
  const newerMinor = `${major}.${minor + 1}.0`;

  const info = describeAnalysisVersion(newerMinor);
  assert.equal(info.status, 'newer-compatible');
  assert.equal(info.stored_version, newerMinor);

  const newer = makeCas(newerMinor);
  assert.doesNotThrow(() => assertAnalysisVersionSupported(newer, '/tmp/p'));

  const summary = buildSummary(newer);
  assert.equal(summary.analysis_version_status, 'newer-compatible');
  assert.equal(summary.analysis_version_notice, undefined);

  assert.doesNotThrow(() => getSystemOverview(newer));
  assert.doesNotThrow(() => searchNodes(newer, 'handleRequest'));

  const journeys = getUserJourneys(newer) as { total: number; analysis_version_notice?: string };
  assert.equal(journeys.total, 0);
  assert.equal(journeys.analysis_version_notice, undefined, 'a newer analysis must not be flagged as pre-pillar');
});

test('nightly eval version-skew checks all hold', () => {
  const checks = evaluateVersionSkewChecks();
  assert.equal(checks.length, 6);
  const failing = checks.filter(check => check.status === 'fail');
  assert.deepEqual(failing.map(check => check.id), []);
});
