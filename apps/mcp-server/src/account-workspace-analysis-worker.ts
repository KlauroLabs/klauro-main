import { AccountStore } from './account-store';
import { AccountWorkspaceAnalysisScheduler } from './account-workspace-analysis';
import type { WorkspaceAnalysisWorkerRequest } from './account-workspace-analysis-process';

if (!process.send) {
  process.stderr.write('account-workspace-analysis-worker must be started through child_process.fork.\n');
  process.exit(1);
}

function applyEnvSnapshot(snapshot: Record<string, string>): void {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('KLAURO_') && !(key in snapshot)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(snapshot)) process.env[key] = value;
}

process.once('message', async (request: WorkspaceAnalysisWorkerRequest) => {
  if (!request || request.type !== 'rebuild') return;
  applyEnvSnapshot(request.env);
  const scheduler = new AccountWorkspaceAnalysisScheduler(request.dataDir, new AccountStore(request.dataDir));
  try {
    await scheduler.rebuild(request.workspaceId, { force: request.force });
    process.send!({ type: 'result' });
  } catch (error) {
    process.send!({ type: 'error', error: error instanceof Error ? error.message : String(error) });
  } finally {
    scheduler.close();
  }
});
