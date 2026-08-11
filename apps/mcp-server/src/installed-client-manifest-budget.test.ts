import test from 'node:test';
import assert from 'node:assert/strict';
import { jsonForTest, summarizeUploadManifest } from './installed-client-server';

// Measured 2026-08-11 against a real ML repo: get_upload_manifest returned
// 4,234,202 characters — 21,737 individual file paths — on the tool agents are
// instructed to call BEFORE uploading. Every other tool on that surface is
// budgeted; this one serialised the raw manifest and blew the caller's context.
//
// This test exists because that fix lives in the INSTALLED CLIENT, which my
// deploy-and-observe loop is structurally blind to: client code reaches customers
// via `klauro update`, not via a server deploy, so re-calling the tool after a
// deploy returned the identical 4MB and proved nothing. A client-side change with
// no test is a change nobody has verified.
function syntheticManifest(fileCount: number): Record<string, any> {
  const files = Array.from({ length: fileCount }, (_, index) => ({
    // Two thirds under an installed-dependency tree, mirroring the real repo.
    path: index % 3 === 0
      ? `backend/app/module_${index}.py`
      : `rvc-webui/venv2/lib/python3.10/site-packages/pkg_${index % 50}/mod_${index}.py`,
    bytes: 1000 + index,
    hash: `h${index}`,
  }));
  return {
    root: '/tmp/ml-repo',
    file_count: fileCount,
    files,
    excluded: [
      { path: '.env', reason: 'sensitive' },
      { path: 'node_modules/x', reason: 'excluded directory' },
      { path: 'node_modules/y', reason: 'excluded directory' },
    ],
    snapshot_digest: 'abc123',
  };
}

test('a 21k-file manifest summarises to a payload an agent can actually read', () => {
  const summary = summarizeUploadManifest(syntheticManifest(21737));
  const serialised = JSON.stringify(summary);
  assert.ok(
    serialised.length < 20_000,
    `summary must stay small enough to consume; got ${serialised.length} chars (raw was 4,234,202)`,
  );
  // Counts stay EXACT — the bound applies to enumeration, never to the numbers a
  // customer would act on.
  assert.equal(summary.file_count, 21737);
  assert.equal(summary.excluded_count, 3);
  assert.equal(summary.files_omitted_from_sample, 21737 - 25);
});

test('the rollup names where the bulk sits, which is the question being asked', () => {
  const summary = summarizeUploadManifest(syntheticManifest(21737)) as any;
  const top = summary.largest_directories[0];
  assert.match(
    String(top.directory),
    /rvc-webui/,
    'the largest directory must be surfaced first — "why is my upload enormous" is the actual question',
  );
  assert.ok(top.files > 14000, `expected the installed-dependency tree to dominate; got ${top.files}`);
  // Exclusions grouped rather than enumerated.
  assert.equal(summary.excluded_by_reason['excluded directory'], 2);
  assert.equal(summary.excluded_by_reason.sensitive, 1);
});

test('a small manifest is not distorted by the bound', () => {
  const summary = summarizeUploadManifest(syntheticManifest(6)) as any;
  assert.equal(summary.file_count, 6);
  assert.equal(summary.files_sample.length, 6, 'nothing sampled away when everything fits');
  assert.equal(summary.files_omitted_from_sample, 0);
  assert.equal(summary.directories_omitted, 0);
});

// The budget above lives at the json() choke point every tool on this surface
// returns through, so one test covers all 40+ of them. Measured 2026-08-11:
// get_upload_manifest returned 4,234,202 characters and the caller got an error
// with no manifest at all — the tool was worse than absent. Nothing stopped the
// next unbounded tool from repeating it.
test('an over-budget tool response is withheld with an actionable error, never truncated', () => {
  // A payload no agent can consume, shaped like a real unbounded collection.
  const oversized = { rows: Array.from({ length: 60_000 }, (_, i) => ({ path: `pkg/mod_${i}.py`, bytes: i })) };
  const result = jsonForTest(oversized, 'get_upload_manifest');
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.error, 'tool_response_over_budget');
  assert.equal(payload.tool, 'get_upload_manifest', 'the failing tool must be named so it can be fixed');
  assert.ok(payload.response_chars > payload.budget_chars);
  // Crucially NOT a truncated payload: a half-answer that looks whole is the
  // failure mode this codebase spent a day removing.
  assert.equal(payload.rows, undefined, 'no partial data may survive — it would be acted on as complete');
  assert.match(String(payload.detail), /narrow the request/i);
});

test('a normal-sized response passes through untouched', () => {
  const normal = { capabilities: ['Manage Feeds', 'Schedule Imports'], file_count: 12 };
  const payload = JSON.parse(jsonForTest(normal, 'get_summary').content[0].text);
  assert.deepEqual(payload, normal, 'the budget must be invisible to every legitimate answer');
});
