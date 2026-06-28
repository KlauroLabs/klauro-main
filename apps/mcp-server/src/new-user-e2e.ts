import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRemoteAnalyzerHttpServer } from './remote-analyzer-service';

interface StepResult {
  name: string;
  ok: boolean;
  ms: number;
  detail: string;
}

const packageRoot = path.resolve(__dirname, '..');
const fixturePath = path.join(packageRoot, 'fixtures', 'analysis-truth', 'fastapi-sqlalchemy');
const maxTotalMs = Number(process.env.KLAURO_NEW_USER_E2E_MAX_MS || 10 * 60 * 1000);
const DEFAULT_OUTPUT_PATH = path.join(packageRoot, '.klauro-new-user-e2e', 'latest-report.json');

interface Options {
  outputPath: string | null;
}

interface NewUserE2EReport {
  generated_at: string;
  status: 'pass' | 'fail';
  total_ms: number;
  max_total_ms: number;
  workspace: string;
  steps: StepResult[];
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const startedAt = Date.now();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-new-user-e2e-'));
  const repo = path.join(root, 'repo');
  const storage = path.join(root, 'storage');
  const remoteData = path.join(root, 'remote-data');
  const results: StepResult[] = [];
  const env = {
    ...process.env,
    HOME: path.join(root, 'home'),
    KLAURO_STORAGE_PATH: storage,
    KLAURO_REMOTE_ANALYZER_DATA: remoteData,
    KLAURO_SMOKE_MAX_STARTUP_MS: process.env.KLAURO_SMOKE_MAX_STARTUP_MS || '3000',
  };
  fs.mkdirSync(env.HOME, { recursive: true });
  fs.cpSync(fixturePath, repo, { recursive: true });
  initGitRepo(repo, env);

  try {
    results.push(runStep('deterministic install plus first value', () => {
      const result = run(process.execPath, [
        path.join(packageRoot, 'scripts', 'install.mjs'),
        repo,
        '--no-register',
        '--rebuild',
        '--first-value',
      ], env, 8 * 60 * 1000);
      assertOutput(result, /Klauro install: OK/);
      assertOutput(result, /First value summary:/);
      assertOutput(result, /Graph: \d+ nodes, \d+ edges/);
      return 'installer built the bundle, skipped external registration, analyzed the repo, and produced an agent packet summary';
    }));

    const cliPath = path.join(packageRoot, 'dist', 'cli.cjs');
    results.push(runStep('installed CLI is executable', () => {
      const result = run(process.execPath, [cliPath, '--version'], env);
      assertOutput(result, /klauro /);
      return result.stdout.trim();
    }));

    const server = createRemoteAnalyzerHttpServer({ dataDir: remoteData });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address !== 'object') throw new Error('Remote analyzer did not bind to a local port');
    const serverUrl = `http://127.0.0.1:${address.port}`;

    try {
      results.push(await runStepAsync('remote analyzer project init', async () => {
        const result = await runAsync(process.execPath, [
          cliPath,
          'init',
          repo,
          '--mode',
          'remote',
          '--server-url',
          serverUrl,
          '--force',
          '--json',
        ], env);
        const payload = parseJson(result.stdout);
        if (payload.config?.analyzer?.mode !== 'remote') throw new Error('Expected .klaurorc analyzer.mode=remote');
        return `.klaurorc points at ${payload.config.analyzer.serverUrl}`;
      }));

      let analysisId = '';
      results.push(await runStepAsync('hosted analyzer full analysis', async () => {
        const result = await runAsync(process.execPath, [cliPath, 'analyze', repo, '--json'], env, 8 * 60 * 1000);
        const payload = parseJson(result.stdout);
        if (payload.status !== 'success') throw new Error(`Expected success, got ${payload.status}`);
        if ((payload.cas?.nodes?.length || 0) <= 0) throw new Error('Remote analysis returned no nodes');
        analysisId = payload.analysis_id;
        return `${payload.analysis_type} remote analysis returned ${payload.cas.nodes.length} nodes and ${payload.cas.edges.length} edges`;
      }));

      results.push(await runStepAsync('hosted analyzer incremental sync', async () => {
        const appFile = path.join(repo, 'app', 'main.py');
        fs.appendFileSync(appFile, '\n\n@app.get("/readyz")\ndef readyz():\n    return {"ready": True}\n', 'utf8');
        const result = await runAsync(process.execPath, [cliPath, 'remote-sync', repo, '--analysis-id', analysisId, '--json'], env, 8 * 60 * 1000);
        const payload = parseJson(result.stdout);
        if (payload.status !== 'success') throw new Error(`Expected success, got ${payload.status}`);
        if (!payload.change_report) throw new Error('Remote sync did not return a change_report');
        if (!JSON.stringify(payload.cas.entry_points || []).includes('readyz')) throw new Error('Incremental CAS did not include the new readyz route');
        return `incremental sync returned ${payload.change_report.summary.filesModified + payload.change_report.summary.filesAdded} changed file(s)`;
      }));
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }

    const totalMs = Date.now() - startedAt;
    if (totalMs > maxTotalMs) {
      throw new Error(`New-user E2E exceeded ${maxTotalMs}ms: ${totalMs}ms`);
    }

    const report = buildReport(results, totalMs, root);
    if (options.outputPath) {
      fs.mkdirSync(path.dirname(options.outputPath), { recursive: true });
      fs.writeFileSync(options.outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    }
    process.stdout.write(formatReport(report));
  } finally {
    if (process.env.KLAURO_KEEP_NEW_USER_E2E !== 'true') {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
}

function runStep(name: string, fn: () => string): StepResult {
  const startedAt = Date.now();
  try {
    const detail = fn();
    return { name, ok: true, ms: Date.now() - startedAt, detail };
  } catch (error) {
    return {
      name,
      ok: false,
      ms: Date.now() - startedAt,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

async function runStepAsync(name: string, fn: () => Promise<string>): Promise<StepResult> {
  const startedAt = Date.now();
  try {
    const detail = await fn();
    return { name, ok: true, ms: Date.now() - startedAt, detail };
  } catch (error) {
    return {
      name,
      ok: false,
      ms: Date.now() - startedAt,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv, timeout = 120000, cwd = packageRoot): { stdout: string; stderr: string } {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    timeout,
    maxBuffer: 128 * 1024 * 1024,
  });
  if (result.status !== 0 || result.error) {
    throw new Error([
      `Command failed: ${command} ${args.join(' ')}`,
      result.error ? `error: ${result.error.message}` : undefined,
      result.stdout ? `stdout: ${trim(result.stdout)}` : undefined,
      result.stderr ? `stderr: ${trim(result.stderr)}` : undefined,
    ].filter(Boolean).join('\n'));
  }
  return { stdout: result.stdout || '', stderr: result.stderr || '' };
}

function runAsync(command: string, args: string[], env: NodeJS.ProcessEnv, timeout = 120000, cwd = packageRoot): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Command timed out after ${timeout}ms: ${command} ${args.join(' ')}\nstdout: ${trim(stdout)}\nstderr: ${trim(stderr)}`));
    }, timeout);
    child.stdout.on('data', chunk => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
    });
    child.on('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error([
          `Command failed: ${command} ${args.join(' ')}`,
          stdout ? `stdout: ${trim(stdout)}` : undefined,
          stderr ? `stderr: ${trim(stderr)}` : undefined,
        ].filter(Boolean).join('\n')));
      }
    });
  });
}

function initGitRepo(repo: string, env: NodeJS.ProcessEnv): void {
  run('git', ['init'], env, 30000, repo);
  run('git', ['config', 'user.email', 'test@example.com'], env, 30000, repo);
  run('git', ['config', 'user.name', 'Test User'], env, 30000, repo);
  run('git', ['add', '.'], env, 30000, repo);
  run('git', ['commit', '-m', 'fixture'], env, 30000, repo);
}

function assertOutput(result: { stdout: string; stderr: string }, pattern: RegExp): void {
  const output = `${result.stdout}\n${result.stderr}`;
  if (!pattern.test(output)) throw new Error(`Expected output to match ${pattern}, got: ${trim(output)}`);
}

function parseJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Could not parse JSON output: ${trim(text)}`);
  }
}

function parseArgs(argv: string[]): Options {
  let outputPath: string | null = DEFAULT_OUTPUT_PATH;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--output') {
      outputPath = path.resolve(argv[++i]);
    } else if (arg === '--no-output') {
      outputPath = null;
    } else if (arg === '--help' || arg === '-h') {
      process.stdout.write([
        'Usage: npm run new-user-e2e -- [options]',
        '',
        'Options:',
        '  --output /path/report.json  Write JSON report (default: .klauro-new-user-e2e/latest-report.json)',
        '  --no-output                 Do not write a JSON report.',
      ].join('\n') + '\n');
      process.exit(0);
    }
  }
  return { outputPath };
}

function buildReport(results: StepResult[], totalMs: number, root: string): NewUserE2EReport {
  const failed = results.filter(result => !result.ok);
  return {
    generated_at: new Date().toISOString(),
    status: failed.length ? 'fail' : 'pass',
    total_ms: totalMs,
    max_total_ms: maxTotalMs,
    workspace: process.env.KLAURO_KEEP_NEW_USER_E2E === 'true' ? root : 'deleted',
    steps: results,
  };
}

function formatReport(report: NewUserE2EReport): string {
  const failed = report.steps.filter(result => !result.ok);
  const lines = [
    `Klauro new-user E2E: ${failed.length ? 'FAIL' : 'PASS'}`,
    `Total: ${report.total_ms}ms`,
    `Workspace: ${report.workspace}`,
    '',
    ...report.steps.map(result => `${result.ok ? 'PASS' : 'FAIL'} ${result.name} (${result.ms}ms): ${result.detail}`),
    '',
  ];
  if (failed.length > 0) {
    process.exitCode = 1;
  }
  return lines.join('\n');
}

function trim(value: string): string {
  return value.trim().replace(/\s+/g, ' ').slice(0, 1200);
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exit(1);
});
