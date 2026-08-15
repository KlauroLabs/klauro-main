import test from 'node:test';
import assert from 'node:assert/strict';
import { runWorkspaceAgentBenchmark } from './workspace-agent-benchmark';

test('workspace benchmark fails when no cross-repository tasks are exercised', async () => {
  const report = await runWorkspaceAgentBenchmark({ families: [] });

  assert.equal(report.status, 'fail');
  assert.equal(report.summary.workspace_count, 0);
  assert.equal(report.summary.cross_repo_task_count, 0);
});
