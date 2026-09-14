import type { CASEdge, CASEntryPoint, CASIndexUnit, CASNode } from '../../types/cas.types';
import { projectRelativeFile } from './project-relative-path';

const CONNECTING_EDGE_TYPES = new Set([
  'calls', 'invokes', 'imports', 'references',
  'has_method', 'extends', 'implements', 'uses', 'contains'
]);

const STRUCTURAL_DIRECTORIES = new Set(['src', 'lib', 'app', 'apps', 'source', 'sources', 'packages']);

function componentOf(nodes: readonly CASNode[], edges: readonly CASEdge[]): {
  componentByNode: Map<string, number>;
  sizeByComponent: Map<number, number>;
} {
  const present = new Set(nodes.map(node => node.id));
  const adjacency = new Map<string, string[]>();
  const link = (from: string, to: string): void => {
    const bucket = adjacency.get(from);
    if (bucket) bucket.push(to);
    else adjacency.set(from, [to]);
  };
  for (const edge of edges) {
    if (!CONNECTING_EDGE_TYPES.has(String(edge.type))) continue;
    if (!present.has(edge.source) || !present.has(edge.target)) continue;
    link(edge.source, edge.target);
    link(edge.target, edge.source);
  }

  const componentByNode = new Map<string, number>();
  const sizeByComponent = new Map<number, number>();
  let nextComponent = 0;
  for (const start of adjacency.keys()) {
    if (componentByNode.has(start)) continue;
    const component = nextComponent++;
    const stack = [start];
    componentByNode.set(start, component);
    let size = 0;
    while (stack.length > 0) {
      const current = stack.pop()!;
      size += 1;
      for (const neighbour of adjacency.get(current) || []) {
        if (componentByNode.has(neighbour)) continue;
        componentByNode.set(neighbour, component);
        stack.push(neighbour);
      }
    }
    sizeByComponent.set(component, size);
  }
  return { componentByNode, sizeByComponent };
}

function areaOf(file: string): string {
  const segments = file.split('/').filter(Boolean);
  if (segments.length === 0) return '';
  if (segments.length > 1 && STRUCTURAL_DIRECTORIES.has(segments[0])) {
    return segments[0] === 'apps' || segments[0] === 'packages' ? segments.slice(0, 2).join('/') : segments[0];
  }
  return segments[0].includes('.') && segments.length === 1 ? segments[0] : segments[0];
}

function unitName(areas: Map<string, number>, fallback: string): string {
  let best = '';
  let bestCount = -1;
  for (const [area, count] of [...areas.entries()].sort((left, right) => left[0].localeCompare(right[0]))) {
    if (count > bestCount) {
      best = area;
      bestCount = count;
    }
  }
  return best || fallback;
}

export function deriveIndexUnits(
  nodes: readonly CASNode[],
  edges: readonly CASEdge[],
  entryPoints: readonly CASEntryPoint[],
  projectPath: string
): CASIndexUnit[] {
  if (entryPoints.length === 0) return [];
  const { componentByNode, sizeByComponent } = componentOf(nodes, edges);
  const fileByNode = new Map<string, string>();
  for (const node of nodes) {
    const file = node.source?.file;
    if (file) fileByNode.set(node.id, file);
  }

  const grouped = new Map<number, CASEntryPoint[]>();
  const order: number[] = [];
  for (const entryPoint of entryPoints) {
    const nodeId = entryPoint.handler?.node_id || entryPoint.source_node;
    const component = nodeId ? componentByNode.get(nodeId) : undefined;
    if (component === undefined) continue;
    const bucket = grouped.get(component);
    if (bucket) bucket.push(entryPoint);
    else {
      grouped.set(component, [entryPoint]);
      order.push(component);
    }
  }

  const units: CASIndexUnit[] = [];
  const usedIds = new Map<string, number>();
  for (const component of order) {
    const members = grouped.get(component)!;
    const kinds = new Map<string, number>();
    const areas = new Map<string, number>();
    const roots = new Set<string>();
    for (const entryPoint of members) {
      kinds.set(entryPoint.type, (kinds.get(entryPoint.type) || 0) + 1);
      const nodeId = entryPoint.handler?.node_id || entryPoint.source_node;
      const file = entryPoint.handler?.file || (nodeId ? fileByNode.get(nodeId) : undefined);
      if (!file) continue;
      const area = areaOf(projectRelativeFile(projectPath, file));
      if (!area) continue;
      areas.set(area, (areas.get(area) || 0) + 1);
      roots.add(area);
    }
    const name = unitName(areas, `unit ${component}`);
    const base = `unit_${name.replace(/[^A-Za-z0-9]+/g, '_')}`;
    const taken = usedIds.get(base) || 0;
    usedIds.set(base, taken + 1);
    units.push({
      id: taken === 0 ? base : `${base}_${taken + 1}`,
      name,
      reached_nodes: sizeByComponent.get(component) || 0,
      entry_point_ids: members.map(entryPoint => entryPoint.id).sort(),
      entry_point_kinds: Object.fromEntries([...kinds.entries()].sort()),
      root_paths: [...roots].sort()
    });
  }
  return units.sort((left, right) =>
    right.reached_nodes - left.reached_nodes || left.id.localeCompare(right.id));
}
