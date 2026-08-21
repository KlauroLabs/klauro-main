import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveWorkspaceAnalysisHeapMb, resolveWorkspacePreviousRecordMaxBytes, runAccountWorkspaceAnalysisWorker } from './account-workspace-analysis-process';

test('workspace analysis uses its own bounded heap budget', () => {
  assert.equal(resolveWorkspaceAnalysisHeapMb({ KLAURO_ANALYSIS_HEAP_MB: '4096' } as NodeJS.ProcessEnv), 1024);
  assert.equal(resolveWorkspaceAnalysisHeapMb({ KLAURO_WORKSPACE_ANALYSIS_HEAP_MB: '2048' } as NodeJS.ProcessEnv), 2048);
});

test('previous workspace reuse is bounded by the isolated worker heap', () => {
  assert.equal(resolveWorkspacePreviousRecordMaxBytes({ KLAURO_WORKSPACE_ANALYSIS_HEAP_MB: '1024' } as NodeJS.ProcessEnv), 128 * 1024 * 1024);
  assert.equal(resolveWorkspacePreviousRecordMaxBytes({ KLAURO_WORKSPACE_PREVIOUS_RECORD_MAX_BYTES: '4096' } as NodeJS.ProcessEnv), 4096);
});

test('workspace analysis CPU and heap work stays outside the API event loop', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-workspace-worker-'));
  const entry = path.join(root, 'worker.cjs');
  const previousEntry = process.env.KLAURO_WORKSPACE_ANALYSIS_WORKER_ENTRY;
  fs.writeFileSync(entry, `
process.once('message', () => {
  const started = Date.now();
  const retained = [];
  while (Date.now() - started < 300) retained.push(Buffer.alloc(1024));
  process.send({ type: 'result' });
});
`);
  process.env.KLAURO_WORKSPACE_ANALYSIS_WORKER_ENTRY = entry;
  let ticks = 0;
  const timer = setInterval(() => { ticks += 1; }, 10);
  try {
    await runAccountWorkspaceAnalysisWorker(root, 'workspace-large', false);
    assert.ok(ticks >= 10, `API event loop advanced only ${ticks} times during isolated CPU work`);
  } finally {
    clearInterval(timer);
    if (previousEntry === undefined) delete process.env.KLAURO_WORKSPACE_ANALYSIS_WORKER_ENTRY;
    else process.env.KLAURO_WORKSPACE_ANALYSIS_WORKER_ENTRY = previousEntry;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
