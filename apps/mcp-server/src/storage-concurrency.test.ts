import { strict as assert } from 'assert';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { test } from 'node:test';
import {
  acquireStorageLock,
  listAnalyses,
  pruneOrphanedTmpFiles,
  writeJsonAtomic,
} from './storage';

const APP_DIR = path.resolve(__dirname, '..');
const STORAGE_MODULE = path.join(__dirname, 'storage');

function resolveTsxBin(): string {
  const executable = process.platform === 'win32' ? 'tsx.cmd' : 'tsx';
  const candidates = [
    path.join(APP_DIR, 'node_modules', '.bin', executable),
    path.join(APP_DIR, '..', '..', 'node_modules', '.bin', executable),
  ];
  const found = candidates.find(candidate => fs.pathExistsSync(candidate));
  if (!found) {
    throw new Error(`Unable to find tsx binary. Checked: ${candidates.join(', ')}`);
  }
  return found;
}

const TSX_BIN = resolveTsxBin();

function restoreEnv(name: string, previous: string | undefined): void {
  if (previous === undefined) delete process.env[name];
  else process.env[name] = previous;
}

interface ChildOutcome {
  exitCode: number | null;
  stderr: string;
}

function runChild(scriptPath: string, args: string[], env: Record<string, string>): Promise<ChildOutcome> {
  return new Promise(resolve => {
    const child = spawn(TSX_BIN, [scriptPath, ...args], {
      cwd: APP_DIR,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', chunk => {
      if (stderr.length < 64 * 1024) stderr += chunk.toString();
    });
    child.on('error', error => resolve({ exitCode: null, stderr: String(error) }));
    child.on('close', code => resolve({ exitCode: code, stderr }));
  });
}

async function findDeadPid(): Promise<number> {
  const child = spawn('node', ['-e', ''], { stdio: 'ignore' });
  const pid = child.pid!;
  await new Promise<void>(resolve => child.on('close', () => resolve()));
  return pid;
}

test('concurrent index writes from two real processes do not lose entries', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-index-lock-'));
  const storageDir = path.join(root, 'storage');
  const helperPath = path.join(root, 'index-writer.ts');
  await fs.writeFile(
    helperPath,
    [
      `import { saveAnalysis } from '${STORAGE_MODULE}';`,
      `const label = process.argv[2];`,
      `const count = Number(process.argv[3]);`,
      `async function main(): Promise<void> {`,
      `  for (let i = 0; i < count; i++) {`,
      `    const projectPath = '${root.replace(/'/g, "\\'")}/projects/' + label + '-' + i;`,
      `    await saveAnalysis(projectPath, {`,
      `      cas_version: '1.11.0',`,
      `      analysis_timestamp: new Date().toISOString(),`,
      `      analysis_id: 'analysis-' + label + '-' + i,`,
      `      system: { id: label + '-' + i, name: label + '-' + i, type: 'service', root_path: projectPath },`,
      `      nodes: [], edges: [], entry_points: [], exit_points: [], analyzer_contributions: [],`,
      `    } as never);`,
      `  }`,
      `}`,
      `main().then(() => process.exit(0), error => { console.error(error); process.exit(1); });`,
    ].join('\n'),
  );

  const env = {
    KLAURO_STORAGE_PATH: storageDir,
    KLAURO_ANALYSIS_COMPRESSION: 'none',
  };
  const entriesPerChild = 8;
  const [left, right] = await Promise.all([
    runChild(helperPath, ['left', String(entriesPerChild)], env),
    runChild(helperPath, ['right', String(entriesPerChild)], env),
  ]);
  assert.equal(left.exitCode, 0, `left child failed: ${left.stderr}`);
  assert.equal(right.exitCode, 0, `right child failed: ${right.stderr}`);

  const index = await fs.readJson(path.join(storageDir, 'index.json'));
  const paths = Object.keys(index.analyses);
  assert.equal(paths.length, entriesPerChild * 2, `index lost entries; have: ${paths.join(', ')}`);
  for (const label of ['left', 'right']) {
    for (let i = 0; i < entriesPerChild; i++) {
      assert.ok(paths.some(p => p.endsWith(`${label}-${i}`)), `missing index entry for ${label}-${i}`);
    }
  }
  assert.ok(!(await fs.pathExists(path.join(storageDir, 'index.json.lock'))), 'index lock not released');

  const previous = process.env.KLAURO_STORAGE_PATH;
  process.env.KLAURO_STORAGE_PATH = storageDir;
  try {
    // Anchor the workspace-isolation scope on the temp storage dir (no
    // .klaurorc => machine-wide view). Without scopeCwd the scope resolves
    // from process.cwd() — this repo, which is bound to a hosted workspace —
    // and the temp-path entries (no .klaurorc of their own) would be
    // filtered out as out-of-scope. This test is about lock/index integrity,
    // not scoping.
    const listed = await listAnalyses({ scopeCwd: storageDir });
    assert.equal(listed.length, entriesPerChild * 2);
  } finally {
    restoreEnv('KLAURO_STORAGE_PATH', previous);
  }
  await fs.remove(root);
});

test('per-project analysis lock serializes two real processes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-analysis-lock-'));
  const storageDir = path.join(root, 'storage');
  const logFile = path.join(root, 'lock-log.txt');
  const projectPath = path.join(root, 'project');
  const helperPath = path.join(root, 'lock-holder.ts');
  await fs.writeFile(
    helperPath,
    [
      `import { withProjectAnalysisLock } from '${STORAGE_MODULE}';`,
      `import * as fs from 'node:fs';`,
      `const logFile = process.argv[2];`,
      `const projectPath = process.argv[3];`,
      `withProjectAnalysisLock(projectPath, async () => {`,
      `  fs.appendFileSync(logFile, 'start ' + process.pid + '\\n');`,
      `  await new Promise(resolve => setTimeout(resolve, 400));`,
      `  fs.appendFileSync(logFile, 'end ' + process.pid + '\\n');`,
      `}).then(() => process.exit(0), error => { console.error(error); process.exit(1); });`,
    ].join('\n'),
  );

  const env = { KLAURO_STORAGE_PATH: storageDir };
  const [first, second] = await Promise.all([
    runChild(helperPath, [logFile, projectPath], env),
    runChild(helperPath, [logFile, projectPath], env),
  ]);
  assert.equal(first.exitCode, 0, `first child failed: ${first.stderr}`);
  assert.equal(second.exitCode, 0, `second child failed: ${second.stderr}`);

  const lines = (await fs.readFile(logFile, 'utf8')).trim().split('\n');
  assert.equal(lines.length, 4, `expected 4 log lines, got: ${lines.join(' | ')}`);
  const [a, b, c, d] = lines.map(line => line.split(' '));
  assert.equal(a[0], 'start');
  assert.equal(b[0], 'end');
  assert.equal(a[1], b[1], 'first start/end pids differ; critical sections interleaved');
  assert.equal(c[0], 'start');
  assert.equal(d[0], 'end');
  assert.equal(c[1], d[1], 'second start/end pids differ; critical sections interleaved');
  await fs.remove(root);
});

test('a stale lock held by a dead process is broken via the pid-alive check', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-stale-lock-'));
  const lockPath = path.join(root, 'index.json.lock');
  const deadPid = await findDeadPid();
  await fs.writeFile(lockPath, JSON.stringify({
    pid: deadPid,
    hostname: os.hostname(),
    acquired_at: new Date().toISOString(),
  }));

  const handle = await acquireStorageLock(lockPath, { waitMs: 5_000, staleMs: 60 * 60_000, purpose: 'Stale lock test' });
  const info = await fs.readJson(lockPath);
  assert.equal(info.pid, process.pid, 'lock was not re-acquired by the live process');
  await handle.release();
  assert.ok(!(await fs.pathExists(lockPath)));
  await fs.remove(root);
});

test('an unreadable lock older than the age cap is broken', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-aged-lock-'));
  const lockPath = path.join(root, 'analysis.lock');
  await fs.writeFile(lockPath, 'not json');
  const oldTime = new Date(Date.now() - 2 * 60 * 60 * 1000);
  await fs.utimes(lockPath, oldTime, oldTime);

  const handle = await acquireStorageLock(lockPath, { waitMs: 5_000, staleMs: 60 * 60_000, purpose: 'Aged lock test' });
  assert.equal((await fs.readJson(lockPath)).pid, process.pid);
  await handle.release();
  await fs.remove(root);
});

test('lock acquisition is bounded: a held lock yields a clear in-progress error, never a deadlock', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-held-lock-'));
  const lockPath = path.join(root, 'analysis.lock');
  await fs.writeFile(lockPath, JSON.stringify({
    pid: process.pid,
    hostname: os.hostname(),
    acquired_at: new Date().toISOString(),
  }));

  const startedAt = Date.now();
  await assert.rejects(
    acquireStorageLock(lockPath, { waitMs: 400, staleMs: 60 * 60_000, purpose: 'Analysis of /tmp/p' }),
    (error: Error) =>
      error.message.includes('already in progress') &&
      error.message.includes(`pid ${process.pid}`) &&
      error.message.includes(lockPath),
  );
  assert.ok(Date.now() - startedAt < 5_000, 'bounded wait took far longer than the cap');
  await fs.remove(root);
});

test('writeJsonAtomic removes its tmp file when the write throws', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-atomic-tmp-'));
  const target = path.join(root, 'value.json');

  const nodes: unknown[] = Array.from({ length: 100_001 }, (_, index) => ({ id: index }));
  nodes[100_000] = { toJSON: () => { throw new Error('simulated mid-write failure'); } };

  await assert.rejects(
    writeJsonAtomic(target, { nodes }),
    (error: Error) => error.message.includes('simulated mid-write failure'),
  );

  const leftovers = (await fs.readdir(root)).filter(file => file.endsWith('.tmp'));
  assert.deepEqual(leftovers, [], `orphaned tmp files left behind: ${leftovers.join(', ')}`);
  assert.ok(!(await fs.pathExists(target)), 'target file must not exist after a failed write');
  await fs.remove(root);
});

test('pruneOrphanedTmpFiles removes aged orphans and keeps fresh and non-tmp files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-tmp-sweep-'));
  const nested = path.join(root, 'project-slug', 'snapshots');
  await fs.ensureDir(nested);

  const agedTmp = path.join(nested, 'snapshot.json.123.456.tmp');
  const freshTmp = path.join(root, 'index.json.789.012.tmp');
  const realFile = path.join(root, 'index.json');
  await fs.writeFile(agedTmp, '{}');
  await fs.writeFile(freshTmp, '{}');
  await fs.writeFile(realFile, '{"analyses":{}}');
  const oldTime = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  await fs.utimes(agedTmp, oldTime, oldTime);

  const { removed } = await pruneOrphanedTmpFiles({ root, maxAgeMs: 24 * 60 * 60 * 1000 });
  assert.deepEqual(removed, [agedTmp]);
  assert.ok(!(await fs.pathExists(agedTmp)));
  assert.ok(await fs.pathExists(freshTmp), 'fresh tmp file must be retained');
  assert.ok(await fs.pathExists(realFile), 'non-tmp files must never be swept');
  await fs.remove(root);
});
