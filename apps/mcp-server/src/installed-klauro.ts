import { spawn, spawnSync } from 'child_process';
import type { AnalysisFocus } from './analysis-focus';
import type { IncrementalAnalysisResult } from './analyzer';

export interface InstalledKlauroCommand {
  command: string;
  args: string[];
  display: string;
}

export interface InstalledKlauroRunOptions {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  serverUrl?: string;
}

export function resolveInstalledKlauroCommand(): InstalledKlauroCommand {
  const configured = process.env.KLAURO_INSTALLED_CLI || 'klauro';
  const parts = splitCommand(configured);
  return {
    command: parts[0],
    args: parts.slice(1),
    display: configured,
  };
}

export function getInstalledKlauroVersion(options: InstalledKlauroRunOptions = {}): string {
  const installed = resolveInstalledKlauroCommand();
  const result = spawnSync(installed.command, [...installed.args, '--version'], {
    env: { ...process.env, ...(options.env || {}) },
    encoding: 'utf8',
    timeout: options.timeoutMs || 30_000,
    maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0 || result.error) {
    throw new Error([
      `Installed Klauro CLI is not executable: ${installed.display}`,
      result.error ? `error: ${result.error.message}` : undefined,
      result.stdout ? `stdout: ${result.stdout.trim()}` : undefined,
      result.stderr ? `stderr: ${result.stderr.trim()}` : undefined,
    ].filter(Boolean).join('\n'));
  }
  return (result.stdout || result.stderr || '').trim();
}

export async function analyzeWithInstalledKlauro(
  projectPath: string,
  options: InstalledKlauroRunOptions & { forceFull?: boolean; analysisFocus?: AnalysisFocus } = {},
): Promise<IncrementalAnalysisResult> {
  const installed = resolveInstalledKlauroCommand();
  const args = [
    ...installed.args,
    'analyze',
    projectPath,
    '--json',
    '--quiet',
  ];
  if (options.serverUrl) args.push('--server-url', options.serverUrl);
  if (options.forceFull) args.push('--force');
  if (options.analysisFocus) args.push('--analysis-focus', options.analysisFocus);

  const result = await runJsonCommand(installed.command, args, options);
  // Normalize across the two CLI payload shapes:
  //   local  analyze -> { output: <cas>, changeReport, state, wasFullRebuild, ... }
  //   remote analyze -> { cas: <cas>, change_report, analysis_type, ... }  (hosted product path)
  const output = result?.output ?? result?.cas;
  const changeReport = result?.changeReport ?? result?.change_report ?? null;
  if (!output?.nodes) {
    throw new Error(`Installed Klauro CLI returned an unexpected analyze payload for ${projectPath}`);
  }
  return {
    output,
    state: result.state,
    changeReport,
    wasFullRebuild: Boolean(result.wasFullRebuild ?? result.was_full_rebuild ?? result.analysis_type === 'full'),
    fullRebuildReason: result.fullRebuildReason ?? result.full_rebuild_reason,
  };
}

function runJsonCommand(command: string, args: string[], options: InstalledKlauroRunOptions): Promise<any> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: { ...process.env, ...(options.env || {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Command timed out after ${options.timeoutMs || 120_000}ms: ${command} ${args.join(' ')}\nstdout: ${trim(stdout)}\nstderr: ${trim(stderr)}`));
    }, options.timeoutMs || 120_000);

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
      if (code !== 0) {
        reject(new Error([
          `Command failed: ${command} ${args.join(' ')}`,
          stdout ? `stdout: ${trim(stdout)}` : undefined,
          stderr ? `stderr: ${trim(stderr)}` : undefined,
        ].filter(Boolean).join('\n')));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error(`Command did not emit JSON: ${command} ${args.join(' ')}\nstdout: ${trim(stdout)}\nstderr: ${trim(stderr)}`));
      }
    });
  });
}

function splitCommand(value: string): string[] {
  return value.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)
    ?.map(part => part.replace(/^['"]|['"]$/g, '')) || ['klauro'];
}

function trim(value: string): string {
  return value.length > 4000 ? `${value.slice(0, 4000)}...` : value;
}
