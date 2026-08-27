import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'fs-extra';
import { open } from 'node:fs/promises';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'node:url';
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

async function processStart(pid = process.pid): Promise<string> {
  const value = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
  return value.slice(value.lastIndexOf(') ') + 2).trim().split(/\s+/)[19];
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

test('child-process writers and compaction serialize without losing observations', async () => {
  const projectPath = await scratchProject();
  const day = recentDay();
  const moduleUrl = pathToFileURL(path.join(process.cwd(), 'src', 'telemetry-ingestion.ts')).href;
  const childScript = [
    `import { appendIngestedTelemetry } from ${JSON.stringify(moduleUrl)};`,
    `const [projectPath, id, recordedAt] = process.argv.slice(1);`,
    `await appendIngestedTelemetry(projectPath, [{ id, project_path: projectPath, recorded_at: recordedAt, source: 'ingested', event: { type: 'request', timestamp: recordedAt, schema_version: 'ingested-1' }, correlation: { status: 'unmatched' } }]);`,
  ].join('\n');
  const childAppend = (id: string) => new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', childScript, projectPath, id, day], {
      cwd: process.cwd(),
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let error = '';
    child.stderr.on('data', chunk => { error += String(chunk); });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(error || `child exited ${code}`)));
  });

  await appendIngestedTelemetry(projectPath, [observation('seed', day)]);
  await Promise.all([
    ...Array.from({ length: 8 }, (_, index) => childAppend(`child-${index}`)),
    compactIngestedTelemetry(projectPath),
  ]);
  const loaded = await loadIngestedTelemetry(projectPath);
  assert.deepEqual(new Set(loaded.map(item => item.id)), new Set(['seed', ...Array.from({ length: 8 }, (_, index) => `child-${index}`)]));
  await fs.remove(projectPath);
});

test('an fsync failure rejects ingestion instead of acknowledging persistence', async () => {
  const projectPath = await scratchProject();
  const probePath = path.join(projectPath, 'probe');
  const probe = await open(probePath, 'a');
  const prototype = Object.getPrototypeOf(probe) as { sync: () => Promise<void> };
  const originalSync = prototype.sync;
  await probe.close();
  prototype.sync = async () => { throw new Error('injected fsync failure'); };
  try {
    await assert.rejects(
      appendIngestedTelemetry(projectPath, [observation('unacknowledged', recentDay())]),
      /injected fsync failure/,
    );
    const telemetryDir = ingestedTelemetryDir(projectPath);
    assert.equal(await fs.pathExists(path.join(telemetryDir, '.mutation-lock')), false);
    assert.equal((await fs.readdir(telemetryDir).catch(() => [] as string[])).some(name => name.startsWith('.mutation-lock.pending-')), false);
  } finally {
    prototype.sync = originalSync;
    await fs.remove(projectPath);
  }
});

test('a crashed prepublication owner directory cannot block the next lock acquisition', async () => {
  const projectPath = await scratchProject();
  const telemetryDir = ingestedTelemetryDir(projectPath);
  const abandonedPending = path.join(telemetryDir, '.mutation-lock.pending-crashed-owner');
  await fs.ensureDir(abandonedPending);
  await fs.writeFile(path.join(abandonedPending, 'owner.json'), '{"token":');

  await appendIngestedTelemetry(projectPath, [observation('after-prepublish-crash', recentDay())]);
  assert.deepEqual((await loadIngestedTelemetry(projectPath)).map(item => item.id), ['after-prepublish-crash']);
  assert.equal(await fs.pathExists(path.join(telemetryDir, '.mutation-lock')), false);
  await fs.remove(projectPath);
});

test('a directory fsync failure rejects the first durable write', async () => {
  const projectPath = await scratchProject();
  const probePath = path.join(projectPath, 'probe');
  const probe = await open(probePath, 'a');
  const prototype = Object.getPrototypeOf(probe) as { stat: () => Promise<{ isDirectory(): boolean }>; sync: () => Promise<void> };
  const originalSync = prototype.sync;
  await probe.close();
  prototype.sync = async function () {
    if ((await this.stat()).isDirectory()) throw new Error('injected directory fsync failure');
    return originalSync.call(this);
  };
  try {
    await assert.rejects(
      appendIngestedTelemetry(projectPath, [observation('unacknowledged-directory', recentDay())]),
      /injected directory fsync failure/,
    );
  } finally {
    prototype.sync = originalSync;
    await fs.remove(projectPath);
  }
});

test('load deduplicates across days before applying its result limit', async () => {
  const projectPath = await scratchProject();
  const dir = ingestedTelemetryDir(projectPath);
  const today = recentDay();
  const yesterday = recentDay(1);
  await fs.ensureDir(dir);
  await fs.writeFile(path.join(dir, `${today.slice(0, 10)}.jsonl`), [
    JSON.stringify(observation('duplicate', today)),
    JSON.stringify(observation('duplicate', today)),
  ].join('\n') + '\n');
  await fs.writeFile(path.join(dir, `${yesterday.slice(0, 10)}.jsonl`), `${JSON.stringify(observation('older-unique', yesterday))}\n`);

  const loaded = await loadIngestedTelemetry(projectPath, { limit: 2 });
  assert.deepEqual(loaded.map(item => item.id), ['duplicate', 'older-unique']);
  await fs.remove(projectPath);
});

test('production byte bound compacts 5,000 large rows and does not force another rewrite below the ceiling', async () => {
  const projectPath = await scratchProject();
  const previousTrigger = process.env.KLAURO_TELEMETRY_COMPACTION_BYTES;
  process.env.KLAURO_TELEMETRY_COMPACTION_BYTES = '65536';
  try {
    const day = recentDay();
    const large = Array.from({ length: 5000 }, (_, index) => ({
      ...observation(`bounded-${index}`, day),
      event: { ...observation(`bounded-${index}`, day).event, attributes: { payload: 'x'.repeat(1024) } },
    }));
    for (let offset = 0; offset < large.length; offset += 20) {
      await appendIngestedTelemetry(projectPath, large.slice(offset, offset + 20));
    }
    const file = path.join(ingestedTelemetryDir(projectPath), `${day.slice(0, 10)}.jsonl`);
    const afterCompaction = await fs.readFile(file);
    assert.ok(afterCompaction.byteLength <= 65536, 'compaction must enforce the byte ceiling as well as the row ceiling');
    const loaded = await loadIngestedTelemetry(projectPath);
    assert.ok(loaded.length > 0 && loaded.length < 5000);
    assert.equal(loaded[0].id, 'bounded-4999');

    await appendIngestedTelemetry(projectPath, [observation('small-after-compaction', day)]);
    const afterSmallAppend = await fs.readFile(file);
    assert.ok(afterSmallAppend.subarray(0, afterCompaction.length).equals(afterCompaction), 'a below-ceiling append must retain journal append semantics');
  } finally {
    if (previousTrigger === undefined) delete process.env.KLAURO_TELEMETRY_COMPACTION_BYTES;
    else process.env.KLAURO_TELEMETRY_COMPACTION_BYTES = previousTrigger;
    await fs.remove(projectPath);
  }
});

test('an observation larger than the daily byte ceiling is rejected before acknowledgement', async () => {
  const projectPath = await scratchProject();
  const previousTrigger = process.env.KLAURO_TELEMETRY_COMPACTION_BYTES;
  process.env.KLAURO_TELEMETRY_COMPACTION_BYTES = '1024';
  try {
    const oversized = observation('oversized', recentDay());
    oversized.event.attributes = { payload: 'x'.repeat(2048) };
    await assert.rejects(appendIngestedTelemetry(projectPath, [oversized]), /exceeds the 768-byte daily journal limit/);
  } finally {
    if (previousTrigger === undefined) delete process.env.KLAURO_TELEMETRY_COMPACTION_BYTES;
    else process.env.KLAURO_TELEMETRY_COMPACTION_BYTES = previousTrigger;
    await fs.remove(projectPath);
  }
});

test('an aggregate batch larger than the daily byte ceiling is rejected without a partial append', async () => {
  const projectPath = await scratchProject();
  const previousTrigger = process.env.KLAURO_TELEMETRY_COMPACTION_BYTES;
  process.env.KLAURO_TELEMETRY_COMPACTION_BYTES = '4096';
  try {
    const day = recentDay();
    const events = Array.from({ length: 10 }, (_, index) => ({
      ...observation(`aggregate-${index}`, day),
      event: { ...observation(`aggregate-${index}`, day).event, attributes: { payload: 'x'.repeat(400) } },
    }));
    await assert.rejects(appendIngestedTelemetry(projectPath, events), /telemetry batch exceeds/i);
    assert.deepEqual(await loadIngestedTelemetry(projectPath), []);
  } finally {
    if (previousTrigger === undefined) delete process.env.KLAURO_TELEMETRY_COMPACTION_BYTES;
    else process.env.KLAURO_TELEMETRY_COMPACTION_BYTES = previousTrigger;
    await fs.remove(projectPath);
  }
});

test('a displaced owner cannot delete its successor lock or acknowledge an unfenced write', async () => {
  const projectPath = await scratchProject();
  const telemetryDir = ingestedTelemetryDir(projectPath);
  await fs.ensureDir(telemetryDir);
  const probe = await open(path.join(projectPath, 'probe'), 'a');
  const prototype = Object.getPrototypeOf(probe) as { stat: () => Promise<{ isFile(): boolean }>; sync: () => Promise<void> };
  const originalSync = prototype.sync;
  await probe.close();
  let displaced = false;
  prototype.sync = async function () {
    if (!displaced && (await this.stat()).isFile()) {
      const lockDir = path.join(telemetryDir, '.mutation-lock');
      if (!(await fs.pathExists(lockDir))) return originalSync.call(this);
      displaced = true;
      await fs.rename(lockDir, `${lockDir}.displaced`);
      await fs.ensureDir(lockDir);
      await fs.writeJson(path.join(lockDir, 'owner.json'), { token: 'successor' });
    }
    return originalSync.call(this);
  };
  try {
    await assert.rejects(
      appendIngestedTelemetry(projectPath, [observation('unfenced', recentDay())]),
      /lock ownership was lost/,
    );
    assert.equal((await fs.readJson(path.join(telemetryDir, '.mutation-lock', 'owner.json'))).token, 'successor');
  } finally {
    prototype.sync = originalSync;
    await fs.remove(projectPath);
  }
});

test('a stale cross-process mutation lock is recovered', async () => {
  const projectPath = await scratchProject();
  const lockDir = path.join(ingestedTelemetryDir(projectPath), '.mutation-lock');
  await fs.ensureDir(lockDir);
  const bootId = (await fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
  await fs.writeJson(path.join(lockDir, 'owner.json'), {
    token: 'dead-owner',
    pid: 2_147_483_647,
    instance: os.hostname(),
    boot_id: bootId,
    process_start: 'dead',
  });
  const stale = new Date(Date.now() - 10 * 60_000);
  await fs.utimes(lockDir, stale, stale);

  await appendIngestedTelemetry(projectPath, [observation('after-stale-lock', recentDay())]);
  assert.deepEqual((await loadIngestedTelemetry(projectPath)).map(item => item.id), ['after-stale-lock']);
  await fs.remove(projectPath);
});

test('a stale lock owned by the live process is never time-evicted', async () => {
  const projectPath = await scratchProject();
  const lockDir = path.join(ingestedTelemetryDir(projectPath), '.mutation-lock');
  await fs.ensureDir(lockDir);
  const bootId = (await fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
  await fs.writeJson(path.join(lockDir, 'owner.json'), {
    token: 'live-owner',
    pid: process.pid,
    instance: os.hostname(),
    boot_id: bootId,
    process_start: await processStart(),
  });
  const stale = new Date(Date.now() - 10 * 60_000);
  await fs.utimes(lockDir, stale, stale);

  const pending = appendIngestedTelemetry(projectPath, [observation('after-live-owner', recentDay())]);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(await fs.pathExists(path.join(lockDir, 'owner.json')), true);
  assert.equal((await fs.readJson(path.join(lockDir, 'owner.json'))).token, 'live-owner');
  await fs.remove(lockDir);
  await pending;
  await fs.remove(projectPath);
});

test('a stale lock from a prior host boot is recovered', async () => {
  const projectPath = await scratchProject();
  const lockDir = path.join(ingestedTelemetryDir(projectPath), '.mutation-lock');
  await fs.ensureDir(lockDir);
  await fs.writeJson(path.join(lockDir, 'owner.json'), {
    token: 'prior-boot-owner',
    pid: process.pid,
    instance: os.hostname(),
    boot_id: 'prior-boot',
    process_start: await processStart(),
  });
  const stale = new Date(Date.now() - 10 * 60_000);
  await fs.utimes(lockDir, stale, stale);

  await appendIngestedTelemetry(projectPath, [observation('after-prior-boot', recentDay())]);
  assert.deepEqual((await loadIngestedTelemetry(projectPath)).map(item => item.id), ['after-prior-boot']);
  await fs.remove(projectPath);
});

test('a stable hosted lock instance recovers a prior container process incarnation even when the PID is reused', async () => {
  const projectPath = await scratchProject();
  const lockDir = path.join(ingestedTelemetryDir(projectPath), '.mutation-lock');
  const priorInstance = process.env.KLAURO_TELEMETRY_LOCK_INSTANCE;
  process.env.KLAURO_TELEMETRY_LOCK_INSTANCE = 'hosted-api-test';
  try {
    await fs.ensureDir(lockDir);
    const bootId = (await fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
    await fs.writeJson(path.join(lockDir, 'owner.json'), {
      token: 'prior-container-owner',
      pid: process.pid,
      instance: 'hosted-api-test',
      boot_id: bootId,
      process_start: `${await processStart()}-prior`,
    });
    await appendIngestedTelemetry(projectPath, [observation('after-container-restart', recentDay())]);
    assert.deepEqual((await loadIngestedTelemetry(projectPath)).map(item => item.id), ['after-container-restart']);
  } finally {
    if (priorInstance === undefined) delete process.env.KLAURO_TELEMETRY_LOCK_INSTANCE;
    else process.env.KLAURO_TELEMETRY_LOCK_INSTANCE = priorInstance;
    await fs.remove(projectPath);
  }
});

test('the hosted singleton API declares a stable telemetry lock instance', async () => {
  const compose = await fs.readFile(path.resolve(process.cwd(), '../../infrastructure/vps/docker-compose.yml'), 'utf8');
  const apiService = compose.split('\n  fabric:')[0];
  assert.match(apiService, /KLAURO_TELEMETRY_LOCK_INSTANCE:\s*"hosted-api"/);
});
