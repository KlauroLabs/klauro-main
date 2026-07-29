import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';

// --- release-gate regression (2026-07-28) ------------------------------------
// scripts/release.sh's post-publish check used to read
//   if [ "$HOSTED" = "$VERSION" ] && [ "$TARBALL_CODE" = "200" ] || [ "$TARBALL_CODE" = "206" ]; then
// which shell groups as `(A && B) || C`: a bare 206 tarball response passed
// the WHOLE gate regardless of whether the hosted manifest version actually
// matched. That is precisely the stale-manifest failure the gate exists to
// catch — a 2026-07-27 audit found /dist/latest.json four days stale while
// the check was reporting "OK". The gate now lives in
// verify-distribution-channel.sh as an independently-testable shell function;
// this drives it exactly as release.sh does (source the file, call the
// function, check the exit code) rather than re-implementing the logic here.

const scriptPath = path.join(__dirname, '..', 'scripts', 'verify-distribution-channel.sh');

function runGate(hosted: string, version: string, tarballCode: string): { ok: boolean } {
  try {
    execFileSync('bash', ['-c', `set -euo pipefail; . "$1"; verify_distribution_channel "$2" "$3" "$4"`, 'bash', scriptPath, hosted, version, tarballCode], {
      stdio: 'pipe',
    });
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

test('verify_distribution_channel passes on an exact 200 + matching version', () => {
  const result = runGate('1.0.130', '1.0.130', '200');
  assert.equal(result.ok, true);
});

test('verify_distribution_channel FAILS on a 200 tarball with a mismatched hosted version', () => {
  // This is the case the pre-fix `(A && B) || C` grouping let through as long
  // as C (the 206 fallback) happened not to fire — i.e. it depended on
  // incidental tarball status rather than the version match it exists to gate.
  const result = runGate('1.0.126', '1.0.130', '200');
  assert.equal(result.ok, false, 'a version mismatch must fail the gate even when the tarball itself is fully served');
});

test('verify_distribution_channel treats 206 as success — the caller probes with a range request', () => {
  // The caller uses `curl -r 0-0`, so a server honoring the range header
  // answers 206 Partial Content; 200 means it ignored the range. Both are
  // a served tarball. Rejecting 206 would fail every correctly-served
  // release, so 206 must pass WITH a matching version.
  assert.equal(runGate('1.0.130', '1.0.130', '206').ok, true, '206 is the expected response to a range request');
});

test('verify_distribution_channel FAILS when the version mismatches, whatever the tarball status', () => {
  // This is the original bug: under `(A && B) || C` grouping, a bare
  // `[ "$TARBALL_CODE" = "206" ]` as C made the whole expression true no
  // matter what A and B evaluated to — so a stale hosted manifest passed
  // the gate. 206 must no longer buy a pass on its own.
  assert.equal(runGate('1.0.126', '1.0.130', '206').ok, false, '206 must not short-circuit past a version mismatch');
  assert.equal(runGate('1.0.126', '1.0.130', '200').ok, false, 'a version mismatch fails even on a fully served tarball');
});

test('verify_distribution_channel FAILS on a status that is neither 200 nor 206', () => {
  assert.equal(runGate('1.0.130', '1.0.130', '404').ok, false, 'an unserved tarball must fail the gate');
  assert.equal(runGate('1.0.130', '1.0.130', '000').ok, false, 'an unreachable host must fail the gate');
});
