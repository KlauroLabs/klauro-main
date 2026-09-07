import * as fs from 'node:fs';
import * as zlib from 'node:zlib';
import type { CASEdge, CASNode } from '../../../packages/analyzer-core/src/types/cas.types';
import type { CompactCASGraph, CompactNodeView } from '../../../packages/analyzer-core/src/analyzer/core/compact-cas-graph';
import { loadCompactAnalysisGraph, resolveAnalysisSectionExportArtifact } from './storage';

export const SCOPED_QUERY_TOOLS = new Set(['get_coding_context', 'assess_change_risk', 'find_tests']);
const DEFAULT_NEIGHBOR_LIMIT = 10;
const MAX_NEIGHBOR_LIMIT = 500;
const MAX_SCOPED_NODES = 4000;
const MAX_SCOPED_EDGES = 20000;
const TARGET_SEARCH_LIMIT = 200;
const TEST_PATH = /(^|[\\/])(__tests__|__mocks__|tests?|specs?|fixtures?)([\\/]|$)|\.(test|spec)\.[a-z]+$/i;
const STREAM_MODULES = ['stream-json/parser.js', 'stream-json/filters/pick.js', 'stream-json/streamers/stream-array.js', 'stream-chain'];

export interface ScopedQueryScope {
  targetId: string;
  keepIds: Set<string>;
  callerCount: number;
  calleeCount: number;
  truncated: boolean;
}

export interface ScopedGraphSection {
  nodes: CASNode[];
  edges: CASEdge[];
  scanned: { nodes: number; edges: number };
}

function boundedLimit(value: unknown): number {
  const parsed = typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_NEIGHBOR_LIMIT;
  return Math.min(parsed, MAX_NEIGHBOR_LIMIT);
}

export function scopedQueryTarget(tool: string, args: Record<string, unknown> | undefined): string | undefined {
  if (!args) return undefined;
  if (tool === 'get_coding_context' && typeof args.target === 'string' && args.target.trim()) return args.target.trim();
  if ((tool === 'assess_change_risk' || tool === 'find_tests') && typeof args.node_id === 'string' && args.node_id.trim()) return args.node_id.trim();
  return undefined;
}

function lastSegment(value: string): string {
  const trimmed = value.replace(/[()]/g, '').trim();
  const parts = trimmed.split(/[.:#/\\]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : trimmed;
}

export function resolveCompactTarget(graph: CompactCASGraph, target: string): CompactNodeView | undefined {
  const exact = graph.nodeById(target);
  if (exact) return exact;
  const name = lastSegment(target);
  if (!name) return undefined;
  const page = graph.findNodes({ name, limit: TARGET_SEARCH_LIMIT });
  const candidates = Array.from(page.denseIds, denseId => graph.nodeAt(denseId));
  if (candidates.length === 0) return undefined;
  const lowered = target.toLowerCase();
  const qualified = candidates.find(node => (node.qualifiedName || '').toLowerCase() === lowered)
    || candidates.find(node => (node.qualifiedName || '').toLowerCase().endsWith(lowered))
    || candidates.find(node => node.id.toLowerCase() === lowered);
  if (qualified) return qualified;
  const production = candidates.filter(node => !node.isTest && !node.isGenerated && !TEST_PATH.test(node.sourceFile || ''));
  const pool = production.length > 0 ? production : candidates;
  const degree = (node: CompactNodeView): number =>
    graph.incomingEdges(node.denseId, { limit: 1 }).total + graph.outgoingEdges(node.denseId, { limit: 1 }).total;
  return pool.slice().sort((left, right) => degree(right) - degree(left) || left.denseId - right.denseId)[0];
}

export function computeScopedQueryScope(
  graph: CompactCASGraph,
  target: CompactNodeView,
  limits: { callerLimit?: unknown; calleeLimit?: unknown },
): ScopedQueryScope {
  const callerLimit = boundedLimit(limits.callerLimit);
  const calleeLimit = boundedLimit(limits.calleeLimit);
  const keepIds = new Set<string>([target.id]);
  let truncated = false;
  const incoming = graph.incomingEdges(target.denseId, { limit: Math.min(MAX_NEIGHBOR_LIMIT, Math.max(callerLimit, DEFAULT_NEIGHBOR_LIMIT) * 2) });
  for (const edge of incoming.items) keepIds.add(edge.sourceId);
  const outgoing = graph.outgoingEdges(target.denseId, { limit: Math.min(MAX_NEIGHBOR_LIMIT, Math.max(calleeLimit, DEFAULT_NEIGHBOR_LIMIT) * 2) });
  for (const edge of outgoing.items) keepIds.add(edge.targetId);
  truncated = incoming.nextOffset !== undefined || outgoing.nextOffset !== undefined;
  const secondHop = graph.traverse(target.denseId, {
    direction: 'both',
    maxDepth: 2,
    maxNodes: Math.min(MAX_SCOPED_NODES, Math.max(64, (callerLimit + calleeLimit) * 8)),
    maxEdges: Math.min(MAX_SCOPED_EDGES, Math.max(256, (callerLimit + calleeLimit) * 32)),
  });
  for (const denseId of secondHop.nodeDenseIds) {
    if (keepIds.size >= MAX_SCOPED_NODES) { truncated = true; break; }
    keepIds.add(graph.nodeAt(denseId).id);
  }
  truncated = truncated || secondHop.truncated;
  if (target.sourceFile) {
    const siblings = graph.findNodes({ sourceFile: target.sourceFile, limit: Math.min(200, MAX_SCOPED_NODES - keepIds.size) });
    for (const denseId of siblings.denseIds) keepIds.add(graph.nodeAt(denseId).id);
    truncated = truncated || siblings.nextOffset !== undefined;
  }
  return {
    targetId: target.id,
    keepIds,
    callerCount: incoming.total,
    calleeCount: outgoing.total,
    truncated,
  };
}

function decompressStream(filePath: string, codec: 'none' | 'brotli' | 'zstd'): NodeJS.ReadableStream {
  const raw = fs.createReadStream(filePath);
  if (codec === 'brotli') return raw.pipe(zlib.createBrotliDecompress());
  if (codec === 'zstd') {
    const factory = (zlib as unknown as { createZstdDecompress?: () => NodeJS.ReadWriteStream }).createZstdDecompress;
    if (!factory) throw new Error('Stored graph section uses zstd but this Node runtime cannot stream zstd.');
    return raw.pipe(factory());
  }
  return raw;
}

function isEdgeRecord(record: Record<string, unknown>): record is CASEdge & Record<string, unknown> {
  return typeof record.source === 'string' && typeof record.target === 'string' && !('name' in record);
}

export async function loadScopedGraphSection(projectPath: string, keepIds: ReadonlySet<string>): Promise<ScopedGraphSection | null> {
  const artifact = await resolveAnalysisSectionExportArtifact(projectPath, 'graph');
  if (!artifact) return null;
  const [{ parser }, { pick }, { streamArray }, { chain }] = await Promise.all(
    STREAM_MODULES.map(specifier => import(specifier) as Promise<any>),
  ) as [{ parser: () => unknown }, { pick: (options: { filter: RegExp }) => unknown }, { streamArray: () => unknown }, { chain: (stages: unknown[]) => NodeJS.EventEmitter }];
  const scanned = { nodes: 0, edges: 0 };
  const nodes: CASNode[] = [];
  const edges: CASEdge[] = [];
  const pipeline = chain([decompressStream(artifact.filePath, artifact.codec), parser(), pick({ filter: /^(nodes|edges)$/ }), streamArray()]);
  await new Promise<void>((resolve, reject) => {
    pipeline.on('data', (item: { value: Record<string, unknown> }) => {
      const record = item.value;
      if (!record || typeof record !== 'object') return;
      if (isEdgeRecord(record)) {
        scanned.edges += 1;
        if (keepIds.has(record.source) && keepIds.has(record.target)) edges.push(record as unknown as CASEdge);
        return;
      }
      scanned.nodes += 1;
      const id = record.id;
      if (typeof id === 'string' && keepIds.has(id)) nodes.push(record as unknown as CASNode);
    });
    pipeline.on('end', resolve);
    pipeline.on('error', reject);
  });
  return { nodes, edges, scanned };
}

export async function planScopedQuery(
  projectPath: string,
  tool: string,
  args: Record<string, unknown> | undefined,
): Promise<{ scope: ScopedQueryScope; target: CompactNodeView } | { targetNotFound: string } | null> {
  const target = scopedQueryTarget(tool, args);
  if (!target || !SCOPED_QUERY_TOOLS.has(tool)) return null;
  const graph = await loadCompactAnalysisGraph(projectPath);
  if (!graph) return null;
  const resolved = resolveCompactTarget(graph, target);
  if (!resolved) return { targetNotFound: target };
  const scope = computeScopedQueryScope(graph, resolved, {
    callerLimit: args?.caller_limit,
    calleeLimit: args?.callee_limit,
  });
  return { scope, target: resolved };
}
