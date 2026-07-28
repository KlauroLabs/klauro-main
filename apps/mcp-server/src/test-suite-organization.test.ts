import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';

interface Plan {
  group: string;
  concurrency: number;
  files: Array<{ file: string; weight: number }>;
}

function plan(...args: string[]): Plan {
  const result = spawnSync(process.execPath, [path.resolve('scripts/test-suite.mjs'), '--list', ...args], {
    cwd: path.resolve('.'),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout) as Plan;
}

test('suite groups partition every test without overlap or omission', () => {
  const all = plan();
  const core = plan('--group', 'core');
  const gauntlet = plan('--group', 'gauntlet');
  const combined = new Set([...core.files, ...gauntlet.files].map(item => item.file));

  assert.equal(combined.size, all.files.length);
  assert.deepEqual([...combined].sort(), all.files.map(item => item.file).sort());
  assert.ok(core.files.every(item => !item.file.startsWith('src/gauntlet/')));
  assert.ok(gauntlet.files.every(item => item.file.startsWith('src/gauntlet/')));
});

test('suite planner runs expensive files first and keeps deterministic ordering', () => {
  const first = plan();
  const second = plan();
  assert.deepEqual(first.files, second.files);
  assert.ok(first.files.every((item, index) => index === 0 || first.files[index - 1].weight >= item.weight));
});

test('suite concurrency is bounded and explicitly configurable', () => {
  assert.ok(plan().concurrency >= 1 && plan().concurrency <= 3);
  assert.equal(plan('--concurrency', '2').concurrency, 2);
  const invalid = spawnSync(process.execPath, [path.resolve('scripts/test-suite.mjs'), '--list', '--concurrency', '0'], {
    cwd: path.resolve('.'),
    encoding: 'utf8',
  });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /positive integer/);
});

test('suite can select an exact test file without changing group membership', () => {
  const selected = plan('--file', 'src/test-suite-organization.test.ts');
  assert.deepEqual(selected.files.map(item => item.file), ['src/test-suite-organization.test.ts']);
});
