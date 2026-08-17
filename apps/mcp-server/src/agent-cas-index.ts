import type { CASNode, CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';

const nodeIndexes = new WeakMap<CASOutput, Map<string, CASNode>>();
const sourceFileIndexes = new WeakMap<CASOutput, string[]>();
const nodeIdsByFileIndexes = new WeakMap<CASOutput, Map<string, string[]>>();

export function getAgentNodeIndex(cas: CASOutput): Map<string, CASNode> {
  const cached = nodeIndexes.get(cas);
  if (cached) return cached;
  const index = new Map(cas.nodes.map(node => [node.id, node]));
  nodeIndexes.set(cas, index);
  return index;
}

export function getAgentSourceFiles(cas: CASOutput): string[] {
  const cached = sourceFileIndexes.get(cas);
  if (cached) return cached;
  const files = [...new Set(cas.nodes
    .map(node => node.source?.file)
    .filter((file): file is string => Boolean(file)))];
  sourceFileIndexes.set(cas, files);
  return files;
}

export function getAgentNodeIdsForFiles(cas: CASOutput, files: string[]): Set<string> {
  if (files.length === 0) return new Set();
  const index = nodeIdsByFileIndex(cas);
  const nodeIds = new Set<string>();
  for (const requestedFile of files) {
    const file = normalizeFile(requestedFile, cas.system?.root_path);
    const exact = index.get(file);
    if (exact) {
      exact.forEach(nodeId => nodeIds.add(nodeId));
      continue;
    }
    for (const [candidate, candidateNodeIds] of index) {
      if (!pathsMatch(candidate, file)) continue;
      candidateNodeIds.forEach(nodeId => nodeIds.add(nodeId));
    }
  }
  return nodeIds;
}

function nodeIdsByFileIndex(cas: CASOutput): Map<string, string[]> {
  const cached = nodeIdsByFileIndexes.get(cas);
  if (cached) return cached;
  const index = new Map<string, string[]>();
  for (const node of cas.nodes) {
    if (!node.source?.file) continue;
    const file = normalizeFile(node.source.file, cas.system?.root_path);
    const nodeIds = index.get(file) || [];
    nodeIds.push(node.id);
    index.set(file, nodeIds);
  }
  nodeIdsByFileIndexes.set(cas, index);
  return index;
}

function normalizeFile(file: string, rootPath?: string): string {
  const normalized = file.replace(/\\/g, '/').replace(/^\.\//, '');
  const root = rootPath?.replace(/\\/g, '/').replace(/\/$/, '');
  return root && normalized.startsWith(`${root}/`)
    ? normalized.slice(root.length + 1).toLowerCase()
    : normalized.toLowerCase();
}

function pathsMatch(left: string, right: string): boolean {
  return left === right || left.endsWith(`/${right}`) || right.endsWith(`/${left}`);
}
