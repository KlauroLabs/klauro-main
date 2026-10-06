import assert from 'node:assert/strict';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import test from 'node:test';
import { runCapabilityInferenceBenchmark } from './capability-inference-benchmark';
import { startAuthorStub } from './gauntlet/author-stub-server';

const ENVIRONMENT = ['KLAURO_AUTHOR_ENDPOINT', 'KLAURO_AI_CACHE_PATH', 'KLAURO_ANALYSIS_IN_PROCESS'] as const;

test('capability inference benchmark prefers domain capabilities over framework entry noise', async () => {
  const previous = Object.fromEntries(ENVIRONMENT.map(name => [name, process.env[name]]));
  const cache = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-author-stub-cache-'));
  const stub = await startAuthorStub();
  process.env.KLAURO_AUTHOR_ENDPOINT = stub.endpoint;
  process.env.KLAURO_AI_CACHE_PATH = cache;
  process.env.KLAURO_ANALYSIS_IN_PROCESS = '1';
  let report;
  try {
    report = await runCapabilityInferenceBenchmark();
  } finally {
    await stub.close();
    await fs.remove(cache);
    for (const name of ENVIRONMENT) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }

  assert.ok(stub.asked().length > 0, 'the engine authored through the configured endpoint');
  assert.equal(report.status, 'pass', JSON.stringify(report));
  assert.equal(report.score, 100);
  assert.equal(report.summary.generic_capability_count, 0);
  const capabilityText = report.capabilities.map(capability => `${capability.name} ${capability.description || ''}`.toLowerCase());
  assert.ok(capabilityText.some(text => /fuel/.test(text)), `no fuel capability: ${capabilityText.join(' | ')}`);
  assert.ok(capabilityText.some(text => /vehicle|fleet/.test(text)), `no vehicle capability: ${capabilityText.join(' | ')}`);
  assert.ok(capabilityText.some(text => /invoice|settle|billing/.test(text)), `no invoice capability: ${capabilityText.join(' | ')}`);
});
