/**
 * Tests for the test run-history module. Focus on parseTap with crafted TAP
 * fixtures so the parser is verified WITHOUT running the (slow) real suite.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs-extra';
import {
  parseTap,
  runTestSuite,
  type TestRunRecord,
} from './test-runs';

const PASS_FAIL_SKIP = `TAP version 13
# Subtest: alpha pass
ok 1 - alpha pass
  ---
  duration_ms: 0.462708
  type: 'test'
  ...
# Subtest: beta fail
not ok 2 - beta fail
  ---
  duration_ms: 7.747041
  type: 'test'
  location: '/private/tmp/example.test.ts:2:953'
  failureType: 'testCodeFailure'
  error: |-
    boom
  ...
# Subtest: gamma skip
ok 3 - gamma skip # SKIP
  ---
  duration_ms: 0.062333
  type: 'test'
  ...
1..3
# tests 3
# pass 1
# fail 1
# skipped 1
# duration_ms 277.294833
`;

test('parses a passing test with its name and duration', () => {
  const r = parseTap(PASS_FAIL_SKIP);
  const alpha = r.tests.find(t => t.name === 'alpha pass');
  assert.ok(alpha, 'alpha pass should be parsed');
  assert.equal(alpha!.status, 'pass');
  assert.ok(Math.abs(alpha!.duration_ms - 0.462708) < 1e-6);
});

test('parses a failing test and extracts its file from location', () => {
  const r = parseTap(PASS_FAIL_SKIP);
  const beta = r.tests.find(t => t.name === 'beta fail');
  assert.ok(beta);
  assert.equal(beta!.status, 'fail');
  assert.equal(beta!.file, '/private/tmp/example.test.ts');
  assert.ok(Math.abs(beta!.duration_ms - 7.747041) < 1e-6);
});

test('parses a skipped test via the # SKIP directive', () => {
  const r = parseTap(PASS_FAIL_SKIP);
  const gamma = r.tests.find(t => t.name === 'gamma skip');
  assert.ok(gamma);
  assert.equal(gamma!.status, 'skip');
});

test('aggregate counts match per-status tallies', () => {
  const r = parseTap(PASS_FAIL_SKIP);
  assert.equal(r.total, 3);
  assert.equal(r.passed, 1);
  assert.equal(r.failed, 1);
  assert.equal(r.skipped, 1);
});

test('# TODO directive is also treated as skip', () => {
  const tap = `TAP version 13
# Subtest: todo item
ok 1 - todo item # TODO not yet
  ---
  duration_ms: 0.1
  ...
1..1
`;
  const r = parseTap(tap);
  assert.equal(r.tests.length, 1);
  assert.equal(r.tests[0].status, 'skip');
});

test('prefers the # Subtest: name over the inline ok name', () => {
  const tap = `TAP version 13
# Subtest: full canonical name with details
ok 1 - full canonical name with details
  ---
  duration_ms: 2
  ...
1..1
`;
  const r = parseTap(tap);
  assert.equal(r.tests[0].name, 'full canonical name with details');
});

test('handles multiple subtests grouped in one stream', () => {
  const tap = `TAP version 13
# Subtest: one
ok 1 - one
  ---
  duration_ms: 1
  ...
# Subtest: two
not ok 2 - two
  ---
  duration_ms: 2
  ...
# Subtest: three
ok 3 - three
  ---
  duration_ms: 3
  ...
1..3
`;
  const r = parseTap(tap);
  assert.equal(r.total, 3);
  assert.deepEqual(
    r.tests.map(t => t.status),
    ['pass', 'fail', 'pass'],
  );
  assert.deepEqual(
    r.tests.map(t => t.duration_ms),
    [1, 2, 3],
  );
});

test('zero-test input parses to an empty, zeroed result', () => {
  const tap = `TAP version 13
1..0
# tests 0
# pass 0
`;
  const r = parseTap(tap);
  assert.equal(r.total, 0);
  assert.equal(r.passed, 0);
  assert.equal(r.failed, 0);
  assert.equal(r.skipped, 0);
  assert.deepEqual(r.tests, []);
});

test('missing duration_ms defaults to 0, not NaN', () => {
  const tap = `TAP version 13
# Subtest: no duration
ok 1 - no duration
  ---
  type: 'test'
  ...
1..1
`;
  const r = parseTap(tap);
  assert.equal(r.tests[0].duration_ms, 0);
});

test('ignores the plan line and summary comment lines', () => {
  const tap = `TAP version 13
# Subtest: solo
ok 1 - solo
  ---
  duration_ms: 5
  ...
1..1
# tests 1
# pass 1
# fail 0
`;
  const r = parseTap(tap);
  assert.equal(r.total, 1, 'only the real test, not the summary, is counted');
});

// One smoke test: run a tiny throwaway suite end-to-end through the same
// machinery shape. We invoke node:test directly on a temp file (fast) rather
// than the full project suite.
//
// This used to spawn the `npx` shell shim and t.skip() whenever it produced no
// output — which is exactly what happened inside the gate container (non-root
// `gate` user, no writable npm cache), so the one test that actually exercises
// the spawn+parse path never ran there. Resolve tsx's CLI entry and run it on
// this process's own node binary: no shim, no network, no cache, and a genuine
// failure now fails instead of silently disappearing.
test('runTestSuite-style end-to-end on a tiny temp suite (smoke)', async () => {
  const { spawn } = await import('child_process');
  const { createRequire } = await import('node:module');
  const tsxCli = createRequire(__filename).resolve('tsx/cli');
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'test-runs-smoke-'));
  const tmpFile = path.join(tmpDir, 'tiny.test.ts');
  await fs.writeFile(
    tmpFile,
    `import { test } from 'node:test';\nimport assert from 'node:assert';\n` +
      `test('tiny ok', () => { assert.ok(true); });\n` +
      `test('tiny skip', { skip: true }, () => {});\n`,
  );

  const childEnv = { ...process.env };
  delete childEnv.NODE_TEST_CONTEXT;
  delete childEnv.NODE_OPTIONS;

  const { out, err } = await new Promise<{ out: string; err: string }>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [tsxCli, '--test', '--test-reporter=tap', tmpFile],
      // NODE_TEST_CONTEXT is how node:test tells a process it is already
      // inside a test run; inherited, the child prints "run() is being called
      // recursively within a test file. skipping running files." to stderr and
      // nothing at all to stdout. Drop it (and NODE_OPTIONS) so the child is a
      // clean top-level runner.
      { env: { ...childEnv, FORCE_COLOR: '0' } }
    );
    let s = '';
    let e = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('smoke timeout'));
    }, 60_000);
    child.stdout?.on('data', d => (s += d.toString()));
    child.stderr?.on('data', d => (e += d.toString()));
    child.on('error', reject);
    child.on('close', () => {
      clearTimeout(timer);
      resolve({ out: s, err: e });
    });
  });

  assert.ok(out, `temp run produced no stdout; stderr was: ${err.slice(0, 800)}`);

  const parsed = parseTap(out);
  assert.ok(parsed.total >= 2, `expected >=2 tests, got ${parsed.total}`);
  assert.ok(parsed.passed >= 1, 'at least one pass');
  assert.ok(parsed.skipped >= 1, 'at least one skip');

  await fs.remove(tmpDir);
});

// Type-only reference to keep the runTestSuite import meaningful and ensure the
// record shape is exported and stable.
void (async (): Promise<TestRunRecord | void> => {
  if (process.env.__NEVER__) return runTestSuite();
})();
