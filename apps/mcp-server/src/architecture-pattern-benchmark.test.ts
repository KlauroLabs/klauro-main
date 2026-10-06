import assert from 'node:assert/strict';
import test from 'node:test';
import { runArchitecturePatternBenchmark } from './architecture-pattern-benchmark';
import { patternNamed } from './architecture-pattern-vocabulary';

test('architecture pattern names are compared case- and vocabulary-normalised', () => {
  assert.ok(patternNamed(['Model-View-Controller'], 'MVC'));
  assert.ok(patternNamed(['model view viewmodel'], 'MVVM'));
  assert.ok(patternNamed(['unit of work'], 'Unit of Work'));
  assert.ok(patternNamed(['mediator'], 'Mediator / Handler'));
  assert.ok(!patternNamed(['monolith', 'HTTP API'], 'MVC'));
});

test('architecture pattern benchmark proves the engine names the patterns the fixtures hold without pattern splurge', async () => {
  const report = await runArchitecturePatternBenchmark();

  assert.equal(report.status, 'pass', JSON.stringify(report.targets.flatMap(target => target.gates.filter(gate => gate.status !== 'pass'))));
  assert.equal(report.score, 100);
  assert.equal(report.summary.failed_gates, 0);

  const rails = report.targets.find(target => target.fixture === 'rails-work-orders');
  assert.ok(rails && patternNamed(rails.patterns, 'MVC'));

  const flutter = report.targets.find(target => target.fixture === 'flutter-mobile-flow');
  assert.ok(flutter && !patternNamed(flutter.patterns, 'Command Script / Automation'));

  const mixed = report.targets.find(target => target.fixture === 'mixed-architecture-pattern-proof');
  assert.ok(mixed);
  for (const pattern of ['MVVM', 'Repository', 'Mediator / Handler', 'Unit of Work', 'Singleton / Registry']) {
    assert.ok(patternNamed(mixed.patterns, pattern), `${pattern} should be detected; engine named ${mixed.patterns.join(', ')}`);
  }

  const fragmented = report.targets.find(target => target.fixture === 'fragmented-architecture-drift-proof');
  assert.ok(fragmented);
  for (const pattern of ['MVC', 'MVVM', 'Singleton / Registry']) {
    assert.ok(patternNamed(fragmented.patterns, pattern), `${pattern} should be detected; engine named ${fragmented.patterns.join(', ')}`);
  }
});
