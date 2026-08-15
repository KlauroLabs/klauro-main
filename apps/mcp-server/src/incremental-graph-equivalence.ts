import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';

export interface CasGraphEquivalence {
  node_delta: number;
  edge_delta: number;
  entry_point_delta: number;
  exit_point_delta: number;
  absolute_delta: number;
  count_similarity: number;
  graph_equivalent: boolean;
  graph_difference_count: number;
  graph_difference_sample: string[];
}

export interface CasGraphFingerprint {
  nodes: Map<string, string>;
  edges: Map<string, string>;
  entryPoints: Map<string, string>;
  exitPoints: Map<string, string>;
}

export function captureCasGraphFingerprint(output: CASOutput): CasGraphFingerprint {
  return {
    nodes: fingerprintSection(output.nodes),
    edges: fingerprintSection(output.edges),
    entryPoints: fingerprintSection(output.entry_points || []),
    exitPoints: fingerprintSection(output.exit_points || []),
  };
}

export function compareCasGraphFingerprint(fingerprint: CasGraphFingerprint, full: CASOutput): CasGraphEquivalence {
  const nodeDelta = Math.abs(fingerprint.nodes.size - full.nodes.length);
  const edgeDelta = Math.abs(fingerprint.edges.size - full.edges.length);
  const entryPointDelta = Math.abs(fingerprint.entryPoints.size - (full.entry_points?.length || 0));
  const exitPointDelta = Math.abs(fingerprint.exitPoints.size - (full.exit_points?.length || 0));
  const baseline = Math.max(1, full.nodes.length + full.edges.length + (full.entry_points?.length || 0) + (full.exit_points?.length || 0));
  const delta = nodeDelta + edgeDelta + entryPointDelta + exitPointDelta;
  const differencesBySection = [
    fingerprintDifferences('node', fingerprint.nodes, full.nodes),
    fingerprintDifferences('edge', fingerprint.edges, full.edges),
    fingerprintDifferences('entry-point', fingerprint.entryPoints, full.entry_points || []),
    fingerprintDifferences('exit-point', fingerprint.exitPoints, full.exit_points || []),
  ];
  const differenceCount = differencesBySection.reduce((total, section) => total + section.count, 0);
  return {
    node_delta: nodeDelta,
    edge_delta: edgeDelta,
    entry_point_delta: entryPointDelta,
    exit_point_delta: exitPointDelta,
    absolute_delta: delta,
    count_similarity: Number(Math.max(0, 1 - delta / baseline).toFixed(4)),
    graph_equivalent: differenceCount === 0,
    graph_difference_count: differenceCount,
    graph_difference_sample: differencesBySection.flatMap(section => section.sample),
  };
}

export function compareCasGraphs(incremental: CASOutput, full: CASOutput): CasGraphEquivalence {
  const nodeDelta = Math.abs(incremental.nodes.length - full.nodes.length);
  const edgeDelta = Math.abs(incremental.edges.length - full.edges.length);
  const entryPointDelta = Math.abs((incremental.entry_points?.length || 0) - (full.entry_points?.length || 0));
  const exitPointDelta = Math.abs((incremental.exit_points?.length || 0) - (full.exit_points?.length || 0));
  const baseline = Math.max(1, full.nodes.length + full.edges.length + (full.entry_points?.length || 0) + (full.exit_points?.length || 0));
  const delta = nodeDelta + edgeDelta + entryPointDelta + exitPointDelta;
  const differencesBySection = [
    sectionDifferences('node', incremental.nodes, full.nodes),
    sectionDifferences('edge', incremental.edges, full.edges),
    sectionDifferences('entry-point', incremental.entry_points || [], full.entry_points || []),
    sectionDifferences('exit-point', incremental.exit_points || [], full.exit_points || []),
  ];
  const graphDifferences = differencesBySection.flat();
  return {
    node_delta: nodeDelta,
    edge_delta: edgeDelta,
    entry_point_delta: entryPointDelta,
    exit_point_delta: exitPointDelta,
    absolute_delta: delta,
    count_similarity: Number(Math.max(0, 1 - delta / baseline).toFixed(4)),
    graph_equivalent: graphDifferences.length === 0,
    graph_difference_count: graphDifferences.length,
    graph_difference_sample: differencesBySection.flatMap(differences => differences.slice(0, 4)),
  };
}

export function graphEquivalenceRate(reports: Array<{ full_verify_parity?: CasGraphEquivalence }>): number {
  return reports.length === 0 ? 0 : Number((reports.filter(target => target.full_verify_parity?.graph_equivalent).length / reports.length).toFixed(4));
}

function sectionDifferences<T extends { id: string }>(section: string, incremental: T[], full: T[]): string[] {
  const incrementalById = new Map(incremental.map(item => [item.id, item]));
  const fullById = new Map(full.map(item => [item.id, item]));
  const differences: string[] = [];
  for (const id of new Set([...incrementalById.keys(), ...fullById.keys()])) {
    const incrementalItem = incrementalById.get(id);
    const fullItem = fullById.get(id);
    if (jsonEquivalent(incrementalItem, fullItem)) continue;
    if (!incrementalItem || !fullItem) {
      differences.push(`${section}:${id}[${incrementalItem ? 'missing-from-cold' : 'missing-from-incremental'}]`);
      continue;
    }
    differences.push(`${section}:${id}[${changedJsonPaths(incrementalItem, fullItem).slice(0, 8).join(',')}]`);
  }
  return differences;
}

function fingerprintSection<T extends { id: string }>(items: T[]): Map<string, string> {
  return new Map(items.map(item => [item.id, jsonFingerprint(item)]));
}

function fingerprintDifferences<T extends { id: string }>(
  section: string,
  expected: ReadonlyMap<string, string>,
  actual: T[],
): { count: number; sample: string[] } {
  const seen = new Set<string>();
  const sample: string[] = [];
  let count = 0;
  for (const item of actual) {
    seen.add(item.id);
    const expectedHash = expected.get(item.id);
    if (expectedHash === jsonFingerprint(item)) continue;
    count++;
    if (sample.length < 4) sample.push(`${section}:${item.id}[${expectedHash ? 'content-changed' : 'missing-from-incremental'}]`);
  }
  for (const id of expected.keys()) {
    if (seen.has(id)) continue;
    count++;
    if (sample.length < 4) sample.push(`${section}:${id}[missing-from-cold]`);
  }
  return { count, sample };
}

function jsonFingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalJsonValue(value))).digest('base64url');
}

function jsonEquivalent(left: unknown, right: unknown): boolean {
  return isDeepStrictEqual(canonicalJsonValue(left), canonicalJsonValue(right));
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalJsonValue(child)])
  );
}

function changedJsonPaths(left: unknown, right: unknown, prefix = ''): string[] {
  if (jsonEquivalent(left, right)) return [];
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object' || Array.isArray(left) || Array.isArray(right)) {
    return [prefix || 'value'];
  }
  const leftObject = left as Record<string, unknown>;
  const rightObject = right as Record<string, unknown>;
  const keys = new Set([...Object.keys(leftObject), ...Object.keys(rightObject)]);
  return [...keys].flatMap(key => changedJsonPaths(leftObject[key], rightObject[key], prefix ? `${prefix}.${key}` : key));
}
