import assert from 'node:assert/strict';
import test from 'node:test';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'fs-extra';
import { analyzeProject } from './analyzer';
import { getAnalysisEntry } from './storage';

test('cold analysis reads source without reusing or persisting stored context', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-cold-analysis-'));
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-cold-storage-'));
  const previousStorage = process.env.KLAURO_STORAGE_PATH;
  const previousAi = process.env.KLAURO_AI_ENABLED;
  process.env.KLAURO_STORAGE_PATH = storage;
  process.env.KLAURO_AI_ENABLED = 'false';
  try {
    await fs.outputJson(path.join(root, 'package.json'), { name: 'cold-analysis-fixture' });
    await fs.outputFile(path.join(root, 'src', 'index.ts'), 'export function run() { return 1; }\n');
    const output = await analyzeProject(root, undefined, { reuseStoredContext: false, persist: false });
    assert.ok(output.nodes.length > 0);
    assert.equal(await getAnalysisEntry(root), null);
  } finally {
    if (previousStorage === undefined) delete process.env.KLAURO_STORAGE_PATH;
    else process.env.KLAURO_STORAGE_PATH = previousStorage;
    if (previousAi === undefined) delete process.env.KLAURO_AI_ENABLED;
    else process.env.KLAURO_AI_ENABLED = previousAi;
    await fs.remove(root);
    await fs.remove(storage);
  }
});
