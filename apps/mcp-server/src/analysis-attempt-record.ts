import * as fs from 'fs-extra';
import * as path from 'node:path';
import { writeJsonAtomic } from './json-storage-writer';

export type AnalysisAttemptState = 'in-progress' | 'succeeded' | 'failed';

export interface AnalysisAttemptRecord {
  state: AnalysisAttemptState;
  trigger: 'reanalyze' | 'sync' | 'analyze';
  analysis_revision?: number;
  queued_at?: string;
  queue_position?: number;
  estimated_wait_ms?: number;
  started_at?: string;
  finished_at?: string;
  duration_ms?: number;
  reason?: string;
  heartbeat_at?: string;
  stored_version?: string;
  current_version?: string;
}

export function projectAttemptRecordPath(workspace: string): string {
  return path.join(workspace, '.reanalyze-attempt.json');
}

export async function writeAttemptRecord(filePath: string, record: AnalysisAttemptRecord): Promise<void> {
  try {
    await writeJsonAtomic(filePath, record);
  } catch {
  }
}

export async function readAttemptRecord(filePath: string): Promise<AnalysisAttemptRecord | null> {
  try {
    if (!(await fs.pathExists(filePath))) return null;
    return await fs.readJson(filePath);
  } catch {
    return null;
  }
}
