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

test('fast/bench groups partition every test by ROLE, not by directory, without overlap or omission', () => {
  const all = plan();
  const fast = plan('--group', 'fast');
  const bench = plan('--group', 'bench');
  const combined = new Set([...fast.files, ...bench.files].map(item => item.file));

  assert.equal(combined.size, all.files.length);
  assert.deepEqual([...combined].sort(), all.files.map(item => item.file).sort());

  // The whole point of the fast/bench split: a benchmark sitting directly in
  // src/ (not under src/gauntlet/) must land in `bench`, not `fast` — this is
  // exactly the class of file the old core/gauntlet directory-based split let
  // slip into the pre-deploy gate.
  const knownStraySrcBenchmarks = [
    'src/agent-existing-task-benchmark.test.ts',
    'src/competitor-baseline-benchmark.test.ts',
    'src/architecture-pattern-benchmark.test.ts',
    'src/agent-idiom-benchmark.test.ts',
    'src/capability-inference-benchmark.test.ts',
    'src/analysis-focus-benchmark.test.ts',
    'src/agent-greenfield-benchmark.test.ts',
    'src/runtime-impact-benchmark.test.ts',
    'src/incremental-benchmark-copy.test.ts',
    'src/incremental-locality-benchmark.test.ts',
  ];
  const benchFiles = new Set(bench.files.map(item => item.file));
  const fastFiles = new Set(fast.files.map(item => item.file));
  for (const stray of knownStraySrcBenchmarks) {
    assert.ok(all.files.some(item => item.file === stray), `expected ${stray} to still exist in the suite`);
    assert.ok(benchFiles.has(stray), `expected ${stray} in bench (role-based), got fast=${fastFiles.has(stray)}`);
    assert.ok(!fastFiles.has(stray), `expected ${stray} NOT in fast — this is exactly the directory-split defect`);
  }

  assert.ok(bench.files.every(item => item.file.startsWith('src/gauntlet/') || /-benchmark(-|\.)/.test(item.file)));
  assert.ok(fast.files.every(item => !item.file.startsWith('src/gauntlet/') && !/-benchmark(-|\.)/.test(item.file)));
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

test('summary parsing accepts both node:test reporter prefixes', async () => {
  const { parseTapSummary } = await import(path.resolve('scripts/test-suite.mjs')) as any;

  // Older Node prefixes the summary block with `# `, Node 22+ with `ℹ `.
  // Recognising only one silently reported tests=0 pass=0 fail=0 on the other,
  // so the suite's headline numbers depended on which machine ran it.
  const hash = ['# tests 7', '# pass 5', '# fail 1', '# skipped 1'].join('\n');
  const info = ['\u2139 tests 7', '\u2139 pass 5', '\u2139 fail 1', '\u2139 skipped 1'].join('\n');
  const expected = { tests: 7, passed: 5, failed: 1, skipped: 1 };

  assert.deepEqual(parseTapSummary(hash), expected);
  assert.deepEqual(parseTapSummary(info), expected);
});

test('per-file temp roots stay short enough for a unix domain socket', async () => {
  const { shortTempBase } = await import(path.resolve('scripts/test-suite.mjs')) as any;

  // tsx binds $TMPDIR/tsx-<uid>/<pid>.pipe for every child; the kernel caps a
  // unix socket path at 104 bytes on macOS. macOS's own TMPDIR is ~48 bytes,
  // so nesting the isolated per-file TMPDIR under it made EVERY test file exit
  // with EINVAL before running a single test.
  assert.equal(shortTempBase('darwin', '/var/folders/5_/5xzp0rq57cs_m_2f263y1p8r0000gp/T'), '/tmp');
  assert.equal(shortTempBase('linux', '/tmp'), '/tmp');
  assert.equal(shortTempBase('win32', 'C:\\Temp'), 'C:\\Temp');

  const base = shortTempBase();
  const worstCase = path.join(base, 'klauro-tests', 'run-XXXXXX', 'a'.repeat(10), 'tmp', 'tsx-501', '999999.pipe');
  assert.ok(worstCase.length < 104, `worst-case socket path ${worstCase.length} bytes: ${worstCase}`);
});
