/**
 * Test run-history module — actually RUNS the unit suite, captures per-test
 * pass/fail + duration, and persists a history so the gauntlet UI can render a
 * full docket of every test WITH its run history (green/red, last status, trend).
 *
 * Complements test-inventory.ts (static scan, never executes). This module
 * executes the suite via `node:test` with the machine-readable TAP reporter and
 * parses the result. File/area attribution is aligned with buildTestInventory()
 * by matching each TAP test name back to the file the static inventory found it
 * in (the flat TAP stream tsx emits does not carry the source file for passing
 * tests); the TAP `location:` field (present on failures) and an 'unknown'
 * bucket are used as fallbacks.
 *
 * Persistence lives under ~/.klauro/gauntlet/:
 *   - test-runs.json         array of TestRunRecord, newest-first, capped
 *   - test-runs-latest.json  the most recent TestRunRecord
 */

import * as fs from 'fs-extra';
import * as path from 'path';
import * as os from 'os';
import { spawn } from 'child_process';
import { buildTestInventory } from './test-inventory';

export type TestStatus = 'pass' | 'fail' | 'skip';

export interface TestResult {
  name: string;
  file?: string;
  status: TestStatus;
  duration_ms: number;
}

export interface ParsedTap {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  tests: TestResult[];
}

export interface FileRunResult {
  file: string;
  passed: number;
  failed: number;
  skipped: number;
  tests: Array<{ name: string; status: TestStatus; duration_ms: number }>;
}

export interface TestRunRecord {
  run_id: string;
  started_at: string;
  finished_at: string;
  duration_ms: number;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  files: FileRunResult[];
  /** Present only when the run could not be parsed into a real result. */
  error?: string;
}

export interface TestStatusEntry {
  status: TestStatus;
  last_run_at: string;
  history: TestStatus[];
}

const HISTORY_CAP = 50;
const TREND_CAP = 10;
const UNKNOWN_FILE = 'unknown';

function gauntletDir(): string {
  return path.join(os.homedir(), '.klauro', 'gauntlet');
}
function historyPath(): string {
  return path.join(gauntletDir(), 'test-runs.json');
}
function latestPath(): string {
  return path.join(gauntletDir(), 'test-runs-latest.json');
}

/** apps/mcp-server repo root (this file lives at <root>/src/gauntlet/). */
function repoRoot(): string {
  return path.resolve(__dirname, '..', '..');
}

// ---------------------------------------------------------------------------
// TAP parsing (pure — unit-testable without running the real suite)
// ---------------------------------------------------------------------------

/** `ok 1 - name` / `not ok 2 - name` with optional `# SKIP` / `# TODO` directive. */
const RESULT_RE = /^(?<indent>\s*)(?<neg>not )?ok\b\s*(?<num>\d+)?\s*(?:-\s*)?(?<rest>.*)$/;
const DURATION_RE = /^\s*duration_ms:\s*([\d.eE+-]+)\s*$/;
const SUBTEST_RE = /^\s*#\s*Subtest:\s*(.*)$/;
const LOCATION_RE = /^\s*location:\s*'?([^':]+\.ts)(?::\d+)?(?::\d+)?'?\s*$/;
const PLAN_RE = /^\s*1\.\.(\d+)\s*$/;

/**
 * Parse a TAP 13 stream from node:test into per-test results. Pure: no IO.
 * Recognizes `# Subtest:` grouping lines, `# SKIP`/`# TODO` directives, the
 * `duration_ms:` YAML field, and the `location:` field (used to attribute a
 * failing test to its source file when available).
 */
export function parseTap(tapText: string): ParsedTap {
  const lines = tapText.split(/\r?\n/);
  const tests: TestResult[] = [];

  // The `# Subtest:` line precedes the matching `ok/not ok` line and carries the
  // canonical (untruncated) name. Track the most recent one to use as the name.
  let pendingSubtest: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const sub = SUBTEST_RE.exec(line);
    if (sub) {
      pendingSubtest = sub[1].trim();
      continue;
    }

    const m = RESULT_RE.exec(line);
    if (!m || !m.groups) continue;
    // Skip the plan line `1..N` and bail on YAML-ish lines that aren't results.
    if (PLAN_RE.test(line)) continue;

    let rest = m.groups.rest ?? '';
    const isFail = !!m.groups.neg;

    // Directive: `# SKIP`, `# TODO`, possibly with a reason.
    let status: TestStatus = isFail ? 'fail' : 'pass';
    const directiveMatch = /#\s*(SKIP|TODO)\b/i.exec(rest);
    if (directiveMatch) {
      status = 'skip';
      rest = rest.slice(0, directiveMatch.index).trim();
    }

    const name = (pendingSubtest ?? rest).trim();
    pendingSubtest = null;

    if (!name) continue;

    // Scan the YAML block that follows for duration_ms and location.
    let duration_ms = 0;
    let file: string | undefined;
    for (let j = i + 1; j < lines.length; j++) {
      const yl = lines[j];
      // YAML block ends at the next result/subtest/plan or a non-indented line.
      if (SUBTEST_RE.test(yl) || RESULT_RE.test(yl) && !/^\s+/.test(yl)) break;
      if (/^\S/.test(yl) && yl.trim() !== '...' && yl.trim() !== '---') break;
      const d = DURATION_RE.exec(yl);
      if (d) {
        const v = Number(d[1]);
        if (Number.isFinite(v)) duration_ms = v;
      }
      const loc = LOCATION_RE.exec(yl);
      if (loc) file = loc[1];
      if (yl.trim() === '...') break;
    }

    tests.push({ name, status, duration_ms, ...(file ? { file } : {}) });
  }

  const passed = tests.filter(t => t.status === 'pass').length;
  const failed = tests.filter(t => t.status === 'fail').length;
  const skipped = tests.filter(t => t.status === 'skip').length;

  return { total: tests.length, passed, failed, skipped, tests };
}

// ---------------------------------------------------------------------------
// File attribution (align with the static inventory)
// ---------------------------------------------------------------------------

/** Build a test-name -> repo-relative-file map from the static inventory. */
async function buildNameToFile(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    const inv = await buildTestInventory();
    for (const area of inv.areas) {
      for (const f of area.files) {
        for (const t of f.tests) {
          // First file wins on duplicate names; good enough for attribution.
          if (!map.has(t.name)) map.set(t.name, f.file);
        }
      }
    }
  } catch {
    // Inventory is best-effort; fall back to 'unknown' attribution.
  }
  return map;
}

function relFromLocation(loc: string | undefined): string | undefined {
  if (!loc) return undefined;
  const root = repoRoot();
  const abs = path.resolve(loc);
  let rel = path.relative(root, abs).replace(/\\/g, '/');
  if (rel.startsWith('..')) return undefined;
  return rel;
}

function attributeFile(t: TestResult, nameToFile: Map<string, string>): string {
  const byLoc = relFromLocation(t.file);
  if (byLoc) return byLoc;
  const byName = nameToFile.get(t.name);
  if (byName) return byName;
  return UNKNOWN_FILE;
}

function groupByFile(tests: TestResult[], nameToFile: Map<string, string>): FileRunResult[] {
  const byFile = new Map<string, FileRunResult>();
  for (const t of tests) {
    const file = attributeFile(t, nameToFile);
    let fr = byFile.get(file);
    if (!fr) {
      fr = { file, passed: 0, failed: 0, skipped: 0, tests: [] };
      byFile.set(file, fr);
    }
    fr.tests.push({ name: t.name, status: t.status, duration_ms: t.duration_ms });
    if (t.status === 'pass') fr.passed++;
    else if (t.status === 'fail') fr.failed++;
    else fr.skipped++;
  }
  return [...byFile.values()].sort((a, b) => a.file.localeCompare(b.file));
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

async function persistRun(record: TestRunRecord): Promise<void> {
  await fs.ensureDir(gauntletDir());
  let history: TestRunRecord[] = [];
  try {
    const raw = await fs.readJson(historyPath());
    if (Array.isArray(raw)) history = raw;
  } catch {
    history = [];
  }
  history.unshift(record);
  if (history.length > HISTORY_CAP) history = history.slice(0, HISTORY_CAP);
  await fs.writeJson(historyPath(), history, { spaces: 2 });
  await fs.writeJson(latestPath(), record, { spaces: 2 });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function makeRunId(startedAt: Date): string {
  return `run_${startedAt.toISOString().replace(/[^\dTZ]/g, '').replace(/[TZ]/g, '_')}${Math.random()
    .toString(36)
    .slice(2, 6)}`;
}

/**
 * Spawn the project's unit suite, parse the TAP output, attribute each test to
 * its file, persist the run, and return the record. Never hangs: a generous
 * timeout kills the child and returns an error-shaped record. A run that parses
 * to zero tests is treated as an error and is NOT persisted.
 */
export async function runTestSuite(opts?: { timeoutMs?: number }): Promise<TestRunRecord> {
  const timeoutMs = opts?.timeoutMs ?? 600_000;
  const startedAt = new Date();
  const run_id = makeRunId(startedAt);
  const root = repoRoot();

  const { stdout, stderr } = await spawnSuite(root, timeoutMs);

  const finishedAt = new Date();
  const duration_ms = finishedAt.getTime() - startedAt.getTime();
  const baseMeta = {
    run_id,
    started_at: startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    duration_ms,
  };

  let parsed: ParsedTap;
  try {
    parsed = parseTap(stdout);
  } catch (e) {
    parsed = { total: 0, passed: 0, failed: 0, skipped: 0, tests: [] };
  }

  // Zero tests parsed => bogus run; surface stderr tail, do not persist.
  if (parsed.total === 0) {
    const tail = (stderr || stdout || '').split(/\r?\n/).filter(Boolean).slice(-25).join('\n');
    return {
      ...baseMeta,
      total: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      files: [],
      error: `TAP parsing found zero tests. stderr tail:\n${tail || '(no output)'}`,
    };
  }

  const nameToFile = await buildNameToFile();
  const files = groupByFile(parsed.tests, nameToFile);

  const record: TestRunRecord = {
    ...baseMeta,
    total: parsed.total,
    passed: parsed.passed,
    failed: parsed.failed,
    skipped: parsed.skipped,
    files,
  };

  await persistRun(record);
  return record;
}

/** Spawn the suite and collect stdout/stderr. Resolves even on non-zero exit. */
function spawnSuite(
  cwd: string,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise(resolve => {
    const args = [
      'tsx',
      '--test',
      '--test-concurrency=1',
      '--test-reporter=tap',
      'src/**/*.test.ts',
    ];
    const child = spawn('npx', args, {
      cwd,
      env: { ...process.env, FORCE_COLOR: '0' },
      // shell:true lets the glob be passed through; node:test expands it itself,
      // but quoting via shell ensures the literal glob reaches tsx unexpanded.
      shell: false,
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout?.on('data', d => {
      stdout += d.toString();
    });
    child.stderr?.on('data', d => {
      stderr += d.toString();
    });
    child.on('error', err => {
      clearTimeout(timer);
      resolve({ stdout, stderr: stderr + `\nspawn error: ${err.message}`, timedOut });
    });
    child.on('close', () => {
      clearTimeout(timer);
      if (timedOut) stderr += `\nrun timed out after ${timeoutMs}ms (killed)`;
      resolve({ stdout, stderr, timedOut });
    });
  });
}

/** Most recent run record, or null if none persisted yet. */
export async function latestTestRun(): Promise<TestRunRecord | null> {
  try {
    const rec = await fs.readJson(latestPath());
    return rec as TestRunRecord;
  } catch {
    // Fall back to head of history.
    try {
      const hist = await fs.readJson(historyPath());
      if (Array.isArray(hist) && hist.length) return hist[0] as TestRunRecord;
    } catch {
      /* ignore */
    }
    return null;
  }
}

/** Persisted run history, newest-first, optionally limited. */
export async function testRunHistory(limit?: number): Promise<TestRunRecord[]> {
  let hist: TestRunRecord[] = [];
  try {
    const raw = await fs.readJson(historyPath());
    if (Array.isArray(raw)) hist = raw as TestRunRecord[];
  } catch {
    hist = [];
  }
  if (typeof limit === 'number' && limit >= 0) return hist.slice(0, limit);
  return hist;
}

/**
 * Per-test status index keyed by `file::testName`, giving each test's latest
 * status plus a short status trend (last ~10 runs, newest-first). Built from
 * the persisted run history so the UI can render a green/red trend per test.
 */
export async function testStatusIndex(): Promise<Record<string, TestStatusEntry>> {
  const hist = await testRunHistory(); // newest-first
  const index: Record<string, TestStatusEntry> = {};

  // Walk newest -> oldest. The first time we see a key, that's its latest
  // status + last_run_at; subsequent appearances extend the trend history.
  for (const run of hist) {
    if (run.error) continue;
    for (const file of run.files) {
      for (const t of file.tests) {
        const key = `${file.file}::${t.name}`;
        let entry = index[key];
        if (!entry) {
          entry = { status: t.status, last_run_at: run.finished_at, history: [] };
          index[key] = entry;
        }
        if (entry.history.length < TREND_CAP) entry.history.push(t.status);
      }
    }
  }

  return index;
}
