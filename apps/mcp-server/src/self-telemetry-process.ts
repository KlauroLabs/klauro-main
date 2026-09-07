import { fork, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { workerExecArgvForEntry } from './worker-exec-argv';
import type { TelemetryEvent } from './telemetry-ingestion';
import { withHostedBackgroundPermit } from './hosted-background-queue';

interface SelfTelemetryWorkerRequest {
  type: 'persist';
  batches: Array<{ projectPath: string; events: TelemetryEvent[] }>;
  canonicalProjectPath?: string;
  env: Record<string, string>;
}

interface SelfTelemetryWorkerResponse {
  type: 'result' | 'error';
  error?: string;
}

function resolveWorkerEntryPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.KLAURO_SELF_TELEMETRY_WORKER_ENTRY?.trim();
  if (override) return path.resolve(override);
  for (const candidate of ['self-telemetry-worker.cjs', 'self-telemetry-worker.ts']) {
    const candidatePath = path.join(__dirname, candidate);
    if (fs.existsSync(candidatePath)) return candidatePath;
  }
  throw new Error(`Self-telemetry worker entry not found next to ${__dirname}; rebuild the hosted bundle.`);
}


function klauroEnvSnapshot(): Record<string, string> {
  const snapshot: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('KLAURO_') && value !== undefined) snapshot[key] = value;
  }
  return snapshot;
}

function terminate(child: ChildProcess): void {
  if (child.connected) child.disconnect();
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
}

export async function persistSelfTelemetryInWorker(
  batches: Array<{ projectPath: string; events: TelemetryEvent[] }>,
  canonicalProjectPath?: string,
): Promise<void> {
  if (batches.length === 0) return;
  return withHostedBackgroundPermit(async () => {
    const configuredHeap = Number(process.env.KLAURO_SELF_TELEMETRY_HEAP_MB);
    const heapMb = Number.isFinite(configuredHeap) && configuredHeap >= 128 ? Math.floor(configuredHeap) : 256;
    const entry = resolveWorkerEntryPath();
    const child = fork(entry, [], {
      execArgv: [...workerExecArgvForEntry(process.execArgv, entry), `--max-old-space-size=${heapMb}`],
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      env: process.env,
    });
    const request: SelfTelemetryWorkerRequest = {
      type: 'persist',
      batches,
      canonicalProjectPath,
      env: klauroEnvSnapshot(),
    };
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        terminate(child);
        if (error) reject(error);
        else resolve();
      };
      child.once('message', (message: SelfTelemetryWorkerResponse) => {
        if (message?.type === 'result') finish();
        else finish(new Error(message?.error || 'Self-telemetry worker failed.'));
      });
      child.once('error', error => finish(error));
      child.once('exit', (code, signal) => {
        if (!settled) finish(new Error(
          `Self-telemetry worker ${signal ? `was killed by ${signal}` : `exited with code ${code}`}.`,
        ));
      });
      child.send(request, error => {
        if (error) finish(new Error(`Failed to dispatch self-telemetry persistence: ${error.message}`));
      });
    });
  });
}

export type { SelfTelemetryWorkerRequest };
