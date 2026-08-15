







































import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';

import { analyzeForBench } from './product-analysis';
import { partitionTasks } from '../coordination/partitioner';
import type { PartitionCas, PartitionTask } from '../coordination/partitioner';

const FIXTURE_SOURCE = `
export interface User { id: string; name: string; }

export function getUser(id: string): User | null {
  return id ? { id, name: 'demo' } : null;
}

export function renderProfile(id: string): string {
  const user = getUser(id);
  if (!user) return 'no user';
  return user.name;
}

export function renderSettings(id: string): string {
  const user = getUser(id);
  return user ? user.name + ' settings' : 'guest settings';
}

export function billingHandler(amountCents: number): number {
  return amountCents * 100;
}

export function formatCurrency(cents: number): string {
  return '$' + (cents / 100).toFixed(2);
}

export function unrelatedUtilOne(): string {
  return 'one';
}

export function unrelatedUtilTwo(): string {
  return 'two';
}

export function unrelatedUtilThree(): string {
  return 'three';
}
`;

async function buildFixture(): Promise<string> {
  const dir = path.join(os.tmpdir(), `klauro-throughput-bench-${process.pid}-${Date.now()}`);
  await fs.mkdirp(dir);
  await fs.writeFile(path.join(dir, 'app.ts'), FIXTURE_SOURCE, 'utf8');
  return dir;
}

function idFor(cas: PartitionCas, name: string): string {
  const node = cas.nodes.find((n) => n.name === name);
  if (!node) throw new Error(`fixture CAS missing expected node: ${name}`);
  return node.id;
}

export interface ScenarioMeasurement {
  scenario: string;
  task_count: number;
  serial_wall_clock_units: number;
  partitioned_batch_count: number;
  partitioned_wall_clock_units: number;
  parallelism_factor: number;
  conflict_edge_count: number;
}

export interface ThroughputBenchReport {
  mixed: ScenarioMeasurement;
  blast_radius_proof: {
    without_blast_radius_batches: number;
    with_blast_radius_batches: number;
    separated_correctly: boolean;
  };
  disjoint_control: ScenarioMeasurement;
  summary: string;
}

function measure(scenario: string, tasks: PartitionTask[], cas: PartitionCas): ScenarioMeasurement {
  const result = partitionTasks(tasks, cas);
  return {
    scenario,
    task_count: tasks.length,
    serial_wall_clock_units: tasks.length,
    partitioned_batch_count: result.batches.length,
    partitioned_wall_clock_units: result.batches.length,
    parallelism_factor: result.parallelism_factor,
    conflict_edge_count: result.conflict_edges.length,
  };
}

export async function runThroughputBench(): Promise<ThroughputBenchReport> {
  const fixtureDir = await buildFixture();
  let cas: PartitionCas;
  try {
    const realCas = await analyzeForBench(fixtureDir);
    cas = { nodes: realCas.nodes.map((n) => ({ id: n.id, name: n.name })), edges: realCas.edges as any };
  } finally {
    await fs.remove(fixtureDir).catch(() => {});
  }








  const mixedTasks: PartitionTask[] = [
    { id: 't1-retype-getUser', intent: 'retype getUser to non-null', target_symbols: [idFor(cas, 'getUser')] },
    { id: 't2-add-logging-getUser', intent: 'add logging inside getUser', target_symbols: [idFor(cas, 'getUser')] },
    { id: 't3-edit-renderProfile', intent: 'add avatar to renderProfile', target_symbols: [idFor(cas, 'renderProfile')] },
    { id: 't4-edit-renderSettings', intent: 'add theme toggle to renderSettings', target_symbols: [idFor(cas, 'renderSettings')] },
    { id: 't5-billing', intent: 'add currency rounding to billingHandler', target_symbols: [idFor(cas, 'billingHandler')] },
    { id: 't6-format', intent: 'add locale support to formatCurrency', target_symbols: [idFor(cas, 'formatCurrency')] },
    { id: 't7-util-one', intent: 'refactor unrelatedUtilOne', target_symbols: [idFor(cas, 'unrelatedUtilOne')] },
    { id: 't8-util-two', intent: 'refactor unrelatedUtilTwo', target_symbols: [idFor(cas, 'unrelatedUtilTwo')] },
  ];
  const mixed = measure('mixed conflicting + disjoint task set', mixedTasks, cas);







  const blastPair: PartitionTask[] = [
    { id: 't-a-getUser', intent: 'retype getUser to non-null', target_symbols: [idFor(cas, 'getUser')] },
    { id: 't-b-renderProfile', intent: 'add avatar rendering to renderProfile', target_symbols: [idFor(cas, 'renderProfile')] },
  ];
  const withoutBlastRadius = partitionTasks(blastPair, cas, { includeBlastRadius: false });
  const withBlastRadius = partitionTasks(blastPair, cas, { includeBlastRadius: true });
  const blastRadiusProof = {
    without_blast_radius_batches: withoutBlastRadius.batches.length,
    with_blast_radius_batches: withBlastRadius.batches.length,
    separated_correctly: withoutBlastRadius.batches.length === 1 && withBlastRadius.batches.length === 2,
  };




  const disjointTasks: PartitionTask[] = [
    { id: 'd1', intent: 'edit unrelatedUtilOne', target_symbols: [idFor(cas, 'unrelatedUtilOne')] },
    { id: 'd2', intent: 'edit unrelatedUtilTwo', target_symbols: [idFor(cas, 'unrelatedUtilTwo')] },
    { id: 'd3', intent: 'edit unrelatedUtilThree', target_symbols: [idFor(cas, 'unrelatedUtilThree')] },
    { id: 'd4', intent: 'edit formatCurrency', target_symbols: [idFor(cas, 'formatCurrency')] },
  ];
  const disjointControl = measure('fully-disjoint control', disjointTasks, cas);

  const summary =
    `mixed: ${mixed.task_count} tasks -> ${mixed.partitioned_batch_count} batches ` +
    `(parallelism_factor ${mixed.parallelism_factor.toFixed(2)}, serial would take ${mixed.serial_wall_clock_units} units, ` +
    `partitioned takes ${mixed.partitioned_wall_clock_units} units). ` +
    `blast-radius proof: ${blastRadiusProof.without_blast_radius_batches} batch(es) without expansion vs ` +
    `${blastRadiusProof.with_blast_radius_batches} with (separated_correctly=${blastRadiusProof.separated_correctly}). ` +
    `disjoint control: ${disjointControl.task_count} tasks -> ${disjointControl.partitioned_batch_count} batch ` +
    `(parallelism_factor ${disjointControl.parallelism_factor.toFixed(2)}).`;

  return { mixed, blast_radius_proof: blastRadiusProof, disjoint_control: disjointControl, summary };
}

if (require.main === module) {
  runThroughputBench()
    .then((report) => {

      console.log(JSON.stringify(report, null, 2));
      console.log(report.summary);
    })
    .catch((err) => {

      console.error(err);
      process.exitCode = 1;
    });
}
