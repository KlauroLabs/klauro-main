import { test } from 'node:test';
import * as assert from 'node:assert';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs-extra';
import { purgeAll, purgeProject } from './purge';
import { aiCacheProjectScope } from '../../../packages/analyzer-core/src/ai/ai-cache';
import { formatBuildIdentity, getBuildIdentity } from '../../../packages/analyzer-core/src/analyzer/core/build-identity';

interface Fixture {
  klauroRoot: string;
  analysesDir: string;
  aiCacheDir: string;
  runLogPath: string;
  projectPath: string;
  otherProjectPath: string;
  slug: string;
  otherSlug: string;
}

async function buildFixture(): Promise<Fixture> {
  const klauroRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-purge-test-'));
  const analysesDir = path.join(klauroRoot, 'analyses');
  const aiCacheDir = path.join(klauroRoot, 'ai-cache');
  const logsDir = path.join(klauroRoot, 'logs');
  const runLogPath = path.join(logsDir, 'analysis-runs.jsonl');
  const projectPath = path.join(klauroRoot, 'projects', 'alpha');
  const otherProjectPath = path.join(klauroRoot, 'projects', 'beta');
  const slug = aiCacheProjectScope(projectPath);
  const otherSlug = aiCacheProjectScope(otherProjectPath);

  for (const target of [projectPath, otherProjectPath]) {
    await fs.ensureDir(target);
  }
  for (const s of [slug, otherSlug]) {
    await fs.outputJson(path.join(analysesDir, `${s}.json`), { nodes: [] });
    await fs.outputFile(path.join(analysesDir, `${s}.json.zst`), 'compressed');
    await fs.outputJson(path.join(analysesDir, s, 'incremental-state.json'), { files: {} });
    await fs.outputFile(path.join(analysesDir, s, 'snapshots', 'snapshot-1.json.zst'), 'snap');
    await fs.outputFile(path.join(analysesDir, s, 'file-cache', 'abc.json'), '{}');
    await fs.outputFile(path.join(analysesDir, s, 'embeddings', 'index.bin'), 'vec');
    await fs.outputJson(path.join(analysesDir, s, 'ingested-telemetry', '2026-06-10.json'), []);
    await fs.outputJson(path.join(analysesDir, s, 'element-descriptions.json'), { entries: {} });
  }
  await fs.outputJson(path.join(analysesDir, 'index.json'), {
    analyses: {
      [projectPath]: { name: 'alpha', path: projectPath, file: `${slug}.json` },
      [otherProjectPath]: { name: 'beta', path: otherProjectPath, file: `${otherSlug}.json` },
    },
  });
  await fs.outputFile(runLogPath, [
    JSON.stringify({ run_id: 'r1', event: 'run-start', project_path: projectPath }),
    JSON.stringify({ run_id: 'r1', event: 'run-complete', project_path: projectPath }),
    JSON.stringify({ run_id: 'r2', event: 'run-complete', project_path: otherProjectPath }),
  ].join('\n') + '\n');
  await fs.outputJson(path.join(aiCacheDir, slug, 'deadbeef.json'), { data: 'scoped', project: slug });
  await fs.outputJson(path.join(aiCacheDir, otherSlug, 'cafef00d.json'), { data: 'other', project: otherSlug });
  await fs.outputJson(path.join(aiCacheDir, 'legacy1.json'), { data: 'legacy' });
  await fs.outputJson(path.join(aiCacheDir, 'legacy2.json'), { data: 'legacy' });

  return { klauroRoot, analysesDir, aiCacheDir, runLogPath, projectPath, otherProjectPath, slug, otherSlug };
}

test('purgeProject removes all per-project state and reports legacy ai-cache entries', async () => {
  const fixture = await buildFixture();
  try {
    const report = await purgeProject(fixture.projectPath, { roots: fixture });

    assert.strictEqual(report.slug, fixture.slug);
    assert.strictEqual(await fs.pathExists(path.join(fixture.analysesDir, `${fixture.slug}.json`)), false);
    assert.strictEqual(await fs.pathExists(path.join(fixture.analysesDir, `${fixture.slug}.json.zst`)), false);
    assert.strictEqual(await fs.pathExists(path.join(fixture.analysesDir, fixture.slug)), false);
    assert.strictEqual(await fs.pathExists(path.join(fixture.aiCacheDir, fixture.slug)), false);

    assert.strictEqual(report.index_entry_removed, true);
    const index = await fs.readJson(path.join(fixture.analysesDir, 'index.json'));
    assert.strictEqual(fixture.projectPath in index.analyses, false);
    assert.strictEqual(fixture.otherProjectPath in index.analyses, true);

    assert.strictEqual(report.run_log_entries_removed, 2);
    const runLog = await fs.readFile(fixture.runLogPath, 'utf8');
    assert.strictEqual(runLog.includes(fixture.projectPath), false);
    assert.strictEqual(runLog.includes(fixture.otherProjectPath), true);

    assert.strictEqual(report.ai_cache.project_entries_removed, 1);
    assert.strictEqual(report.ai_cache.unassociated_entries_remaining, 2);
    assert.strictEqual(report.ai_cache.all_ai_cache_removed, false);
    assert.ok(report.notes.some(note => note.includes('--all-ai-cache')));

    // The other project's data is untouched.
    assert.strictEqual(await fs.pathExists(path.join(fixture.analysesDir, `${fixture.otherSlug}.json`)), true);
    assert.strictEqual(await fs.pathExists(path.join(fixture.analysesDir, fixture.otherSlug)), true);
    assert.strictEqual(await fs.pathExists(path.join(fixture.aiCacheDir, fixture.otherSlug)), true);
    assert.strictEqual(await fs.pathExists(path.join(fixture.aiCacheDir, 'legacy1.json')), true);
  } finally {
    await fs.remove(fixture.klauroRoot);
  }
});

test('purgeProject --all-ai-cache removes the entire shared AI cache', async () => {
  const fixture = await buildFixture();
  try {
    const report = await purgeProject(fixture.projectPath, { allAiCache: true, roots: fixture });
    assert.strictEqual(report.ai_cache.all_ai_cache_removed, true);
    assert.strictEqual(report.ai_cache.unassociated_entries_remaining, 0);
    assert.strictEqual(await fs.pathExists(fixture.aiCacheDir), false);
  } finally {
    await fs.remove(fixture.klauroRoot);
  }
});

test('purgeProject on an unknown project reports that nothing was found', async () => {
  const fixture = await buildFixture();
  try {
    await fs.remove(fixture.aiCacheDir);
    const report = await purgeProject(path.join(fixture.klauroRoot, 'projects', 'never-analyzed'), { roots: fixture });
    assert.strictEqual(report.removed.length, 0);
    assert.strictEqual(report.index_entry_removed, false);
    assert.strictEqual(report.run_log_entries_removed, 0);
    assert.ok(report.notes.some(note => note.includes('No stored Klauro data found')));
  } finally {
    await fs.remove(fixture.klauroRoot);
  }
});

test('purgeAll removes the entire storage root', async () => {
  const fixture = await buildFixture();
  const report = await purgeAll({ roots: fixture });
  assert.strictEqual(await fs.pathExists(fixture.klauroRoot), false);
  assert.deepStrictEqual(report.removed, [fixture.klauroRoot]);
  assert.ok(report.notes.some(note => note.includes('klauro uninstall')));
});

test('build identity reports a versioned dev or bundle build, never bare 1.0.0', () => {
  const identity = getBuildIdentity();
  assert.ok(identity.version.includes('+'), `expected build metadata in ${identity.version}`);
  assert.ok(['bundle', 'dev'].includes(identity.channel));
  assert.ok(identity.git_sha.length > 0);
  if (identity.channel === 'dev') {
    assert.match(identity.version, /-dev\+/);
    assert.match(formatBuildIdentity(), /dev checkout/);
  } else {
    assert.ok(identity.build_time, 'bundle builds must carry a build time');
  }
});
