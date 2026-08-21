import { ingestTelemetryBatch } from './telemetry-ingestion';
import type { SelfTelemetryWorkerRequest } from './self-telemetry-process';

if (!process.send) {
  process.stderr.write('self-telemetry-worker must be started through child_process.fork.\n');
  process.exit(1);
}

function applyEnvSnapshot(snapshot: Record<string, string>): void {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('KLAURO_') && !(key in snapshot)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(snapshot)) process.env[key] = value;
}

process.once('message', async (request: SelfTelemetryWorkerRequest) => {
  if (!request || request.type !== 'persist') return;
  applyEnvSnapshot(request.env);
  try {
    for (const batch of request.batches) {
      await ingestTelemetryBatch(null, batch.projectPath, batch.events, { persist: true });
      if (request.canonicalProjectPath && request.canonicalProjectPath !== batch.projectPath) {
        await ingestTelemetryBatch(null, request.canonicalProjectPath, batch.events, { persist: true });
      }
    }
    process.send!({ type: 'result' });
  } catch (error) {
    process.send!({ type: 'error', error: error instanceof Error ? error.message : String(error) });
  }
});
