import { spawn, spawnSync } from 'child_process';
import { Transform } from 'node:stream';
import type { AnalysisFocus } from './analysis-focus';
import type { IncrementalAnalysisResult } from './analyzer';
import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import { decodeCasExportStream } from './cas-export-decoder';

export interface InstalledKlauroCommand {
  command: string;
  args: string[];
  display: string;
}

export interface InstalledKlauroRunOptions {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  serverUrl?: string;
  analysisId?: string;
  jsonBufferLimitBytes?: number;
}

export interface InstalledKlauroAnalysisResult {
  output: CASOutput;
  changeReport?: IncrementalAnalysisResult['changeReport'];
  wasFullRebuild: boolean;
  fullRebuildReason?: string;
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

export async function initializeInstalledKlauroProject(
  projectPath: string,
  options: InstalledKlauroRunOptions = {},
): Promise<any> {
  const installed = resolveInstalledKlauroCommand();
  const args = [
    ...installed.args,
    'init',
    projectPath,
    '--json',
  ];
  if (options.serverUrl) args.push('--server-url', options.serverUrl);
  return runJsonCommand(installed.command, args, options);
}

export async function analyzeCasWithInstalledKlauro(
  projectPath: string,
  options: InstalledKlauroRunOptions & { forceFull?: boolean; analysisFocus?: AnalysisFocus } = {},
): Promise<InstalledKlauroAnalysisResult> {
  const installed = resolveInstalledKlauroCommand();
  const args = [
    ...installed.args,
    'analyze',
    projectPath,
    '--json',
    '--wait',
  ];
  if (options.serverUrl) args.push('--server-url', options.serverUrl);
  if (options.analysisId) args.push('--analysis-id', options.analysisId);
  if (options.forceFull) args.push('--force');
  if (options.analysisFocus) args.push('--analysis-focus', options.analysisFocus);

  return parseInstalledAnalysis(await runJsonCommand(installed.command, args, options), projectPath, 'analyze');
}

export async function syncWithInstalledKlauro(
  projectPath: string,
  options: InstalledKlauroRunOptions = {},
): Promise<IncrementalAnalysisResult> {
  const installed = resolveInstalledKlauroCommand();
  const args = [...installed.args, 'sync', projectPath, '--json', '--wait'];
  if (options.serverUrl) args.push('--server-url', options.serverUrl);
  if (options.analysisId) args.push('--analysis-id', options.analysisId);
  const result = parseInstalledAnalysis(
    await runJsonCommand(installed.command, args, options),
    projectPath,
    'sync',
  );
  if (!result.changeReport?.summary || !result.changeReport?.impact) {
    throw new Error(`Installed Klauro CLI returned a sync payload without an incremental change report for ${projectPath}`);
  }
  return {
    output: result.output,
    changeReport: result.changeReport,
    wasFullRebuild: result.wasFullRebuild,
    fullRebuildReason: result.fullRebuildReason,
  };
}

export async function prepareInstalledKlauroIncrementalBaseline(
  projectPath: string,
  options: InstalledKlauroRunOptions & { analysisFocus?: AnalysisFocus } = {},
): Promise<{ result: IncrementalAnalysisResult; durationMs: number }> {
  const startedAt = Date.now();
  const analyzed = await analyzeCasWithInstalledKlauro(projectPath, { ...options, forceFull: true });
  const synchronized = await syncWithInstalledKlauro(projectPath, options);
  return {
    result: {
      ...synchronized,
      output: analyzed.output,
      wasFullRebuild: true,
      fullRebuildReason: analyzed.fullRebuildReason,
    },
    durationMs: Math.max(1, Date.now() - startedAt),
  };
}

function parseInstalledAnalysis(
  result: any,
  projectPath: string,
  operation: 'analyze' | 'sync',
): InstalledKlauroAnalysisResult {
  const output = result?.output ?? result?.cas;
  if (!output?.nodes) {
    throw new Error(`Installed Klauro CLI returned an unexpected ${operation} payload for ${projectPath}`);
  }
  return {
    output,
    changeReport: result?.changeReport ?? result?.change_report,
    wasFullRebuild: Boolean(
      result.wasFullRebuild
      ?? result.was_full_rebuild
      ?? (result.analysis_type === 'full' || result.analysis_type === 'forced')
    ),
    fullRebuildReason: result.fullRebuildReason ?? result.full_rebuild_reason,
  };
}

function runJsonCommand(command: string, args: string[], options: InstalledKlauroRunOptions): Promise<any> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: { ...process.env, ...(options.env || {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    let stdoutTail = '';
    let settled = false;
    const stdoutTap = new Transform({
      transform(chunk, _encoding, callback) {
        stdoutTail = appendTail(stdoutTail, chunk.toString('utf8'));
        callback(null, chunk);
      },
    });
    const decoded = decodeCasExportStream<any>(child.stdout.pipe(stdoutTap), 'identity', {
      bufferedJsonLimitBytes: options.jsonBufferLimitBytes ?? 256 * 1024 * 1024,
    }).then(value => ({ value }), error => ({ error }));
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      action();
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(() => reject(new Error(`Command timed out after ${options.timeoutMs || 120_000}ms: ${command} ${args.join(' ')}\nstdout: ${stdoutTail}\nstderr: ${stderr}`)));
    }, options.timeoutMs || 120_000);

    child.stderr.on('data', chunk => {
      stderr = appendTail(stderr, chunk.toString('utf8'));
    });
    child.on('error', error => {
      clearTimeout(timer);
      finish(() => reject(error));
    });
    child.on('close', async code => {
      clearTimeout(timer);
      const result = await decoded;
      if (code !== 0) {
        finish(() => reject(new Error([
          `Command failed: ${command} ${args.join(' ')}`,
          stdoutTail ? `stdout: ${stdoutTail}` : undefined,
          stderr ? `stderr: ${stderr}` : undefined,
        ].filter(Boolean).join('\n'))));
        return;
      }
      if ('error' in result) {
        finish(() => reject(new Error(`Command did not emit JSON: ${command} ${args.join(' ')}\nstdout: ${stdoutTail}\nstderr: ${stderr}\nerror: ${result.error instanceof Error ? result.error.message : result.error}`)));
        return;
      }
      finish(() => resolve(result.value));
    });
  });
}

function splitCommand(value: string): string[] {
  return value.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)
    ?.map(part => part.replace(/^['"]|['"]$/g, '')) || ['klauro'];
}

function appendTail(current: string, addition: string): string {
  const combined = current + addition;
  return combined.length > 4000 ? combined.slice(-4000) : combined;
}
