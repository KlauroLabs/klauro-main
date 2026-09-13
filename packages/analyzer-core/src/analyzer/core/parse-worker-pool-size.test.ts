import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWorkerCount, MAX_PARSE_WORKERS } from './parse-worker-pool-size';

// How many tree-sitter parse workers to start. This used to be hard-coded to at
// most two regardless of the machine, which on a ten-core host left the parse
// phase running at roughly a fifth of the available speed. It is now bounded by
// three things at once: the number of files, the number of cores, and how much
// memory the workers would be allowed to claim. The memory bound matters
// because analysis runs in a container with a fixed budget, and each worker is
// permitted its own heap.

const HEAP = 768;
const ROOMY = 32_768;

test('a ten-core host with room runs the full pool', () => {
  assert.equal(parseWorkerCount({ fileCount: 5000, cores: 10, workerHeapMb: HEAP, memoryCeilingMb: ROOMY }), MAX_PARSE_WORKERS);
});

test('small hosts leave one core for the main thread', () => {
  assert.equal(parseWorkerCount({ fileCount: 5000, cores: 4, workerHeapMb: HEAP, memoryCeilingMb: ROOMY }), 3);
  assert.equal(parseWorkerCount({ fileCount: 5000, cores: 2, workerHeapMb: HEAP, memoryCeilingMb: ROOMY }), 1);
  assert.equal(parseWorkerCount({ fileCount: 5000, cores: 1, workerHeapMb: HEAP, memoryCeilingMb: ROOMY }), 1);
});

test('the pool never exceeds the cap, however many cores there are', () => {
  assert.equal(parseWorkerCount({ fileCount: 5000, cores: 128, workerHeapMb: HEAP, memoryCeilingMb: ROOMY }), MAX_PARSE_WORKERS);
});

test('a tight memory ceiling shrinks the pool before the cores do', () => {
  // Half the ceiling is the share the pool may claim, so 3 GB of headroom
  // allows one 768 MB worker, not four.
  assert.equal(parseWorkerCount({ fileCount: 5000, cores: 10, workerHeapMb: HEAP, memoryCeilingMb: 3072 }), 2);
  assert.equal(parseWorkerCount({ fileCount: 5000, cores: 10, workerHeapMb: HEAP, memoryCeilingMb: 1536 }), 1);
  assert.equal(parseWorkerCount({ fileCount: 5000, cores: 10, workerHeapMb: HEAP, memoryCeilingMb: 200 }), 1);
});

test('a smaller per-worker heap buys more workers from the same memory', () => {
  assert.equal(parseWorkerCount({ fileCount: 5000, cores: 10, workerHeapMb: 256, memoryCeilingMb: 3072 }), 6);
});

test('never more workers than files', () => {
  assert.equal(parseWorkerCount({ fileCount: 3, cores: 10, workerHeapMb: HEAP, memoryCeilingMb: ROOMY }), 3);
  assert.equal(parseWorkerCount({ fileCount: 0, cores: 10, workerHeapMb: HEAP, memoryCeilingMb: ROOMY }), 1);
});

test('an explicit setting overrides the cores and memory bounds, but not the file count', () => {
  assert.equal(parseWorkerCount({ fileCount: 5000, configured: '12', cores: 2, workerHeapMb: HEAP, memoryCeilingMb: 512 }), 12);
  assert.equal(parseWorkerCount({ fileCount: 2, configured: '12', cores: 10, workerHeapMb: HEAP, memoryCeilingMb: ROOMY }), 2);
});

test('a meaningless setting falls back to the computed bounds', () => {
  for (const configured of ['', '0', '-4', 'many', undefined]) {
    assert.equal(
      parseWorkerCount({ fileCount: 5000, configured, cores: 10, workerHeapMb: HEAP, memoryCeilingMb: ROOMY }),
      MAX_PARSE_WORKERS,
      `configured=${String(configured)}`
    );
  }
});

test('unknown memory or heap does not collapse the pool to one', () => {
  assert.equal(parseWorkerCount({ fileCount: 5000, cores: 10, workerHeapMb: 0, memoryCeilingMb: ROOMY }), MAX_PARSE_WORKERS);
  assert.equal(parseWorkerCount({ fileCount: 5000, cores: 10, workerHeapMb: HEAP, memoryCeilingMb: 0 }), MAX_PARSE_WORKERS);
});
