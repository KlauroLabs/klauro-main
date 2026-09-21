import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  readAnalysisMemoryCapacity,
  readHostAvailableMemory,
  readContainerMemory,
  type ContainerMemory,
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

function cacheStats(overrides: Record<string, number> = {}): string {
  return Object.entries({
    file: 1536 * MIB, inactive_file: 1280 * MIB, file_dirty: 64 * MIB,
    file_writeback: 32 * MIB, shmem: 128 * MIB, anon: 128 * MIB, ...overrides,
  }).map(([key, value]) => `${key} ${value}`).join('\n');
}

test('Linux host headroom uses kernel available memory while preserving the tighter container budget', () => {
  const available = readHostAvailableMemory(files({
    '/proc/meminfo': 'MemTotal: 8388608 kB\nMemFree: 524288 kB\nMemAvailable: 6291456 kB\n',
  }), 8 * GIB, 512 * MIB);
  assert.equal(available, 6 * GIB);
  const container = cachedContainer()!;
  const capacity = readAnalysisMemoryCapacity(container, 8 * GIB, available);
  assert.equal(capacity.availableBytes, 2080 * MIB);
});

test('unavailable or invalid host memory estimates fall back to unused RAM', () => {
  const fallback = 512 * MIB;
  assert.equal(readHostAvailableMemory(files({}), 8 * GIB, fallback), fallback);
  for (const info of [
    '', 'MemFree: 524288 kB', 'MemAvailable: -1 kB', 'MemAvailable: Infinity kB',
    'MemAvailable: 1.5 kB', 'MemAvailable: 6291456 MB', 'MemAvailable: 9437184 kB',
    'MemAvailable: 9007199254740991 kB', 'MemAvailable: 1 kB\nMemAvailable: 2 kB',
    'MemAvailable: unknown',
  ]) {
    assert.equal(readHostAvailableMemory(files({ '/proc/meminfo': info }), 8 * GIB, fallback), fallback);
  }
});

function cachedContainer(stat = cacheStats()): ContainerMemory | null {
  return readContainerMemory(files({
    '/sys/fs/cgroup/memory.max': String(3 * GIB),
    '/sys/fs/cgroup/memory.current': String(2 * GIB),
    '/sys/fs/cgroup/memory.stat': stat,
  }));
}

test('credits only clean inactive file cache without changing raw cgroup usage or worker reserves', () => {
  const container = cachedContainer()!;
  assert.deepEqual(container, { limit: 3 * GIB, usage: 2 * GIB, reclaimableFileBytes: 1056 * MIB });
  const capacity = readAnalysisMemoryCapacity(container, 8 * GIB, 6 * GIB);
  assert.equal(capacity.availableBytes, 2080 * MIB);
  const hostLimited = readAnalysisMemoryCapacity(container, 8 * GIB, 128 * MIB);
  assert.equal(hostLimited.availableBytes, 128 * MIB);
});

test('active, dirty, shared and anonymous pages do not turn into reclaimable capacity', () => {
  const pageCounters: Array<Record<string, number>> = [
    { inactive_file: 0 }, { file_dirty: 1536 * MIB }, { file_writeback: 1536 * MIB },
    { shmem: 1536 * MIB }, { anon: 2 * GIB },
  ];
  for (const overrides of pageCounters) {
    assert.equal(cachedContainer(cacheStats(overrides))?.reclaimableFileBytes, undefined);
  }
  assert.equal(cachedContainer(cacheStats({ file: 128 * MIB }))?.reclaimableFileBytes, undefined);
  assert.equal(cachedContainer(cacheStats({ anon: 1920 * MIB }))?.reclaimableFileBytes, 128 * MIB);
});

test('unavailable or malformed cache statistics retain conservative raw usage', () => {
  for (const stat of [
    '', 'file 1024', cacheStats().replace('file_dirty 67108864', ''),
    cacheStats({ file: -1 }), cacheStats({ inactive_file: Infinity }),
    cacheStats({ shmem: Number.MAX_SAFE_INTEGER + 1 }), cacheStats() + '\nfile 1024',
  ]) {
    assert.deepEqual(cachedContainer(stat), { limit: 3 * GIB, usage: 2 * GIB });
  }
});

test('cgroup v1 cache accounting uses hierarchical counters and ignores unrelated unlimited sentinels', () => {
  const container = readContainerMemory(files({
    '/sys/fs/cgroup/memory.max': 'max',
    '/sys/fs/cgroup/memory/memory.limit_in_bytes': String(3 * GIB),
    '/sys/fs/cgroup/memory/memory.usage_in_bytes': String(2 * GIB),
    '/sys/fs/cgroup/memory/memory.stat': [
      'hierarchical_memsw_limit 9223372036854771712', `total_cache ${1536 * MIB}`,
      `total_inactive_file ${1280 * MIB}`, `total_dirty ${64 * MIB}`,
      `total_writeback ${32 * MIB}`, `total_shmem ${128 * MIB}`, `total_rss ${128 * MIB}`,
      'cache 0', 'inactive_file 0',
    ].join('\n'),
  }));
  assert.deepEqual(container, { limit: 3 * GIB, usage: 2 * GIB, reclaimableFileBytes: 1056 * MIB });
});

test('uses the larger usage sample around cache statistics and refuses an unknown second sample', () => {
  for (const samples of [[2 * GIB, 2304 * MIB], [2304 * MIB, 2 * GIB]]) {
    let index = 0;
    const read = files({
      '/sys/fs/cgroup/memory.max': String(3 * GIB),
      '/sys/fs/cgroup/memory.stat': cacheStats(),
    });
    const container = readContainerMemory(file => file.endsWith('/memory.current') ? String(samples[index++]) : read(file));
    assert.equal(container?.usage, 2304 * MIB);
  }
  let samples = 0;
  const read = files({
    '/sys/fs/cgroup/memory.max': String(3 * GIB),
    '/sys/fs/cgroup/memory.stat': cacheStats(),
  });
  const container = readContainerMemory(file => file.endsWith('/memory.current') ? (++samples === 1 ? String(2 * GIB) : 'unknown') : read(file));
  assert.deepEqual(container, { limit: 3 * GIB, usage: null });
});

test('invalid injected cache credits cannot inflate admission headroom', () => {
  for (const reclaimableFileBytes of [-1, Infinity, NaN, 2 * GIB + 1, 0.5]) {
    assert.equal(readAnalysisMemoryCapacity({ limit: 3 * GIB, usage: 2 * GIB, reclaimableFileBytes }, 8 * GIB, 6 * GIB).availableBytes, GIB);
  }
});

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

