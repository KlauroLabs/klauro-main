/**
 * Read-side purity of the bench analysis path (product-analysis.ts).
 *
 * INVARIANT: writes to the stored CAS happen only from explicit
 * analyze/enrichment entry points (analyzeProject/runAnalysis); every other
 * consumer — including this blackbox bench harness — is pure with respect to
 * an EXISTING stored analysis.
 *
 * Regression for the ai_skipped clobber: running a read-shaped harness
 * (usefulness review → reviewTarget → analyzeForBench) in a process WITHOUT
 * an AI provider used to overwrite the user's real stored analysis, stamping
 * `enhanced_system_purpose.description_generation` with
 * {status:'ai_skipped', reason:'no-ai-provider-configured', generated_at:<read
 * time>} and a fresh analysis_timestamp over real provenance (observed live on
 * soon-bos / soon-decrypter / Finance-Context).
 *
 * Blackbox: only calls analyzeForBench (the product path) + storage; never
 * imports the engine, never sets a model/AI env.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { analyzeForBench } from './product-analysis';
import { saveAnalysis, loadAnalysis, getAnalysisEntry } from '../storage';

let workspaceRoot: string;
let fixtureProject: string;

function writeFixtureProject(root: string, name: string): string {
  const projectDir = path.join(root, name);
  fs.mkdirpSync(path.join(projectDir, 'src'));
  fs.writeJsonSync(path.join(projectDir, 'package.json'), {
    name,
    version: '1.0.0',
    main: 'src/index.js',
  }, { spaces: 2 });
  fs.writeFileSync(path.join(projectDir, 'src', 'index.js'), [
    'function greet(name) {',
    '  return `Hello, ${name}`;',
    '}',
    '',
    'module.exports = { greet };',
    '',
  ].join('\n'));
  return projectDir;
}

/** Resolve the on-disk analysis file for a project via its index entry. */
async function analysisFileBytes(projectPath: string): Promise<Buffer | null> {
  const entry = await getAnalysisEntry(projectPath);
  if (!entry) return null;
  // The suite pins KLAURO_STORAGE_PATH in before(), so this is the store root.
  const filePath = path.join(process.env.KLAURO_STORAGE_PATH!, entry.file);
  return fs.pathExists(filePath).then(exists => (exists ? fs.readFile(filePath) : null));
}

before(() => {
  workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-product-analysis-test-'));
  fixtureProject = writeFixtureProject(workspaceRoot, 'read-purity-fixture');
  process.env.KLAURO_STORAGE_PATH = path.join(workspaceRoot, 'storage');
  process.env.KLAURO_LOG_DIR = path.join(workspaceRoot, 'logs');
  process.env.KLAURO_EMBEDDING_ENABLED = 'false';
  // The bench must behave as an AI-less reader: no provider configured.
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.DEEPINFRA_API_KEY;
  delete process.env.KLAURO_BENCH_ANALYZER_URL;
});

after(() => {
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
});

test('analyzeForBench never overwrites an existing stored analysis (AI-off read run leaves description_generation byte-stable)', async () => {
  // Seed the store with a previously ENRICHED analysis for the fixture path —
  // the provenance an AI-off read run must not clobber.
  const enrichedGeneratedAt = '2026-01-01T00:00:00.000Z';
  const storedCas: any = {
    cas_version: '1.0',
    analysis_timestamp: enrichedGeneratedAt,
    system: { id: 'system_read-purity-fixture', name: 'read-purity-fixture', type: 'library', root_path: fixtureProject },
    nodes: [],
    edges: [],
    enhanced_system_purpose: {
      primary_domain: 'greeting-management',
      inferred_description: 'A tiny greeting library used to pin stored provenance.',
      core_concepts: ['greeting'],
      description_generation: {
        status: 'ai_applied',
        attempted: true,
        source: 'ai',
        generated_at: enrichedGeneratedAt,
      },
    },
  };
  await saveAnalysis(fixtureProject, storedCas);
  const bytesBefore = await analysisFileBytes(fixtureProject);
  assert.ok(bytesBefore, 'seeded analysis file should exist');

  const cas = await analyzeForBench(fixtureProject);
  assert.ok(cas.nodes.length >= 1, 'bench analysis should still return a real in-memory CAS');

  // The stored file must be byte-identical: no ai_skipped stamp, no fresh
  // analysis_timestamp, no provenance rewrite.
  const bytesAfter = await analysisFileBytes(fixtureProject);
  assert.ok(bytesAfter, 'stored analysis file should still exist');
  assert.ok(bytesBefore!.equals(bytesAfter!), 'stored analysis must be byte-stable across an AI-off bench run');

  const reloaded: any = await loadAnalysis(fixtureProject);
  assert.equal(reloaded?.enhanced_system_purpose?.description_generation?.status, 'ai_applied');
  assert.equal(reloaded?.enhanced_system_purpose?.description_generation?.generated_at, enrichedGeneratedAt);
  assert.equal(reloaded?.analysis_timestamp, enrichedGeneratedAt);
});

test('analyzeForBench still seeds the local cache when no analysis is stored', async () => {
  const emptySlotProject = writeFixtureProject(workspaceRoot, 'seed-fixture');
  assert.equal(await getAnalysisEntry(emptySlotProject), null, 'precondition: no stored analysis');

  const cas = await analyzeForBench(emptySlotProject);
  assert.ok(cas.nodes.length >= 1, 'bench analysis should return a real CAS');

  const entry = await getAnalysisEntry(emptySlotProject);
  assert.ok(entry, 'bench run should seed the empty slot so getAnalysis/MCP flows find it');
  const stored: any = await loadAnalysis(emptySlotProject);
  assert.equal(stored?.system?.name, 'seed-fixture');
});
