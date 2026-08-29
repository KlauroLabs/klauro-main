import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { generateTerminalPublicCorpusReceipts, assertTerminalReceiptEnvironment, recoverTerminalReceiptPublication, TERMINAL_RECEIPT_IDENTITY } from './terminal-public-corpus-receipt-generator';
import type { CASOutput } from '../../../../packages/analyzer-core/src/types/cas.types';

const env = {
  DEEPINFRA_API_KEY: 'secret',
  DEEPINFRA_MODEL: TERMINAL_RECEIPT_IDENTITY.model,
  DEEPINFRA_STRUCTURED_MODEL: TERMINAL_RECEIPT_IDENTITY.model,
  DEEPINFRA_FAST_FALLBACK_MODEL: TERMINAL_RECEIPT_IDENTITY.model,
  KLAURO_AI_ENABLED: 'true',
  KLAURO_AI_INTERPRETATION: 'true',
  KLAURO_AI_INTERPRETATION_FORCE: '1',
  KLAURO_AI_INTERPRETATION_ALLOW_DETERMINISTIC_KEEP: 'false',
  AI_CACHE_ENABLED: 'false',
  KLAURO_SEMANTIC_DATASET_DIR: '/trace',
};

function fixtureRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-receipt-test-'));
  const fixtureDir = path.join(root, 'fixtures');
  const bundle = path.join(fixtureDir, 'terminality-public-corpus');
  const source = path.join(root, 'source');
  fs.mkdirSync(bundle, { recursive: true });
  fs.mkdirSync(path.join(source, 'app'), { recursive: true });
  fs.writeFileSync(path.join(source, 'app', 'README.md'), 'source');
  fs.writeFileSync(path.join(source, 'app', 'LICENSE'), 'MIT');
  fs.writeFileSync(path.join(source, 'app', 'package.json'), '{}');
  execFileSync('tar', ['-czf', path.join(bundle, 'app.tgz'), '-C', source, 'app']);
  const archive = fs.readFileSync(path.join(bundle, 'app.tgz'));
  const sourceHash = require('node:crypto').createHash('sha256').update('source').digest('hex');
  const archiveHash = require('node:crypto').createHash('sha256').update(archive).digest('hex');
  fs.writeFileSync(path.join(bundle, 'app-receipt.json'), '{"old":true}\n');
  fs.writeFileSync(path.join(fixtureDir, 'terminality-public-corpus.json'), JSON.stringify({ corpus: [{
    repoId: 'github:owner/app@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    source: 'https://github.com/owner/app/archive/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.tar.gz',
    license: 'MIT', archive: 'terminality-public-corpus/app.tgz', archiveSha256: archiveHash,
    root: 'app', sourceFile: 'README.md', sourceSha256: sourceHash,
    receipt: 'terminality-public-corpus/app-receipt.json',
  }] }));
  return { root, fixtureDir, bundle };
}

function output(): CASOutput {
  return {
    analysis_id: 'analysis-1', analysis_timestamp: '2026-01-01T00:00:00.000Z',
    parser_fingerprint: 'parser', derived_fingerprint: 'derived',
    nodes: [{ id: 'entry-1', type: 'function', name: 'entry', file_path: 'x.ts', start_line: 1, end_line: 1 }],
    edges: [], flows: [{ flow_id: 'flow-1', name: 'flow', description: '', steps: [], entry_point_id: 'entry-1' }],
    capabilities: [{ id: 'cap-1', name: 'Serve users', description: 'Users receive results.', operations: [{ entry_point_id: 'entry-1', entry_point_type: 'http', action: 'read', trigger: {} }], related_flows: [{ flow_id: 'flow-1', role: 'primary', rationale: 'entry' }] }],
  } as unknown as CASOutput;
}

test('requires pinned live AI identity and disabled cache', () => {
  assert.throws(() => assertTerminalReceiptEnvironment({ ...env, AI_CACHE_ENABLED: 'true' }), /AI_CACHE_ENABLED/);
  assert.throws(() => assertTerminalReceiptEnvironment({ ...env, KLAURO_AI_PROVIDER_CHAIN: '[]' }), /KLAURO_AI_PROVIDER_CHAIN/);
  assert.doesNotThrow(() => assertTerminalReceiptEnvironment(env));
});

test('stages a fake production analysis, validates evidence, publishes, then runs the gate', async () => {
  const fixture = fixtureRoot();
  const traces = path.join(fixture.root, 'traces');
  let gated = false;
  await generateTerminalPublicCorpusReceipts({
    repoRoot: fixture.root, fixturePath: path.join(fixture.fixtureDir, 'terminality-public-corpus.json'),
    semanticTraceRoot: traces, env: { ...env, KLAURO_SEMANTIC_DATASET_DIR: traces },
    dependencies: {
      resolveSourceIdentity: () => ({ commit: 'b'.repeat(40), digest: 'c'.repeat(64), fileCount: 2 }),
      analyze: async () => {
        const target = process.env.KLAURO_SEMANTIC_DATASET_DIR!;
        fs.writeFileSync(path.join(target, '2026-01-01.jsonl'), [
          JSON.stringify({ decision_type: 'ai_provider_attempt', schema_version: TERMINAL_RECEIPT_IDENTITY.semanticSchemaVersion, provider: TERMINAL_RECEIPT_IDENTITY.provider, model: TERMINAL_RECEIPT_IDENTITY.model }),
          JSON.stringify({ decision_type: 'capability_catalog', schema_version: TERMINAL_RECEIPT_IDENTITY.semanticSchemaVersion, prompt_version: TERMINAL_RECEIPT_IDENTITY.promptVersion }),
        ].join('\n'));
        return output();
      },
      runTerminalGate: () => { gated = true; },
    },
  });
  assert.equal(gated, true);
  const receipt = JSON.parse(fs.readFileSync(path.join(fixture.bundle, 'app-receipt.json'), 'utf8'));
  assert.deepEqual(receipt.capabilities[0].source_node_ids, ['entry-1']);
  assert.deepEqual(receipt.capabilities[0].source_flow_ids, ['flow-1']);
  assert.equal(receipt.analysis.analyzer_source_base_commit, 'b'.repeat(40));
});

test('preserves the complete prior multi-member bundle when later analysis or the terminal gate fails', async () => {
  for (const failAt of ['analysis', 'gate'] as const) {
    const fixture = fixtureRoot();
    const manifestPath = path.join(fixture.fixtureDir, 'terminality-public-corpus.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.corpus.push({ ...manifest.corpus[0], repoId: 'github:owner/app@dddddddddddddddddddddddddddddddddddddddd', receipt: 'terminality-public-corpus/app2-receipt.json' });
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    fs.writeFileSync(path.join(fixture.bundle, 'app2-receipt.json'), '{"old2":true}\\n');
    const before = directorySnapshot(fixture.bundle);
    const traces = path.join(fixture.root, 'traces');
    let analysisCalls = 0;
    await assert.rejects(generateTerminalPublicCorpusReceipts({
      repoRoot: fixture.root, fixturePath: manifestPath,
      semanticTraceRoot: traces, env: { ...env, KLAURO_SEMANTIC_DATASET_DIR: traces },
      dependencies: {
        resolveSourceIdentity: () => ({ commit: 'b'.repeat(40), digest: 'c'.repeat(64), fileCount: 2 }),
        analyze: async () => {
          analysisCalls += 1;
          if (failAt === 'analysis' && analysisCalls === 2) throw new Error('analysis failed');
          const target = process.env.KLAURO_SEMANTIC_DATASET_DIR!;
          fs.writeFileSync(path.join(target, 'trace.jsonl'), [
            JSON.stringify({ decision_type: 'ai_provider_attempt', schema_version: TERMINAL_RECEIPT_IDENTITY.semanticSchemaVersion, provider: TERMINAL_RECEIPT_IDENTITY.provider, model: TERMINAL_RECEIPT_IDENTITY.model }),
            JSON.stringify({ decision_type: 'capability_catalog', schema_version: TERMINAL_RECEIPT_IDENTITY.semanticSchemaVersion, prompt_version: TERMINAL_RECEIPT_IDENTITY.promptVersion }),
          ].join("\n"));
          return output();
        },
        runTerminalGate: () => { if (failAt === 'gate') throw new Error('gate failed'); },
      },
    }), /failed/);
    assert.deepEqual(directorySnapshot(fixture.bundle), before);
  }
});


function directorySnapshot(directory: string): Record<string, string> {
  const result: Record<string, string> = {};
  const visit = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else result[path.relative(directory, absolute)] = require('node:crypto').createHash('sha256').update(fs.readFileSync(absolute)).digest('hex');
    }
  };
  visit(directory);
  return result;
}

test('recovers the complete prior bundle from both publication kill points', () => {
  for (const newBundlePresent of [false, true]) {
    const fixture = fixtureRoot();
    const before = directorySnapshot(fixture.bundle);
    const backup = fixture.bundle + '.backup';
    const stagingParent = path.join(fixture.fixtureDir, '.terminal-receipts-killed');
    const staged = path.join(stagingParent, 'terminality-public-corpus');
    fs.cpSync(fixture.bundle, staged, { recursive: true });
    fs.renameSync(fixture.bundle, backup);
    if (newBundlePresent) {
      fs.renameSync(staged, fixture.bundle);
      fs.writeFileSync(path.join(fixture.bundle, 'unverified'), 'new');
    }
    const journal = path.join(fixture.fixtureDir, '.terminality-public-corpus-publish.json');
    fs.writeFileSync(journal, JSON.stringify({ current: fixture.bundle, backup, staged, stagingParent }));
    recoverTerminalReceiptPublication(journal);
    assert.deepEqual(directorySnapshot(fixture.bundle), before);
    assert.equal(fs.existsSync(journal), false);
  }
});
