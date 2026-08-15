

















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


function repoRoot(): string {
  return path.resolve(__dirname, '..', '..');
}






const RESULT_RE = /^(?<indent>\s*)(?<neg>not )?ok\b\s*(?<num>\d+)?\s*(?:-\s*)?(?<rest>.*)$/;
const DURATION_RE = /^\s*duration_ms:\s*([\d.eE+-]+)\s*$/;
const SUBTEST_RE = /^\s*#\s*Subtest:\s*(.*)$/;
const LOCATION_RE = /^\s*location:\s*'?([^':]+\.ts)(?::\d+)?(?::\d+)?'?\s*$/;
const PLAN_RE = /^\s*1\.\.(\d+)\s*$/;







export function parseTap(tapText: string): ParsedTap {
  const lines = tapText.split(/\r?\n/);
  const tests: TestResult[] = [];



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

    if (PLAN_RE.test(line)) continue;

    let rest = m.groups.rest ?? '';
    const isFail = !!m.groups.neg;


    let status: TestStatus = isFail ? 'fail' : 'pass';
    const directiveMatch = /#\s*(SKIP|TODO)\b/i.exec(rest);
    if (directiveMatch) {
      status = 'skip';
      rest = rest.slice(0, directiveMatch.index).trim();
    }

    const name = (pendingSubtest ?? rest).trim();
    pendingSubtest = null;

    if (!name) continue;


    let duration_ms = 0;
    let file: string | undefined;
    for (let j = i + 1; j < lines.length; j++) {
      const yl = lines[j];

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






async function buildNameToFile(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    const inv = await buildTestInventory();
    for (const area of inv.areas) {
      for (const f of area.files) {
        for (const t of f.tests) {

          if (!map.has(t.name)) map.set(t.name, f.file);
        }
      }
    }
  } catch {

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





function makeRunId(startedAt: Date): string {
  return `run_${startedAt.toISOString().replace(/[^\dTZ]/g, '').replace(/[TZ]/g, '_')}${Math.random()
    .toString(36)
    .slice(2, 6)}`;
}







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


export async function latestTestRun(): Promise<TestRunRecord | null> {
  try {
    const rec = await fs.readJson(latestPath());
    return rec as TestRunRecord;
  } catch {

    try {
      const hist = await fs.readJson(historyPath());
      if (Array.isArray(hist) && hist.length) return hist[0] as TestRunRecord;
    } catch {

    }
    return null;
  }
}


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






export async function testStatusIndex(): Promise<Record<string, TestStatusEntry>> {
  const hist = await testRunHistory();
  const index: Record<string, TestStatusEntry> = {};



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
