import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-structural-layer-'));
process.env.KLAURO_STORAGE_PATH = path.join(root, 'storage');
process.env.KLAURO_LOG_DIR = path.join(root, 'logs');
const heard = path.join(root, 'heard');
const engine = path.join(root, 'engine.sh');
fs.writeFileSync(engine, `#!/bin/sh\necho "KLAURO_ENRICH=$KLAURO_ENRICH" >> "${heard}"\nexit 1\n`, { mode: 0o755 });
process.env.KLAURO_ENGINE = engine;

test.after(() => fs.removeSync(root));

test('a project analysed for the first time is read without AI before comprehension runs', async () => {
  const { publishStructuralLayer } = await import('./structural-layer');
  const project = path.join(root, 'fresh');
  await fs.outputFile(path.join(project, 'main.py'), 'print(1)\n');
  await publishStructuralLayer(project, 'fresh');
  assert.equal(fs.readFileSync(heard, 'utf8').trim(), 'KLAURO_ENRICH=0');
});

test('a project that already has an analysis keeps it while comprehension runs', async () => {
  const { publishStructuralLayer } = await import('./structural-layer');
  const { saveAnalysis } = await import('./storage');
  const project = path.join(root, 'kept');
  await fs.outputFile(path.join(project, 'main.py'), 'print(1)\n');
  await saveAnalysis(project, { system: { id: 'system_kept', name: 'kept' }, analysis_timestamp: new Date().toISOString(), nodes: [{ id: 'n1' }], edges: [] } as unknown as CASOutput);
  fs.removeSync(heard);
  await publishStructuralLayer(project, 'kept');
  assert.equal(fs.existsSync(heard), false);
});
