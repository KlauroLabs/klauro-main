import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

import { getStoreDir, withWorkspaceLock } from './local-store';
import { getFabricDeliveryMetrics, type FabricDeliveryMetrics } from './fabric-delivery-metrics';

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
  delivery: FabricDeliveryMetrics;
}

interface MergelessRollup {
  kind?: 'rollup';
  observation_count: number;
  participant_observations: number;
  changed_symbol_observations: number;
  merge_decisions_required: number;
  surprises: number;
  unattributed_changes: number;
  latest_observed_at?: string;
}

const COMPACT_AFTER_BYTES = 2 * 1024 * 1024;
const RETAINED_OBSERVATIONS = 2_000;

function metricsPath(workspace: string): string {
  return path.join(getStoreDir(workspace), 'mergeless-metrics.jsonl');
}

function parseStore(body: string, workspace: string): { rollup: MergelessRollup; observations: MergelessObservation[] } {
  let rollup = emptyRollup();
  const observations: MergelessObservation[] = [];
  for (const line of body.split('\n')) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as MergelessObservation | MergelessRollup;
      if ('kind' in value && value.kind === 'rollup') {
        rollup = { ...emptyRollup(), ...value };
        continue;
      }
      const observation = value as MergelessObservation;
      if (observation.workspace !== workspace || !observation.observed_at) continue;
      observations.push(observation);
    } catch {}
  }
  return { rollup, observations };
}

async function readStore(workspace: string): Promise<{ rollup: MergelessRollup; observations: MergelessObservation[] }> {
  try {
    return parseStore(await fsp.readFile(metricsPath(workspace), 'utf8'), workspace);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { rollup: emptyRollup(), observations: [] };
    throw error;
  }
}

function emptyRollup(): MergelessRollup {
  return {
    observation_count: 0,
    participant_observations: 0,
    changed_symbol_observations: 0,
    merge_decisions_required: 0,
    surprises: 0,
    unattributed_changes: 0,
  };
}

function addObservations(rollup: MergelessRollup, observations: MergelessObservation[]): MergelessRollup {
  return observations.reduce((result, observation) => ({
    observation_count: result.observation_count + 1,
    participant_observations: result.participant_observations + observation.participant_count,
    changed_symbol_observations: result.changed_symbol_observations + observation.changed_symbol_count,
    merge_decisions_required: result.merge_decisions_required + observation.merge_decisions_required,
    surprises: result.surprises + observation.surprise_count,
    unattributed_changes: result.unattributed_changes + observation.unattributed_count,
    latest_observed_at: observation.observed_at,
  }), rollup);
}

async function writeAtomic(target: string, body: string): Promise<void> {
  const replacement = `${target}.compact-${process.pid}-${Date.now()}`;
  const handle = await fsp.open(replacement, 'wx');
  try {
    await handle.writeFile(body, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsp.rename(replacement, target);
  const directory = await fsp.open(path.dirname(target), 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

export async function recordMergelessObservation(observation: MergelessObservation): Promise<void> {
  await withWorkspaceLock(observation.workspace, async () => {
    const file = metricsPath(observation.workspace);
    const handle = await fsp.open(file, 'a');
    try {
      await handle.writeFile(`${JSON.stringify(observation)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    if ((await fsp.stat(file)).size <= COMPACT_AFTER_BYTES) return;
    const store = await readStore(observation.workspace);
    const observations = store.observations;
    const retained = observations.slice(-RETAINED_OBSERVATIONS);
    const archived = observations.slice(0, -RETAINED_OBSERVATIONS);
    const rollup = { ...addObservations(store.rollup, archived), kind: 'rollup' as const };
    await writeAtomic(file, [rollup, ...retained].map((entry) => JSON.stringify(entry)).join('\n') + '\n');
  });
}

export async function getMergelessMetrics(workspace: string): Promise<MergelessMetrics> {
  const [store, delivery] = await Promise.all([
    readStore(workspace),
    getFabricDeliveryMetrics(workspace),
  ]);
  const totals = addObservations(store.rollup, store.observations);
  const publicTotals = { ...totals };
  delete publicTotals.kind;
  const denominator = Math.max(1, totals.changed_symbol_observations);
  return {
    workspace,
    ...publicTotals,
    merge_decision_rate: totals.merge_decisions_required / denominator,
    surprise_rate: totals.surprises / denominator,
    delivery,
  };
}
