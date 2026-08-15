import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

import type { SymbolChange } from './conceptual-conflict';
import { getStoreDir, withWorkspaceLock } from './local-store';

export type InFlightAttributionSource = 'participant-worktree' | 'participant-write-events' | 'workspace-tree';

export interface ParticipantInFlightSnapshot {
  workspace: string;
  agent_id: string;
  org_id?: string;
  base_commit: string;
  branch?: string;
  diff_context: string;
  updated_at: string;
  attribution_source: InFlightAttributionSource;
  changes?: SymbolChange[];
}

export interface ReadParticipantInFlightOptions {
  nowMs?: number;
  maxAgeMs?: number;
  attributableOnly?: boolean;
}

const DEFAULT_MAX_AGE_MS = 10 * 60 * 1000;
const COMPACT_AFTER_BYTES = 4 * 1024 * 1024;

function logPath(workspaceId: string): string {
  return path.join(getStoreDir(workspaceId), 'in-flight.jsonl');
}

function parseSnapshots(body: string, workspaceId: string): ParticipantInFlightSnapshot[] {
  const snapshots: ParticipantInFlightSnapshot[] = [];
  for (const line of body.split('\n')) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as ParticipantInFlightSnapshot;
      if (value.workspace !== workspaceId || !value.agent_id || !value.updated_at) continue;
      if (!Array.isArray(value.changes) && value.changes !== undefined) continue;
      snapshots.push({ ...value, attribution_source: value.attribution_source ?? 'workspace-tree' });
    } catch {}
  }
  return snapshots;
}

async function readAll(workspaceId: string): Promise<ParticipantInFlightSnapshot[]> {
  try {
    return parseSnapshots(await fsp.readFile(logPath(workspaceId), 'utf8'), workspaceId);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

function latestByAgent(snapshots: ParticipantInFlightSnapshot[]): ParticipantInFlightSnapshot[] {
  const latest = new Map<string, ParticipantInFlightSnapshot>();
  for (const snapshot of snapshots) {
    const current = latest.get(snapshot.agent_id);
    if (!current || Date.parse(snapshot.updated_at) >= Date.parse(current.updated_at)) {
      latest.set(snapshot.agent_id, snapshot);
    }
  }
  return [...latest.values()].sort((a, b) => a.agent_id.localeCompare(b.agent_id));
}

export async function appendParticipantInFlightSnapshot(
  workspaceId: string,
  snapshot: ParticipantInFlightSnapshot
): Promise<void> {
  if (snapshot.workspace !== workspaceId) throw new Error('Snapshot workspace does not match the target workspace');
  await withWorkspaceLock(workspaceId, async () => {
    const file = logPath(workspaceId);
    await fsp.appendFile(file, `${JSON.stringify(snapshot)}\n`, 'utf8');
    const stat = await fsp.stat(file);
    if (stat.size <= COMPACT_AFTER_BYTES) return;
    const compacted = latestByAgent(await readAll(workspaceId));
    const replacement = `${file}.compact-${process.pid}-${Date.now()}`;
    await fsp.writeFile(replacement, compacted.map((entry) => JSON.stringify(entry)).join('\n') + '\n', 'utf8');
    await fsp.rename(replacement, file);
  });
}

export async function readParticipantInFlightSnapshots(
  workspaceId: string,
  options: ReadParticipantInFlightOptions = {}
): Promise<ParticipantInFlightSnapshot[]> {
  const nowMs = options.nowMs ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  return latestByAgent(await readAll(workspaceId)).filter((snapshot) => {
    const updatedAt = Date.parse(snapshot.updated_at);
    if (!Number.isFinite(updatedAt) || nowMs - updatedAt > maxAgeMs) return false;
    if (options.attributableOnly && snapshot.attribution_source === 'workspace-tree') return false;
    return true;
  });
}
