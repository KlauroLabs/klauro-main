import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { createOrchestrator } from './analyzer';

const TYPESCRIPT_ANALYZER_PATH = require.resolve('../../../packages/analyzer-core/src/analyzer/languages/typescript-javascript-analyzer');

test('analyzer registration listing and unmatched detection do not load lazy implementations', async () => {
  delete require.cache[TYPESCRIPT_ANALYZER_PATH];
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-lazy-analyzer-'));
  try {
    const orchestrator = createOrchestrator();
    const registration = orchestrator.listRegisteredAnalyzers().find(item => item.id === 'typescript-javascript');
    assert.equal(registration?.incremental, true);
    assert.equal(require.cache[TYPESCRIPT_ANALYZER_PATH], undefined);

    await orchestrator.detectAnalyzers(projectPath);
    assert.equal(require.cache[TYPESCRIPT_ANALYZER_PATH], undefined);
  } finally {
    await fs.remove(projectPath);
  }
});
