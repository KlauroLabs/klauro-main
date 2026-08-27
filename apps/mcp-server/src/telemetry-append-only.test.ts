import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { appendIngestedTelemetry, compactIngestedTelemetry, ingestedTelemetryDir, loadIngestedTelemetry } from './telemetry-ingestion';
import type { RuntimeObservation } from './product';

// Measured on prod 2026-08-11: "local ingest of 1 event(s) took 29126ms". The
// writer read a 4.1MB / 5,000-observation day file, merged, and atomically
// REWROTE it on every ingest — O(existing) per event, in-line on the API process
// while customer analyses ran. These tests pin the properties that make that
// impossible to reintroduce: appends must not rewrite, legacy files must stay
// readable, and the per-day cap must still hold.
function observation(id: string, recordedAt: string): RuntimeObservation {
  return {
    id,
    project_path: '/tmp/does-not-matter',
    recorded_at: recordedAt,
    source: 'ingested',
    event: { type: 'request', timestamp: recordedAt, schema_version: 'ingested-1' },
    correlation: { status: 'unmatched' },
  } as unknown as RuntimeObservation;
}

async function scratchProject(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'klauro-telemetry-'));
}

function recentDay(daysAgo = 0): string {
  const date = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
  return `${date.toISOString().slice(0, 10)}T10:00:00.000Z`;
}

test('appending does not rewrite prior observations (append-only, O(new))', async () => {
  const projectPath = await scratchProject();
  const day = recentDay();
  await appendIngestedTelemetry(projectPath, [observation('first', day)]);
  const dir = ingestedTelemetryDir(projectPath);
  const file = path.join(dir, `${day.slice(0, 10)}.jsonl`);
  const afterFirst = await fs.readFile(file, 'utf8');

  await appendIngestedTelemetry(projectPath, [observation('second', day)]);
  const afterSecond = await fs.readFile(file, 'utf8');

  assert.ok(afterSecond.startsWith(afterFirst), 'the existing bytes must be untouched — a rewrite is the 29s defect');
  assert.equal(afterSecond.trim().split('\n').length, 2);
  const loaded = await loadIngestedTelemetry(projectPath);
  assert.deepEqual(loaded.map(item => item.id), ['second', 'first'], 'newest-first ordering preserved for callers');
  await fs.remove(projectPath);
});

test('legacy .json day files stay readable alongside new .jsonl', async () => {
  const projectPath = await scratchProject();
  const dir = ingestedTelemetryDir(projectPath);
  const legacyDay = recentDay(1);
  const modernDay = recentDay();
  await fs.ensureDir(dir);
  // A day written by the OLD implementation.
  await fs.writeJson(path.join(dir, `${legacyDay.slice(0, 10)}.json`), [observation('legacy', legacyDay)]);
  await appendIngestedTelemetry(projectPath, [observation('modern', modernDay)]);

  const loaded = await loadIngestedTelemetry(projectPath);
  const ids = loaded.map(item => item.id);
  assert.ok(ids.includes('legacy'), 'existing customer telemetry must not become invisible');
  assert.ok(ids.includes('modern'));
  await fs.remove(projectPath);
});

test('the per-day cap still holds, enforced during compaction not on every write', async () => {
  const projectPath = await scratchProject();
  const day = recentDay();
  // 5,001 observations: one over MAX_OBSERVATIONS_PER_DAY.
  const batch = Array.from({ length: 5001 }, (_, index) => observation(`obs-${index}`, day));
  await appendIngestedTelemetry(projectPath, batch);
  const beforeCompaction = await loadIngestedTelemetry(projectPath);
  assert.equal(beforeCompaction.length, 5001, 'the write path is deliberately uncapped — that is what makes it O(new)');

  await compactIngestedTelemetry(projectPath);
  const afterCompaction = await loadIngestedTelemetry(projectPath);
  assert.equal(afterCompaction.length, 5000, 'compaction restores the storage bound');
  assert.equal(afterCompaction[0].id, 'obs-5000', 'the NEWEST observations are the ones kept');
  await fs.remove(projectPath);
});

test('concurrent appends serialize without losing observations', async () => {
  const projectPath = await scratchProject();
  const day = recentDay();
  await Promise.all(Array.from({ length: 16 }, (_, index) =>
    appendIngestedTelemetry(projectPath, [observation(`concurrent-${index}`, day)])));

  const loaded = await loadIngestedTelemetry(projectPath);
  assert.deepEqual(new Set(loaded.map(item => item.id)), new Set(Array.from({ length: 16 }, (_, index) => `concurrent-${index}`)));
  await fs.remove(projectPath);
});

test('a truncated final record cannot hide prior or later telemetry', async () => {
  const projectPath = await scratchProject();
  const day = recentDay();
  await appendIngestedTelemetry(projectPath, [observation('before-crash', day)]);
  const file = path.join(ingestedTelemetryDir(projectPath), `${day.slice(0, 10)}.jsonl`);
  await fs.appendFile(file, '{"truncated":', 'utf8');
  await appendIngestedTelemetry(projectPath, [observation('after-crash', day)]);

  const loaded = await loadIngestedTelemetry(projectPath);
  assert.deepEqual(new Set(loaded.map(item => item.id)), new Set(['before-crash', 'after-crash']));
  await fs.remove(projectPath);
});
