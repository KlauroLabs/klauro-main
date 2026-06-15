import assert from 'node:assert/strict';
import test from 'node:test';
import { runArchitecturePatternBenchmark } from './architecture-pattern-benchmark';

test('architecture pattern benchmark proves fixture inventory without pattern splurge', async () => {
  const report = await runArchitecturePatternBenchmark();

  assert.equal(report.status, 'pass');
  assert.equal(report.score, 100);
  assert.equal(report.summary.failed_gates, 0);

  const rails = report.targets.find(target => target.fixture === 'rails-work-orders');
  assert.ok(rails?.patterns.includes('MVC'));
  assert.ok(Number(rails?.inventory.models || 0) >= 2);
  assert.ok(Number(rails?.inventory.controllers || 0) >= 2);

  const flutter = report.targets.find(target => target.fixture === 'flutter-mobile-flow');
  assert.ok(flutter?.patterns.includes('Component/Page UI'));
  assert.ok(!flutter?.patterns.includes('Command Script / Automation'));

  const mixed = report.targets.find(target => target.fixture === 'mixed-architecture-pattern-proof');
  assert.ok(mixed);
  for (const pattern of ['MVVM', 'Repository', 'Mediator / Handler', 'Unit of Work', 'Singleton / Registry']) {
    assert.ok(mixed.patterns.includes(pattern), `${pattern} should be detected`);
  }
  assert.ok(Number(mixed.inventory.view_models || 0) >= 1);
  assert.ok(Number(mixed.inventory.repositories || 0) >= 1);
  assert.ok(Number(mixed.inventory.unit_of_work || 0) >= 1);
  assert.ok(Number(mixed.inventory.singletons || 0) >= 1);
  assert.equal(mixed.pattern_balance, 'balanced');

  const fragmented = report.targets.find(target => target.fixture === 'fragmented-architecture-drift-proof');
  assert.ok(fragmented);
  assert.equal(fragmented.pattern_balance, 'mixed');
  for (const pattern of ['MVC', 'MVVM', 'Singleton / Registry']) {
    assert.ok(fragmented.patterns.includes(pattern), `${pattern} should be detected`);
  }
});
