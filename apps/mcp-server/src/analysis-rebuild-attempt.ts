import * as nodeFs from 'fs';
import * as fs from 'fs-extra';
import * as path from 'path';

import { writeJsonAtomic } from './storage';

export class AnalysisLoopBreakerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnalysisLoopBreakerError';
  }
}

export interface RebuildAttempt {
  state: 'in-progress' | 'succeeded' | 'failed';
  trigger: 'version-rebuild';
  started_at: string;
  finished_at?: string;
  duration_ms?: number;
  reason?: string;
  stored_version?: string;
  current_version?: string;
}

export function rebuildAttemptPath(projectPath: string): string {
  return path.join(projectPath, '.reanalyze-attempt.json');
}

export async function readRebuildAttempt(projectPath: string): Promise<RebuildAttempt | null> {
  try {
    if (!nodeFs.existsSync(rebuildAttemptPath(projectPath))) return null;
    return await fs.readJson(rebuildAttemptPath(projectPath));
  } catch {
    return null;
  }
}

export async function writeRebuildAttempt(projectPath: string, attempt: RebuildAttempt): Promise<void> {
  try {
    await writeJsonAtomic(rebuildAttemptPath(projectPath), attempt);
  } catch {
    return;
  }
}

export async function recordingRebuild<T>(
  projectPath: string,
  version: { stored_version?: string; current_version: string },
  rebuild: () => Promise<T>,
): Promise<T> {
  const startedAt = new Date();
  const shared = {
    trigger: 'version-rebuild' as const,
    started_at: startedAt.toISOString(),
    stored_version: version.stored_version,
    current_version: version.current_version,
  };
  await writeRebuildAttempt(projectPath, {
    ...shared,
    state: 'in-progress',
    reason: `stored cas_version ${version.stored_version} differs from the running server's cas_version ${version.current_version}`,
  });
  const finished = () => ({
    finished_at: new Date().toISOString(),
    duration_ms: Date.now() - startedAt.getTime(),
  });
  try {
    const built = await rebuild();
    await writeRebuildAttempt(projectPath, { ...shared, ...finished(), state: 'succeeded' });
    return built;
  } catch (error) {
    await writeRebuildAttempt(projectPath, {
      ...shared,
      ...finished(),
      state: 'failed',
      reason: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
