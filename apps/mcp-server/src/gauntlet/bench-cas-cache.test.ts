import assert from 'node:assert/strict';
import * as fs from 'fs-extra';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import type { CASOutput } from '../../../../packages/analyzer-core/src/types/cas.types';
import { benchCasCacheRuntimeFingerprint, readBenchCasCache, writeBenchCasCache } from './bench-cas-cache';

test('bench CAS cache round-trips structured graph data atomically', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-bench-cas-cache-'));
  const file = path.join(directory, 'analysis.cas.v8');
  const cas = {
    system: { id: 'system_test', name: 'test', root_path: '/test' },
    nodes: [{ id: 'node_a', name: 'a', type: 'function' }],
    edges: [{ id: 'edge_a', source: 'node_a', target: 'node_a', type: 'calls' }],
  } as CASOutput;
  try {
    await writeBenchCasCache(file, cas);
    assert.deepEqual(await readBenchCasCache(file), cas);
    assert.match(benchCasCacheRuntimeFingerprint(), /^v8-structured-clone:/);
    assert.deepEqual(await fs.readdir(directory), ['analysis.cas.v8']);
  } finally {
    await fs.remove(directory);
  }
});

test('bench CAS cache treats missing and invalid entries as misses', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-bench-cas-invalid-'));
  const file = path.join(directory, 'analysis.cas.v8');
  try {
    assert.equal(await readBenchCasCache(file), undefined);
    await fs.writeFile(file, 'not a structured clone');
    assert.equal(await readBenchCasCache(file), undefined);
  } finally {
    await fs.remove(directory);
  }
});
