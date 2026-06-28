import test from 'node:test';
import assert from 'node:assert/strict';
import { runAnalysisFocusBenchmark } from './analysis-focus-benchmark';

test('analysis focus benchmark keeps required AI summaries while routing deeper layers explicitly', async () => {
  const report = await runAnalysisFocusBenchmark();
  assert.equal(report.status, 'pass');
  assert.equal(report.score, 100);
  assert.equal(report.summary.agent_fast_optional_work_units, 0);
  assert.equal(report.summary.agent_fast_optional_reduction_percent, 100);
  assert.ok(report.summary.agent_fast_total_reduction_percent >= 45);

  const agentFast = report.profiles.find(profile => profile.focus === 'agent-fast')!;
  const uiOverview = report.profiles.find(profile => profile.focus === 'ui-overview')!;
  const deepContext = report.profiles.find(profile => profile.focus === 'deep-context')!;

  assert.ok(agentFast.enabled_layers.includes('ai-system-narrative'));
  assert.ok(agentFast.enabled_layers.includes('ai-primary-capability-descriptions'));
  assert.ok(agentFast.deferred_layers.includes('ai-lazy-element-descriptions'));
  assert.ok(agentFast.deferred_layers.includes('semantic-embeddings'));
  assert.ok(uiOverview.enabled_layers.includes('ai-system-narrative'));
  assert.ok(uiOverview.enabled_layers.includes('ai-primary-capability-descriptions'));
  assert.ok(!uiOverview.enabled_layers.includes('semantic-embeddings'));
  assert.ok(deepContext.enabled_layers.includes('ai-system-narrative'));
  assert.ok(deepContext.enabled_layers.includes('ai-primary-capability-descriptions'));
  assert.ok(deepContext.enabled_layers.includes('semantic-embeddings'));
  assert.ok(!deepContext.enabled_layers.includes('ai-lazy-element-descriptions'));
});
