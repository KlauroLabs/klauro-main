import { fork } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { withHostedBackgroundPermit } from './hosted-background-queue';
import type { AnalysisExportArtifact } from './storage';
import type { AnalysisTrack } from './track';

const DEFAULT_EXPORT_HEAP_MB = 768;
const DEFAULT_EXPORT_RESERVE_MB = 1024;
const DEFAULT_EXPORT_TIMEOUT_MS = 10 * 60 * 1000;

function workerEntry(): string {
  const candidates = [
    path.join(__dirname, 'analysis-export-worker.cjs'),
    path.join(__dirname, '..', 'dist-hosted', 'analysis-export-worker.cjs'),
    path.join(__dirname, 'analysis-export-worker.ts'),
  ];
  const found = candidates.find(candidate => fs.existsSync(candidate));
  if (!found) throw new Error('Analysis export worker entry is missing; rebuild the hosted bundle.');
  return found;
}

function configuredMb(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function configuredDuration(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function workerExecArgv(entry: string): string[] {
  const args: string[] = [];
  for (let index = 0; index < process.execArgv.length; index += 1) {
    const argument = process.execArgv[index];
    if ((argument === '--import' || argument === '--loader') && process.execArgv[index + 1]?.includes('tsx')) {
      index += 1;
      continue;
    }
    if (argument === '--require' && process.execArgv[index + 1]?.includes('ts-node/register')) {
      index += 1;
      continue;
    }
    if (argument.startsWith('--max-old-space-size=') || argument.startsWith('--max_old_space_size=')) continue;
    args.push(argument);
  }
  if (entry.endsWith('.ts')) args.push('--require', require.resolve(['ts-node', 'register', 'transpile-only'].join('/')));
  return args.concat(`--max-old-space-size=${configuredMb('KLAURO_ANALYSIS_EXPORT_HEAP_MB', DEFAULT_EXPORT_HEAP_MB)}`);
}

async function assertExportMemoryAvailable(): Promise<void> {
  const reserve = configuredMb('KLAURO_ANALYSIS_EXPORT_RESERVE_MB', DEFAULT_EXPORT_RESERVE_MB) * 1024 * 1024;
  try {
    const [currentText, maxText] = await Promise.all([
      fs.promises.readFile('/sys/fs/cgroup/memory.current', 'utf8'),
      fs.promises.readFile('/sys/fs/cgroup/memory.max', 'utf8'),
    ]);
    if (maxText.trim() === 'max') return;
    const available = Number(maxText.trim()) - Number(currentText.trim());
    if (Number.isFinite(available) && available < reserve) {
      throw new Error(`Legacy analysis export requires ${Math.ceil(reserve / 1024 / 1024)} MiB of free container memory; ${Math.max(0, Math.floor(available / 1024 / 1024))} MiB is available.`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Legacy analysis export requires')) throw error;
  }
}

export function runIsolatedAnalysisExport(
  projectPath: string,
  options?: { track?: AnalysisTrack },
): Promise<AnalysisExportArtifact | null> {
  return withHostedBackgroundPermit(async () => {
    await assertExportMemoryAvailable();
    return new Promise((resolve, reject) => {
      const entry = workerEntry();
      const child = fork(entry, [], {
        execArgv: workerExecArgv(entry),
        env: {
          ...process.env,
          ...(entry.endsWith('.ts') ? {
            TS_NODE_PROJECT: process.env.TS_NODE_PROJECT || path.join(__dirname, '..', 'tsconfig.json'),
            TS_NODE_TRANSPILE_ONLY: '1',
          } : {}),
        },
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      });
      const signalWorker = (signal: NodeJS.Signals) => {
        if (process.platform !== 'win32' && child.pid) {
          try { process.kill(-child.pid, signal); } catch { child.kill(signal); }
        } else {
          child.kill(signal);
        }
      };
      let forceTimer: NodeJS.Timeout | undefined;
      const timeout = setTimeout(() => {
        signalWorker('SIGTERM');
        forceTimer = setTimeout(() => signalWorker('SIGKILL'), 5_000);
        forceTimer.unref();
      }, configuredDuration('KLAURO_ANALYSIS_EXPORT_TIMEOUT_MS', DEFAULT_EXPORT_TIMEOUT_MS));
      let settled = false;
      const finish = (error?: Error, artifact?: AnalysisExportArtifact | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (forceTimer) clearTimeout(forceTimer);
        if (child.connected) child.disconnect();
        if (error) reject(error);
        else resolve(artifact ?? null);
      };
      child.on('message', (message: { type?: string; artifact?: AnalysisExportArtifact | null; error?: string }) => {
        if (message?.type === 'result') finish(undefined, message.artifact);
        if (message?.type === 'error') finish(new Error(message.error || 'Legacy analysis export failed.'));
      });
      child.once('error', error => finish(error));
      child.once('exit', (code, signal) => {
        if (!settled) finish(new Error(`Legacy analysis export worker ${signal ? `was killed by ${signal}` : `exited with code ${code}`}.`));
      });
      child.send({ type: 'export', projectPath, track: options?.track });
    });
  }, { releaseForegroundMemory: true });
}
