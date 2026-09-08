import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'fs-extra';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CASContribution } from '../../types/cas.types';
import type { BaseAnalyzer } from './base-analyzer';
import { withAnalyzerFileReadCache, withAnalyzerFileReadTracking } from './analyzer-file-read-cache';
import { AnalyzerSourceInputCapture, sourceInputObservation } from './analyzer-source-inputs';
import { analyzeWithCompleteScope } from './analyzer-analysis-scope';
import { buildAnalyzerContributionSummary, invalidateIncrementalSourceInputs } from './analyzer-contribution-summary';
import { PersistentAnalyzerContributionCache } from './analyzer-contribution-cache';

async function workspace(t: TestContext): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-source-inputs-'));
  t.after(() => fs.remove(root));
  await fs.writeFile(path.join(root, 'source.ts'), 'export const value = 1;\n');
  return root;
}

test('merged file captures preserve conflicts, isolate analyzers, and count distinct external reads', () => {
  const capture = new AnalyzerSourceInputCapture();
  const first = new AnalyzerSourceInputCapture();
  const second = new AnalyzerSourceInputCapture();
  first.observe('/project/source.ts', sourceInputObservation('old', 'utf8'));
  second.observe('/project/source.ts', sourceInputObservation('new', 'utf8'));
  first.observe('/outside/config.json', sourceInputObservation('shared', 'utf8'));
  second.observe('/outside/config.json', sourceInputObservation('shared', 'utf8'));
  capture.merge(first);
  capture.merge(second);
  assert.deepEqual(capture.snapshot('/project').files, [
    { path: 'source.ts', status: 'conflicting', reason: 'multiple-input-identities' },
  ]);
  assert.equal(capture.snapshot('/project').outside_root_reads, 1);
  assert.equal(first.snapshot('/project').files[0].status, 'captured');
  assert.equal(second.snapshot('/project').files[0].status, 'captured');
  assert.deepEqual(new AnalyzerSourceInputCapture().snapshot('/project').files, []);
});

function digest(content: string | Buffer): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

test('captures delivered content rather than rereading changed source at completion', async t => {
  const root = await workspace(t);
  const file = path.join(root, 'source.ts');
  const tracked = await withAnalyzerFileReadCache(() => withAnalyzerFileReadTracking(async () => {
    const content = await fs.readFile(file, 'utf8');
    await fs.writeFile(file, 'export const value = 2;\n');
    return content;
  }));
  const snapshot = tracked.sourceInputs.snapshot(root);
  assert.equal(snapshot.coverage, 'observed-reads');
  assert.equal(snapshot.files[0].sha256, digest(tracked.result));
  assert.notEqual(snapshot.files[0].sha256, digest(await fs.readFile(file, 'utf8')));
  assert.equal(snapshot.files[0].representation, 'utf8-text');
  assert.equal(snapshot.files[0].path, 'source.ts');
});

test('cache hits attribute the original delivered input to each analyzer scope', async t => {
  const root = await workspace(t);
  const file = path.join(root, 'source.ts');
  await withAnalyzerFileReadCache(async () => {
    const first = await withAnalyzerFileReadTracking(() => fs.readFile(file, 'utf8'));
    await fs.writeFile(file, 'new content');
    const second = await withAnalyzerFileReadTracking(() => fs.readFile(file, 'utf8'));
    assert.equal(second.result, first.result);
    assert.deepEqual(second.sourceInputs.snapshot(root), first.sourceInputs.snapshot(root));
  });
});

test('conflicting observations cannot be reduced to the last content seen', async t => {
  const root = await workspace(t);
  const file = path.join(root, 'source.ts');
  const tracked = await withAnalyzerFileReadCache(() => withAnalyzerFileReadTracking(async () => {
    await fs.readFile(file, 'utf8');
    await fs.writeFile(file, 'changed');
    await fs.readFile(file, 'utf-8');
  }));
  assert.deepEqual(tracked.sourceInputs.snapshot(root).files, [
    { path: 'source.ts', status: 'conflicting', reason: 'multiple-input-identities' },
  ]);
});

test('overlapping analyzer scopes do not attribute each others reads', async t => {
  const root = await workspace(t);
  await fs.writeFile(path.join(root, 'other.ts'), 'other content');
  await withAnalyzerFileReadCache(async () => {
    const [first, second] = await Promise.all([
      withAnalyzerFileReadTracking(() => fs.readFile(path.join(root, 'source.ts'), 'utf8')),
      withAnalyzerFileReadTracking(() => fs.readFile(path.join(root, 'other.ts'), 'utf8')),
    ]);
    assert.deepEqual(first.sourceInputs.snapshot(root).files.map(file => file.path), ['source.ts']);
    assert.deepEqual(second.sourceInputs.snapshot(root).files.map(file => file.path), ['other.ts']);
  });
});

test('independent concurrent analysis caches keep identities isolated', async t => {
  const firstRoot = await workspace(t);
  const secondRoot = await workspace(t);
  await fs.writeFile(path.join(secondRoot, 'source.ts'), 'second analysis');
  const [first, second] = await Promise.all([firstRoot, secondRoot].map(root =>
    withAnalyzerFileReadCache(() => withAnalyzerFileReadTracking(() => fs.readFile(path.join(root, 'source.ts'), 'utf8')))
  ));
  assert.notEqual(first.sourceInputs.snapshot(firstRoot).files[0].sha256, second.sourceInputs.snapshot(secondRoot).files[0].sha256);
  assert.equal(first.sourceInputs.snapshot(firstRoot).outside_root_reads, 0);
  assert.equal(second.sourceInputs.snapshot(secondRoot).outside_root_reads, 0);
});

test('nested tracking retains child observations without borrowing sibling scope', async t => {
  const root = await workspace(t);
  const outer = await withAnalyzerFileReadCache(() => withAnalyzerFileReadTracking(async () => {
    const inner = await withAnalyzerFileReadTracking(() => fs.readFile(path.join(root, 'source.ts'), 'utf8'));
    return inner.sourceInputs.snapshot(root);
  }));
  assert.deepEqual(outer.sourceInputs.snapshot(root), outer.result);
});

test('read failures and unobserved output sources remain explicit', async t => {
  const root = await workspace(t);
  const tracked = await withAnalyzerFileReadCache(() => withAnalyzerFileReadTracking(async () => {
    await assert.rejects(fs.readFile(path.join(root, 'missing.ts'), 'utf8'), { code: 'ENOENT' });
  }));
  assert.deepEqual(tracked.sourceInputs.snapshot(root, ['unobserved.ts']).files, [
    { path: 'missing.ts', status: 'unavailable', reason: 'source-read-failed', error_code: 'ENOENT' },
    { path: 'unobserved.ts', status: 'unavailable', reason: 'source-not-observed' },
  ]);
});

test('mixed successful and unavailable reads preserve the consumed digest as conflicting evidence', async t => {
  const root = await workspace(t);
  const file = path.join(root, 'source.ts');
  const captured = sourceInputObservation('consumed', 'utf8');
  const unavailable = { status: 'unavailable' as const, reason: 'source-read-failed', error_code: 'EACCES' };
  for (const [first, second, reason] of [
    [captured, unavailable, 'captured-then-unavailable'],
    [unavailable, captured, 'unavailable-then-captured'],
  ] as const) {
    const capture = new AnalyzerSourceInputCapture();
    capture.observe(file, first);
    capture.observe(file, second);
    capture.observe(file, captured);
    const record = capture.snapshot(root).files[0];
    assert.equal(record.status, 'conflicting');
    assert.equal(record.sha256, captured.sha256);
    assert.equal(record.reason, reason);
    assert.equal(record.error_code, 'EACCES');
  }
});

test('outside-root represented files do not inflate the observed read count', async t => {
  const root = await workspace(t);
  const capture = new AnalyzerSourceInputCapture();
  assert.equal(capture.snapshot(root, [path.join(root, '..', 'not-read.ts')]).outside_root_reads, 0);
});

test('raw bytes and decoded text have explicit representations', async t => {
  const root = await workspace(t);
  const bytes = Buffer.from([0xff, 0x61]);
  await fs.writeFile(path.join(root, 'source.ts'), bytes);
  const raw = await withAnalyzerFileReadCache(() => withAnalyzerFileReadTracking(() => fs.readFile(path.join(root, 'source.ts'))));
  assert.equal(raw.sourceInputs.snapshot(root).files[0].sha256, digest(bytes));
  assert.equal(raw.sourceInputs.snapshot(root).files[0].representation, 'bytes');
  const text = await withAnalyzerFileReadCache(() => withAnalyzerFileReadTracking(() => fs.readFile(path.join(root, 'source.ts'), 'utf8')));
  assert.equal(text.sourceInputs.snapshot(root).files[0].sha256, digest(bytes.toString('utf8')));
  assert.notEqual(text.sourceInputs.snapshot(root).files[0].sha256, digest(bytes));
});

test('mutable buffers are observed again on cache hits', async t => {
  const root = await workspace(t);
  await withAnalyzerFileReadCache(async () => {
    const tracked = await withAnalyzerFileReadTracking(async () => {
      const buffer = await fs.readFile(path.join(root, 'source.ts'));
      buffer[0] = 0;
      await fs.readFile(path.join(root, 'source.ts'));
    });
    assert.equal(tracked.sourceInputs.snapshot(root).files[0].status, 'conflicting');
  });
});

test('unsupported encodings and outside-root reads cannot look complete', async t => {
  const root = await workspace(t);
  const capture = new AnalyzerSourceInputCapture();
  capture.observe(path.join(root, 'source.ts'), sourceInputObservation('6162', 'hex'));
  capture.observe(path.join(root, '..', 'outside.ts'), sourceInputObservation('outside', 'utf8'));
  const snapshot = capture.snapshot(root);
  assert.equal(snapshot.outside_root_reads, 1);
  assert.deepEqual(snapshot.files, [{ path: 'source.ts', status: 'unavailable', reason: 'unsupported-text-encoding' }]);
});

test('scope capture survives contribution caching and canonical metadata projection', async t => {
  const root = await workspace(t);
  const registration = {
    id: 'source-test', name: 'Source Test', version: '1', type: 'language' as const,
    analyzer: { getRelevantFiles: async () => ['source.ts'] } as unknown as BaseAnalyzer,
  };
  const contribution = await withAnalyzerFileReadCache(() => analyzeWithCompleteScope(
    registration, { projectPath: root, analysisRootPath: root }, async () => {
      await fs.readFile(path.join(root, 'source.ts'), 'utf8');
      return {
        nodes: [{ id: 'source', name: 'source', type: 'function', source: { file: 'source.ts', line: 1 } }],
        analyzer_metadata: { analyzer_id: registration.id, analyzer_name: registration.name, contribution_type: 'language' },
      } as CASContribution;
    },
  ));
  const identity = { sourceIdentity: 'source.ts', sourceContentHash: 'cache-key', analyzer: { id: 'source-test', version: '1' } };
  const cacheRoot = path.join(root, 'cache');
  const cache = new PersistentAnalyzerContributionCache({ rootPath: cacheRoot });
  assert.equal(await cache.put(identity, contribution), true);
  const restored = await new PersistentAnalyzerContributionCache({ rootPath: cacheRoot }).get(identity);
  assert.equal(restored.evidence.status, 'hit');
  assert.deepEqual(restored.contribution?.analyzer_metadata.source_inputs, contribution.analyzer_metadata.source_inputs);
  const summary = buildAnalyzerContributionSummary({ registration, result: restored.contribution!, executionTime: 1, filesCreated: 1, cacheStatus: 'hit' });
  assert.deepEqual(summary.source_inputs, contribution.analyzer_metadata.source_inputs);
  assert.equal(summary.source_inputs?.version, 1);
  assert.ok(summary.source_inputs?.version === 1);
  assert.equal(summary.source_inputs.files[0].sha256, digest('export const value = 1;\n'));
  assert.equal(summary.nodes_created, 1);
  assert.equal(summary.cache_status, 'hit');
});

test('legacy contribution metadata is never silently assigned a current digest', () => {
  const result: CASContribution = { analyzer_metadata: { analyzer_id: 'legacy', analyzer_name: 'Legacy', contribution_type: 'language' } };
  const summary = buildAnalyzerContributionSummary({
    registration: { id: 'legacy', name: 'Legacy', version: '1', type: 'language' },
    result, executionTime: 0, filesCreated: 0,
  });
  assert.equal(summary.source_inputs, undefined);
});

test('incremental rebuilds cannot reuse previous full-analysis input proofs', () => {
  const capture = new AnalyzerSourceInputCapture();
  capture.observe('/project/source.ts', sourceInputObservation('old content', 'utf8'));
  const contribution = {
    analyzer_id: 'language', analyzer_name: 'Language', contribution_type: 'language' as const,
    source_inputs: capture.snapshot('/project'),
  };
  const updated = invalidateIncrementalSourceInputs([contribution]);
  assert.equal(contribution.source_inputs.files[0].status, 'captured');
  assert.equal(updated[0].source_inputs?.coverage, 'unavailable');
  assert.equal(updated[0].source_inputs?.reason, 'incremental-input-identities-not-refreshed');
  assert.ok(updated[0].source_inputs?.version === 1);
  assert.deepEqual(updated[0].source_inputs.files, []);
  assert.equal(updated[0].analyzer_id, 'language');
});
