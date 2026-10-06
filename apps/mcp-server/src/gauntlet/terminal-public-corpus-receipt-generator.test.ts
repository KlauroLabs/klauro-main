import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { generateTerminalPublicCorpusReceipts, assertTerminalReceiptEnvironment, recoverTerminalReceiptPublication, readAuthorIdentity } from './terminal-public-corpus-receipt-generator';
import type { CASOutput } from '../../../../packages/analyzer-core/src/types/cas.types';

const env = {
  KLAURO_AUTHOR_ENDPOINT: 'https://relay.example/api/author/api/chat',
  KLAURO_AUTHOR_KEY: 'secret',
  KLAURO_AI_INTERPRETATION_ALLOW_DETERMINISTIC_KEEP: 'false',
  KLAURO_FORCE_AI_REFRESH: '1',
  KLAURO_BENCH_FORCE_ANALYSIS: '1',
  KLAURO_AI_CACHE_PATH: '/answers',
};

function answered(target: string, model = 'answering-model') {
  const folder = path.join(target, 'model-answers');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, model), `request\u0000${JSON.stringify({ model, message: { content: '{}' } })}`);
}

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

test('requires the Klauro author endpoint, a fresh answer store and no paid provider key', () => {
  assert.throws(() => assertTerminalReceiptEnvironment({ ...env, KLAURO_FORCE_AI_REFRESH: '0' }), /KLAURO_FORCE_AI_REFRESH/);
  assert.throws(() => assertTerminalReceiptEnvironment({ ...env, DEEPINFRA_API_KEY: 'paid' }), /DEEPINFRA_API_KEY/);
  assert.throws(() => assertTerminalReceiptEnvironment({ ...env, KLAURO_AUTHOR_ENDPOINT: 'http://relay.example/chat' }), /https/);
  assert.throws(() => assertTerminalReceiptEnvironment({ ...env, KLAURO_AUTHOR_KEY: '' }), /KLAURO_AUTHOR_KEY/);
  assert.doesNotThrow(() => assertTerminalReceiptEnvironment(env));
});

test('records the endpoint and the models that actually answered', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-author-identity-'));
  assert.throws(() => readAuthorIdentity(env, root), /names its model/);
  answered(root, 'second');
  answered(root, 'first');
  assert.deepEqual(readAuthorIdentity({ ...env, KLAURO_AUTHOR_ENDPOINT: 'https://u:p@relay.example/api/chat?k=v' }, root), {
    endpoint: 'https://relay.example/api/chat',
    models: ['first', 'second'],
  });
});

test('stages a fake production analysis, validates evidence, publishes, then runs the gate', async () => {
  const fixture = fixtureRoot();
  const traces = path.join(fixture.root, 'traces');
  let gated = false;
  await generateTerminalPublicCorpusReceipts({
    repoRoot: fixture.root, fixturePath: path.join(fixture.fixtureDir, 'terminality-public-corpus.json'),
    answerRoot: traces, env: { ...env, KLAURO_AI_CACHE_PATH: traces },
    dependencies: {
      resolveSourceIdentity: () => ({ commit: 'b'.repeat(40), parserFingerprint: 'parser', derivedFingerprint: 'derived' }),
      analyze: async () => {
        answered(traces);
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
  assert.equal(receipt.analysis.author_endpoint, 'https://relay.example/api/author/api/chat');
  assert.deepEqual(receipt.analysis.author_models, ['answering-model']);
  assert.equal(receipt.analysis.parser_fingerprint, 'parser');
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
      answerRoot: traces, env: { ...env, KLAURO_AI_CACHE_PATH: traces },
      dependencies: {
        resolveSourceIdentity: () => ({ commit: 'b'.repeat(40), parserFingerprint: 'parser', derivedFingerprint: 'derived' }),
        analyze: async () => {
          analysisCalls += 1;
          if (failAt === 'analysis' && analysisCalls === 2) throw new Error('analysis failed');
          answered(traces);
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
