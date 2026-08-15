import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRemoteAnalyzerHttpServer } from './remote-analyzer-service';
import { shutdownAnalysisWorker } from './analyzer';

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
  const installPrefix = path.join(root, 'install');
  const packDir = path.join(root, 'pack');
  const remoteData = path.join(root, 'remote-data');
  const npmCache = path.join(root, 'npm-cache');
  const results: StepResult[] = [];
  const env = {
    ...process.env,
    HOME: path.join(root, 'home'),
    USERPROFILE: path.join(root, 'home'),
    npm_config_cache: npmCache,
    NPM_CONFIG_CACHE: npmCache,
    KLAURO_STORAGE_PATH: path.join(root, 'storage'),
    KLAURO_REMOTE_ANALYZER_DATA: remoteData,
    KLAURO_SMOKE_MAX_STARTUP_MS: process.env.KLAURO_SMOKE_MAX_STARTUP_MS || '3000',
  };
  fs.mkdirSync(env.HOME, { recursive: true });
  fs.mkdirSync(npmCache, { recursive: true });
  fs.mkdirSync(packDir, { recursive: true });
  fs.cpSync(fixturePath, repo, { recursive: true });
  initGitRepo(repo, env);

  let server: ReturnType<typeof createRemoteAnalyzerHttpServer> | undefined;
  try {
    results.push(runStep('build customer artifact', () => {
      const result = run('npm', ['run', 'build'], env, 3 * 60 * 1000);
      assertOutput(result, /Built installed client/);
      return 'built the lightweight customer bundle';
    }));

    let tarball = '';
    results.push(runStep('pack and install from customer tarball', () => {
      const packed = run('npm', ['pack', path.join(packageRoot, '.customer-package'), '--pack-destination', packDir, '--json'], env);
      const payload = parseJson(packed.stdout) as Array<{ filename: string }>;
      tarball = path.join(packDir, payload[0].filename);
      run('npm', ['install', '--ignore-scripts', '--prefix', installPrefix, tarball], env);
      const packagePath = path.join(installPrefix, 'node_modules', '@klauro', 'mcp-server');
      if (fs.existsSync(path.join(packagePath, 'node_modules'))) throw new Error('Installed package unexpectedly contains dependencies');
      return `installed ${path.basename(tarball)} with no package-local dependencies`;
    }));

    const installedPackage = path.join(installPrefix, 'node_modules', '@klauro', 'mcp-server');
    const cliPath = path.join(installedPackage, 'dist', 'cli.cjs');
    const mcpPath = path.join(installedPackage, 'dist', 'index.cjs');
    results.push(runStep('installed CLI is executable', () => {
      const result = run(process.execPath, [cliPath, '--version'], env);
      assertOutput(result, /\d+\.\d+\.\d+\+/);
      return result.stdout.trim();
    }));

    const activeServer = createRemoteAnalyzerHttpServer({ dataDir: remoteData });
    server = activeServer;
    await new Promise<void>(resolve => activeServer.listen(0, '127.0.0.1', resolve));
    const address = activeServer.address();
    if (!address || typeof address !== 'object') throw new Error('Remote analyzer did not bind to a local port');
    const serverUrl = `http://127.0.0.1:${address.port}`;

    results.push(await runStepAsync('account registration', async () => {
      const result = await runAsync(process.execPath, [cliPath, 'login', '--server-url', serverUrl, '--email', 'beta@example.test', '--password', 'beta-password-123', '--register', '--json'], env);
      const payload = parseJson(result.stdout);
      if (payload.status !== 'signed-in') throw new Error(`Expected signed-in, got ${payload.status}`);
      return 'registered and stored the beta@example.test session';
    }));

    results.push(await runStepAsync('remote analyzer project init', async () => {
      const result = await runAsync(process.execPath, [cliPath, 'init', repo, '--server-url', serverUrl, '--force', '--json'], env);
      const payload = parseJson(result.stdout);
      if (payload.status !== 'ready' || !payload.project_id || !fs.existsSync(payload.config_file)) {
        throw new Error('Expected init to create a config and bind a hosted project');
      }
      return `.klaurorc binds project ${payload.project_id}`;
    }));

    results.push(await runStepAsync('hosted analyzer full analysis', async () => {
      const result = await runAsync(process.execPath, [cliPath, 'analyze', repo, '--wait', '--json'], env, 8 * 60 * 1000);
      const payload = parseJson(result.stdout);
      if (payload.status !== 'success') throw new Error(`Expected success, got ${payload.status}`);
      if ((payload.cas?.nodes?.length || 0) <= 0) throw new Error('Remote analysis returned no nodes');
      return `${payload.analysis_type} remote analysis returned ${payload.cas.nodes.length} nodes and ${payload.cas.edges.length} edges`;
    }));

    results.push(await runStepAsync('installed MCP first context', async () => {
      const payload = await callMcpTool(mcpPath, 'get_agent_start_context', { path: repo }, env);
      if (payload.error) throw new Error(String(payload.error));
      if (!JSON.stringify(payload).includes('system')) throw new Error('Agent start context did not include system context');
      return 'installed MCP returned hosted system context';
    }));

    results.push(await runStepAsync('hosted analyzer incremental sync', async () => {
      const appFile = path.join(repo, 'app', 'main.py');
      fs.appendFileSync(appFile, '\n\n@app.get("/readyz")\ndef readyz():\n    return {"ready": True}\n', 'utf8');
      const result = await runAsync(process.execPath, [cliPath, 'remote-sync', repo, '--wait', '--json'], env, 8 * 60 * 1000);
      const payload = parseJson(result.stdout);
      if (payload.status !== 'success') throw new Error(`Expected success, got ${payload.status}`);
      if (!payload.change_report) throw new Error('Remote sync did not return a change_report');
      if (!JSON.stringify(payload.cas?.entry_points || []).includes('readyz')) throw new Error('Incremental CAS did not include the new readyz route');
      return `incremental sync returned ${payload.change_report.summary.filesModified + payload.change_report.summary.filesAdded} changed file(s)`;
    }));

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
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    shutdownAnalysisWorker();
    if (process.env.KLAURO_KEEP_NEW_USER_E2E !== 'true') {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
}

function callMcpTool(bundlePath: string, tool: string, args: Record<string, unknown>, env: NodeJS.ProcessEnv): Promise<any> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bundlePath], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`MCP tool ${tool} timed out: ${trim(stderr)}`));
    }, 120_000);
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.stdout.on('data', chunk => {
      stdout += chunk.toString();
      let newline = stdout.indexOf('\n');
      while (newline >= 0) {
        const line = stdout.slice(0, newline).trim();
        stdout = stdout.slice(newline + 1);
        newline = stdout.indexOf('\n');
        if (!line) continue;
        const message = JSON.parse(line);
        if (message.id !== 2) continue;
        clearTimeout(timer);
        child.kill();
        if (message.error) {
          reject(new Error(message.error.message || JSON.stringify(message.error)));
          return;
        }
        const text = message.result?.content?.[0]?.text;
        try {
          resolve(typeof text === 'string' ? JSON.parse(text) : message.result);
        } catch {
          resolve({ text });
        }
        return;
      }
    });
    child.on('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.stdin.write([
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'klauro-new-user-e2e', version: '1' } } }),
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: tool, arguments: args } }),
      '',
    ].join('\n'));
  });
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
