import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  AnalysisMemoryCapacityError,
  analysisWorkerMemoryRequiredBytes,
  assertAnalysisWorkerMemoryAvailable,
  readAnalysisMemoryCapacity,
  readContainerMemory,
} from './analysis-memory';
import { resolveAnalysisHeapMb } from './analysis-heap';

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

function files(values: Record<string, string>): (file: string) => string {
  return file => {
    if (!(file in values)) throw new Error('ENOENT');
    return values[file];
  };
}

test('reads finite cgroup v2 capacity and all resident usage', () => {
  assert.deepEqual(readContainerMemory(files({
    '/sys/fs/cgroup/memory.max': String(6 * GIB),
    '/sys/fs/cgroup/memory.current': String(4 * GIB),
  })), { limit: 6 * GIB, usage: 4 * GIB });
});

test('falls back to finite cgroup v1 and rejects unlimited sentinels', () => {
  assert.deepEqual(readContainerMemory(files({
    '/sys/fs/cgroup/memory.max': 'max',
    '/sys/fs/cgroup/memory/memory.limit_in_bytes': String(3 * GIB),
    '/sys/fs/cgroup/memory/memory.usage_in_bytes': String(GIB),
  })), { limit: 3 * GIB, usage: GIB });
  for (const unlimited of ['9223372036854771712', '1099511627776', 'max', '-1', '']) {
    assert.equal(readContainerMemory(files({
      '/sys/fs/cgroup/memory/memory.limit_in_bytes': unlimited,
    })), null);
  }
});

test('a known container limit is retained when its current usage cannot be read', () => {
  const container = readContainerMemory(files({ '/sys/fs/cgroup/memory.max': String(GIB) }));
  const capacity = readAnalysisMemoryCapacity(container, 64 * GIB, 32 * GIB);
  assert.deepEqual(capacity, { limitBytes: GIB, availableBytes: null, source: 'cgroup' });
  assert.throws(() => assertAnalysisWorkerMemoryAvailable(256, undefined, capacity), AnalysisMemoryCapacityError);
});

test('uses the tighter physical or container headroom and never negative capacity', () => {
  assert.deepEqual(readAnalysisMemoryCapacity({ limit: 6 * GIB, usage: 4 * GIB }, 64 * GIB, 32 * GIB), {
    limitBytes: 6 * GIB, availableBytes: 2 * GIB, source: 'cgroup',
  });
  assert.equal(readAnalysisMemoryCapacity({ limit: 6 * GIB, usage: GIB }, 4 * GIB, GIB).availableBytes, GIB);
  assert.equal(readAnalysisMemoryCapacity({ limit: GIB, usage: 2 * GIB }, 4 * GIB, GIB).availableBytes, 0);
  assert.deepEqual(readAnalysisMemoryCapacity(null, 8 * GIB, 3 * GIB), {
    limitBytes: 8 * GIB, availableBytes: 3 * GIB, source: 'host',
  });
});

test('heap defaults are capped by the effective container limit rather than host RAM', () => {
  const capacity = readAnalysisMemoryCapacity({ limit: GIB, usage: 128 * MIB }, 64 * GIB, 32 * GIB);
  assert.equal(resolveAnalysisHeapMb({}, capacity.limitBytes).heapMb, 512);
  assert.equal(resolveAnalysisHeapMb({ KLAURO_ANALYSIS_HEAP_MB: '4096' }, capacity.limitBytes).heapMb, 4096);
});

test('reserves native overhead and API growth beyond the V8 heap', () => {
  assert.equal(analysisWorkerMemoryRequiredBytes(4096), 5376 * MIB);
  assert.equal(analysisWorkerMemoryRequiredBytes(512), 1024 * MIB);
  assert.equal(analysisWorkerMemoryRequiredBytes(512, 400 * MIB), 624 * MIB);
  assert.equal(analysisWorkerMemoryRequiredBytes(512, 2 * GIB), 256 * MIB);
});

test('rejects the observed 6 GiB container and 4 GiB resident-parent shape before starting a 4 GiB worker', () => {
  const capacity = readAnalysisMemoryCapacity({ limit: 6 * GIB, usage: 4 * GIB }, 8 * GIB, 4 * GIB);
  assert.throws(() => assertAnalysisWorkerMemoryAvailable(4096, undefined, capacity), (error: unknown) => {
    assert.ok(error instanceof AnalysisMemoryCapacityError);
    assert.equal(error.code, 'analysis_memory_capacity_exhausted');
    assert.equal(error.requiredBytes, 5376 * MIB);
    assert.match(error.message, /2048 MiB available.*6144 MiB cgroup budget/);
    assert.match(error.message, /No source or analysis scope was reduced/);
    return true;
  });
});

test('admits the same configured heap when the parent is small without lowering it', () => {
  const capacity = readAnalysisMemoryCapacity({ limit: 6 * GIB, usage: 240 * MIB }, 8 * GIB, 6 * GIB);
  assert.doesNotThrow(() => assertAnalysisWorkerMemoryAvailable(4096, undefined, capacity));
});

test('rechecks headroom rather than caching a successful admission', () => {
  const capacity = { limitBytes: 3 * GIB, availableBytes: 2 * GIB, source: 'cgroup' as const };
  assert.doesNotThrow(() => assertAnalysisWorkerMemoryAvailable(1024, undefined, capacity));
  capacity.availableBytes = GIB;
  assert.throws(() => assertAnalysisWorkerMemoryAvailable(1024, undefined, capacity), AnalysisMemoryCapacityError);
  capacity.availableBytes = 2 * GIB;
  assert.doesNotThrow(() => assertAnalysisWorkerMemoryAvailable(1024, undefined, capacity));
});
