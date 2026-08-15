#!/usr/bin/env node

import { availableParallelism, tmpdir } from 'node:os';
import * as crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { glob } from 'glob';

const require = createRequire(import.meta.url);
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cachePath = path.join(packageRoot, 'node_modules', '.cache', 'klauro-test-suite-plan.json');
const artifactTestFiles = new Set([
  'src/gauntlet/grammar-packaging.test.ts',
  'src/installed-client-boundary.test.ts',



  'src/installed-cli-update-command.test.ts',




  'src/installed-cli-ops-commands.test.ts',




  'src/mcp-surface-live-e2e.test.ts',
]);












const BENCHMARK_ROLE_RE = /-benchmark(-|\.)|^src\/gauntlet\//;
export function isBenchmarkRole(file) {
  return BENCHMARK_ROLE_RE.test(file);
}

export const TEST_GROUPS = Object.freeze({
  all: () => true,
  core: file => !file.startsWith('src/gauntlet/'),
  gauntlet: file => file.startsWith('src/gauntlet/'),
  fast: file => !isBenchmarkRole(file),
  bench: file => isBenchmarkRole(file),
  live: file => file === 'src/mcp-surface-live-e2e.test.ts',
});

export function defaultConcurrency(cpuCount = availableParallelism()) {
  return Math.max(1, Math.min(3, cpuCount - 1));
}
















export function shortTempBase(platform = process.platform, systemTemp = tmpdir()) {
  if (platform === 'win32') return systemTemp;
  return systemTemp.length <= '/tmp'.length ? systemTemp : '/tmp';
}

export function testWeight(source, file) {
  const testCount = (source.match(/\b(?:test|it)\s*\(/g) || []).length;
  const expensiveOperations = (source.match(/\b(?:analyzeForBench|analyzeCodebase|orchestrateAnalysis|spawn|execFile)\b/g) || []).length;
  const gauntletWeight = file.startsWith('src/gauntlet/') ? 50_000 : 0;
  return Buffer.byteLength(source) + testCount * 1_000 + expensiveOperations * 15_000 + gauntletWeight;
}

export async function discoverTestPlan(group = 'all') {
  const accepts = TEST_GROUPS[group];
  if (!accepts) throw new Error(`Unknown test group "${group}". Expected one of: ${Object.keys(TEST_GROUPS).join(', ')}`);

  const files = (await glob('src/**/*.test.ts', { cwd: packageRoot, nodir: true })).sort();
  const cached = await loadPlanCache();
  const nextCache = { version: 1, files: {} };
  const planned = [];

  for (const file of files) {
    const absolute = path.join(packageRoot, file);
    const metadata = await stat(absolute);
    const cachedEntry = cached?.files?.[file];
    let weight;
    if (cachedEntry?.mtime_ms === metadata.mtimeMs && cachedEntry?.size === metadata.size) {
      weight = cachedEntry.weight;
    } else {
      weight = testWeight(await readFile(absolute, 'utf8'), file);
    }
    nextCache.files[file] = { mtime_ms: metadata.mtimeMs, size: metadata.size, weight };
    if (accepts(file)) planned.push({ file, weight });
  }

  await mkdir(path.dirname(cachePath), { recursive: true });
  await writeFile(cachePath, `${JSON.stringify(nextCache)}\n`, 'utf8');
  return planned.sort((left, right) => right.weight - left.weight || left.file.localeCompare(right.file));
}

export function parseOptions(argv, environment = process.env) {
  let group = 'all';
  let concurrency = Number(environment.KLAURO_TEST_CONCURRENCY || 0) || defaultConcurrency();
  let list = false;
  const selectedFiles = [];
  const forwarded = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--group') group = argv[++index] || '';
    else if (value === '--concurrency') concurrency = Number(argv[++index]);
    else if (value === '--list') list = true;
    else if (value === '--file') selectedFiles.push(argv[++index] || '');
    else forwarded.push(value);
  }
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('--concurrency must be a positive integer');
  if (selectedFiles.some(file => !file)) throw new Error('--file requires a test file path');
  return { group, concurrency, forwarded, list, selectedFiles };
}

async function main() {
  const { group, concurrency, forwarded, list, selectedFiles } = parseOptions(process.argv.slice(2));
  const discovered = await discoverTestPlan(group);
  const selected = new Set(selectedFiles.map(file => file.split(path.sep).join('/')));
  const plan = selected.size > 0 ? discovered.filter(item => selected.has(item.file)) : discovered;
  if (plan.length === 0) throw new Error(`No test files found for group "${group}"`);
  if (list) {
    process.stdout.write(`${JSON.stringify({ group, concurrency, files: plan })}\n`);
    return;
  }

  const tsxCli = require.resolve('tsx/cli');
  const started = Date.now();
  process.stderr.write(`[Klauro test suite] group=${group} files=${plan.length} concurrency=${concurrency}\n`);



  const runParent = path.join(shortTempBase(), 'klauro-tests');
  await mkdir(runParent, { recursive: true });
  const runRoot = await mkdtemp(path.join(runParent, 'run-'));
  let nextIndex = 0;
  const failures = [];
  const totals = { tests: 0, passed: 0, failed: 0, skipped: 0, crashed: 0 };
  const activeChildren = new Set();
  let interrupted = false;
  const terminate = () => {
    interrupted = true;
    for (const child of activeChildren) child.kill('SIGTERM');
  };
  process.once('SIGTERM', terminate);
  process.once('SIGINT', terminate);
  try {
    const record = async item => {
      const result = await runTestFile(tsxCli, item.file, forwarded, runRoot, activeChildren);
      totals.tests += result.summary.tests;
      totals.passed += result.summary.passed;
      totals.failed += result.summary.failed;
      totals.skipped += result.summary.skipped;
      process.stdout.write(`\n# [Klauro test file] ${item.file} status=${result.exitCode} duration=${result.durationMs}ms\n`);
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      if (result.exitCode !== 0) failures.push(item.file);




      if (result.exitCode !== 0 && result.summary.tests === 0) totals.crashed += 1;
    };
    const exclusive = plan.filter(item => artifactTestFiles.has(item.file));
    const parallel = plan.filter(item => !artifactTestFiles.has(item.file));
    if (exclusive.length > 0) {
      for (const item of exclusive) {
        await runBuildPrerequisite(item.file === 'src/gauntlet/grammar-packaging.test.ts');
        await record(item);
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, parallel.length) }, async () => {
      while (true) {
        if (interrupted) return;
        const index = nextIndex++;
        if (index >= parallel.length) return;
        await record(parallel[index]);
      }
    }));
  } finally {
    process.removeListener('SIGTERM', terminate);
    process.removeListener('SIGINT', terminate);
    await rm(runRoot, { recursive: true, force: true });
  }
  const exitCode = interrupted ? 143 : failures.length === 0 ? 0 : 1;
  if (failures.length > 0) process.stderr.write(`[Klauro test suite] failed files (${failures.length}): ${failures.join(', ')}\n`);
  process.stderr.write(`[Klauro test suite] completed in ${((Date.now() - started) / 1000).toFixed(1)}s files=${plan.length} tests=${totals.tests} pass=${totals.passed} fail=${totals.failed} skipped=${totals.skipped} crashed_files=${totals.crashed} exit=${exitCode}\n`);
  process.exitCode = exitCode;
}

async function runBuildPrerequisite(hosted) {
  process.stderr.write(`[Klauro test suite] building ${hosted ? 'hosted' : 'installed'} artifacts for packaging boundary tests\n`);
  const child = spawn(process.execPath, [path.join(packageRoot, 'scripts', 'build-bundle.mjs'), ...(hosted ? ['--hosted'] : [])], {
    cwd: packageRoot,
    env: process.env,
    stdio: 'inherit',
  });
  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve(signal ? 1 : (code ?? 1)));
  });
  if (exitCode !== 0) throw new Error(`Installed-artifact prerequisite build failed with exit code ${exitCode}`);
}

async function runTestFile(tsxCli, file, forwarded, runRoot, activeChildren) {


  const key = crypto.createHash('sha256').update(file).digest('hex').slice(0, 10);
  const isolatedRoot = path.join(runRoot, key);
  const home = path.join(isolatedRoot, 'home');
  const temporary = path.join(isolatedRoot, 'tmp');
  await Promise.all([home, temporary].map(directory => mkdir(directory, { recursive: true })));
  const started = Date.now();
  const child = spawn(process.execPath, [tsxCli, '--test', '--test-concurrency=1', ...forwarded, file], {
    cwd: packageRoot,
    env: {
      ...process.env,
      HOME: home,
      TMPDIR: temporary,
      XDG_CACHE_HOME: path.join(isolatedRoot, 'cache'),
      KLAURO_STORAGE_PATH: path.join(isolatedRoot, 'storage'),
      KLAURO_REMOTE_ANALYZER_DATA: path.join(isolatedRoot, 'remote-data'),
      KLAURO_ANALYSIS_WORKER_IDLE_MS: process.env.KLAURO_ANALYSIS_WORKER_IDLE_MS || '25',
      KLAURO_EMBEDDING_ENABLED: process.env.KLAURO_EMBEDDING_ENABLED || 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  activeChildren.add(child);
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', chunk => stdout.push(chunk));
  child.stderr.on('data', chunk => stderr.push(chunk));
  try {
    const exitCode = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve(signal ? 1 : (code ?? 1)));
    });
    const stdoutText = Buffer.concat(stdout).toString('utf8');
    return {
      exitCode,
      durationMs: Date.now() - started,
      stdout: stdoutText,
      stderr: Buffer.concat(stderr).toString('utf8'),
      summary: parseTapSummary(stdoutText),
    };
  } finally {
    activeChildren.delete(child);
  }
}

export function parseTapSummary(output) {





  const value = label => Number(output.match(new RegExp(`^(?:#|\\u2139) ${label} (\\d+)$`, 'm'))?.[1] || 0);
  return { tests: value('tests'), passed: value('pass'), failed: value('fail'), skipped: value('skipped') };
}

async function loadPlanCache() {
  try {
    const parsed = JSON.parse(await readFile(cachePath, 'utf8'));
    return parsed?.version === 1 ? parsed : undefined;
  } catch {
    return undefined;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
