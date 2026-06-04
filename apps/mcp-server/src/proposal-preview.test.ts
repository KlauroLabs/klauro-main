import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs-extra';
import * as os from 'node:os';
import * as path from 'node:path';
import { analyzeProjectIncremental } from './analyzer';
import { getPreviewAnalysis, previewCodebaseIteration, previewGreenfieldCodebase } from './proposal-preview';

test('proposal preview analyzes an existing codebase iteration without mutating the real repo', async () => {
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-preview-storage-'));
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-preview-repo-'));
  const previousStorage = process.env.KLAURO_STORAGE_PATH;
  process.env.KLAURO_STORAGE_PATH = storage;

  try {
    await fs.ensureDir(path.join(repo, 'src'));
    await fs.writeJson(path.join(repo, 'package.json'), { dependencies: { express: '^4.18.0' } });
    await fs.writeFile(path.join(repo, 'src', 'app.ts'), [
      "import express from 'express';",
      'const app = express();',
      "app.get('/ready', (_req, res) => res.json({ ok: true }));",
      'export default app;',
      '',
    ].join('\n'));
    const original = await fs.readFile(path.join(repo, 'src', 'app.ts'), 'utf8');
    await analyzeProjectIncremental(repo);

    const result = await previewCodebaseIteration({
      path: repo,
      planText: 'Add a health route in a separate file.',
      proposedFiles: [{
        path: 'src/health.ts',
        status: 'added',
        content: [
          "import express from 'express';",
          'export const healthRouter = express.Router();',
          "healthRouter.get('/health', (_req, res) => res.json({ status: 'ok' }));",
          '',
        ].join('\n'),
      }],
      previewBaseUrl: 'https://app.klauro.test',
    }) as any;

    assert.ok(['fits', 'fits_with_warnings', 'insufficient_evidence'].includes(result.status));
    assert.equal(await fs.readFile(path.join(repo, 'src', 'app.ts'), 'utf8'), original);
    assert.equal(await fs.pathExists(path.join(repo, 'src', 'health.ts')), false);
    assert.ok(result.preview.preview_url.includes('/previews/'));
    assert.equal(result.preview.baseline_analysis_id !== result.preview.proposed_analysis_id, true);
    assert.ok(result.comparison.graph_delta.nodes_added >= 0);
  } finally {
    process.env.KLAURO_STORAGE_PATH = previousStorage;
    await fs.remove(repo);
    await fs.remove(storage);
  }
});

test('proposal preview returns needs_revision when a diff cannot apply', async () => {
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-preview-storage-'));
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-preview-repo-'));
  const previousStorage = process.env.KLAURO_STORAGE_PATH;
  process.env.KLAURO_STORAGE_PATH = storage;

  try {
    await fs.ensureDir(path.join(repo, 'src'));
    await fs.writeJson(path.join(repo, 'package.json'), { dependencies: { express: '^4.18.0' } });
    await fs.writeFile(path.join(repo, 'src', 'app.ts'), 'export const value = 1;\n');
    await analyzeProjectIncremental(repo);

    const result = await previewCodebaseIteration({
      path: repo,
      planText: 'Change a file that does not exist.',
      diffText: [
        'diff --git a/src/missing.ts b/src/missing.ts',
        'index 1111111..2222222 100644',
        '--- a/src/missing.ts',
        '+++ b/src/missing.ts',
        '@@ -1 +1 @@',
        '-missing',
        '+still missing',
        '',
      ].join('\n'),
    }) as any;

    assert.equal(result.status, 'needs_revision');
    assert.match(result.preview.preview_url, /previews/);
    assert.ok(result.comparison.required_checks.some((check: string) => check.includes('Revise proposal patch')));
  } finally {
    process.env.KLAURO_STORAGE_PATH = previousStorage;
    await fs.remove(repo);
    await fs.remove(storage);
  }
});

test('greenfield preview analyzes proposed files as a synthetic codebase', async () => {
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-preview-storage-'));
  const previousStorage = process.env.KLAURO_STORAGE_PATH;
  process.env.KLAURO_STORAGE_PATH = storage;

  try {
    const result = await previewGreenfieldCodebase({
      planText: 'Create a small FastAPI-style service.',
      proposedFiles: [
        { path: 'requirements.txt', content: 'fastapi\nuvicorn\n' },
        {
          path: 'app/main.py',
          content: [
            'from fastapi import FastAPI',
            'app = FastAPI()',
            "@app.get('/health')",
            'def health():',
            "    return {'ok': True}",
            '',
          ].join('\n'),
        },
      ],
      previewBaseUrl: 'https://app.klauro.test',
    }) as any;

    assert.ok(result.preview.proposed_analysis_id);
    assert.equal(result.preview.type, 'greenfield_codebase');
    assert.ok(result.preview.preview_url.includes('/previews/'));
    const payload = await getPreviewAnalysis(result.preview.id);
    assert.equal(payload.preview.id, result.preview.id);
    assert.ok(payload.proposed_cas.nodes.length > 0);
  } finally {
    process.env.KLAURO_STORAGE_PATH = previousStorage;
    await fs.remove(storage);
  }
});
