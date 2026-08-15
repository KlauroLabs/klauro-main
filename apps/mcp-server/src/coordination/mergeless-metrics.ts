import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

import { getStoreDir, withWorkspaceLock } from './local-store';

export interface MergelessObservation {
  workspace: string;
  observed_at: string;
  attribution_source: string;
  participant_count: number;
  changed_symbol_count: number;
  merge_decisions_required: number;
  surprise_count: number;
  unattributed_count: number;
}

export interface MergelessMetrics {
  workspace: string;
  observation_count: number;
  participant_observations: number;
  changed_symbol_observations: number;
  merge_decisions_required: number;
  surprises: number;
  unattributed_changes: number;
  merge_decision_rate: number;
  surprise_rate: number;
  latest_observed_at?: string;
}

const COMPACT_AFTER_BYTES = 2 * 1024 * 1024;
const RETAINED_OBSERVATIONS = 2_000;

function metricsPath(workspace: string): string {
  return path.join(getStoreDir(workspace), 'mergeless-metrics.jsonl');
}

function parseObservations(body: string, workspace: string): MergelessObservation[] {
  const observations: MergelessObservation[] = [];
  for (const line of body.split('\n')) {
    if (!line.trim()) continue;
    try {
      const observation = JSON.parse(line) as MergelessObservation;
      if (observation.workspace !== workspace || !observation.observed_at) continue;
      observations.push(observation);
    } catch {}
  }
  return observations;
}

async function readAll(workspace: string): Promise<MergelessObservation[]> {
  try {
    return parseObservations(await fsp.readFile(metricsPath(workspace), 'utf8'), workspace);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

export async function recordMergelessObservation(observation: MergelessObservation): Promise<void> {
  await withWorkspaceLock(observation.workspace, async () => {
    const file = metricsPath(observation.workspace);
    await fsp.appendFile(file, `${JSON.stringify(observation)}\n`, 'utf8');
    if ((await fsp.stat(file)).size <= COMPACT_AFTER_BYTES) return;
    const retained = (await readAll(observation.workspace)).slice(-RETAINED_OBSERVATIONS);
    const replacement = `${file}.compact-${process.pid}-${Date.now()}`;
    await fsp.writeFile(replacement, retained.map((entry) => JSON.stringify(entry)).join('\n') + '\n', 'utf8');
    await fsp.rename(replacement, file);
  });
}

export async function getMergelessMetrics(workspace: string): Promise<MergelessMetrics> {
  const observations = await readAll(workspace);
  const totals = observations.reduce((result, observation) => ({
    participant_observations: result.participant_observations + observation.participant_count,
    changed_symbol_observations: result.changed_symbol_observations + observation.changed_symbol_count,
    merge_decisions_required: result.merge_decisions_required + observation.merge_decisions_required,
    surprises: result.surprises + observation.surprise_count,
    unattributed_changes: result.unattributed_changes + observation.unattributed_count,
  }), {
    participant_observations: 0,
    changed_symbol_observations: 0,
    merge_decisions_required: 0,
    surprises: 0,
    unattributed_changes: 0,
  });
  const denominator = Math.max(1, totals.changed_symbol_observations);
  return {
    workspace,
    observation_count: observations.length,
    ...totals,
    merge_decision_rate: totals.merge_decisions_required / denominator,
    surprise_rate: totals.surprises / denominator,
    latest_observed_at: observations.at(-1)?.observed_at,
  };
}
