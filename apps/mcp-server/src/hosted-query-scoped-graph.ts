import * as fs from 'node:fs';
import * as zlib from 'node:zlib';
import type { CASEdge, CASNode } from '../../../packages/analyzer-core/src/types/cas.types';
import type { CompactCASGraph, CompactNodeView } from '../../../packages/analyzer-core/src/analyzer/core/compact-cas-graph';
import * as path from 'node:path';
import { acquireCurrentSegmentedAnalysisLease, resolveAnalysisForLoad, type AnalysisEntry } from './storage';
import type { AnalysisTrack } from './track';
import type { ResolvedSegmentedAnalysis } from './segmented-analysis-storage';
import { loadCompactCASGraph, loadCompactCASSearch } from './segmented-analysis-storage';
import { compressionCodecForPath } from './json-storage-writer';
import { isSupportedCasRecordStoreDescriptor, openCasRecordStore, type CasRecordStoreReadStats } from './cas-record-store';
import type { CasSectionName } from './cas-sections';
import { searchCompactCAS } from '../../../packages/analyzer-core/src/analyzer/core/compact-cas-search';

export interface PinnedAnalysisGeneration {
  filePath: string;
  segmented: ResolvedSegmentedAnalysis;
  entry: AnalysisEntry;
  release: () => Promise<void>;
}

export async function acquirePinnedAnalysis(projectPath: string, options?: { track?: AnalysisTrack }): Promise<PinnedAnalysisGeneration | null> {
  const resolved = await resolveAnalysisForLoad(projectPath, options?.track);
  const lease = resolved ? await acquireCurrentSegmentedAnalysisLease(resolved) : null;
  return resolved && lease ? { filePath: resolved.filePath, segmented: lease.segmented, entry: resolved.entry, release: lease.release } : null;
}

export const SCOPED_QUERY_TOOLS = new Set(['get_coding_context', 'assess_change_risk', 'find_tests']);
const EXACT_ID_SCOPED_TOOLS = new Set(['assess_change_risk', 'find_tests']);
const MAX_UPSTREAM_DEPTH = 64;

export function scopedSmallSections(tool: string, required: readonly CasSectionName[]): CasSectionName[] {
  return required.filter(section => section !== 'graph' && (section !== 'calls' || tool === 'assess_change_risk'));
}
const DEFAULT_NEIGHBOR_LIMIT = 10;
const MAX_NEIGHBOR_LIMIT = 500;
const MAX_SCOPED_NODES = 4000;
const MAX_SCOPED_EDGES = 20000;
const TARGET_SEARCH_LIMIT = 200;
const MAX_FILE_TARGET_MATCHES = 500;
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
  edgesTruncated: boolean;
  source: 'record-store' | 'stream';
  stats?: CasRecordStoreReadStats;
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

function normalizeCodingTarget(value: string): string {
  return String(value || '').replace(/\\/g, '/').split('/').pop()!.replace(/\.[a-z0-9]+$/i, '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function nodeIsTest(node: CompactNodeView): boolean {
  return node.isTest || node.category === 'test' || node.type === 'test' || TEST_PATH.test(node.sourceFile || '');
}

function targetScore(node: CompactNodeView, wantsTest: boolean): number {
  const ownerTypes = ['class', 'service', 'controller', 'handler', 'gateway', 'resolver', 'repository', 'entity', 'model'];
  let score = ownerTypes.includes(node.type) ? 90 : node.type === 'module' ? 80 : node.type === 'file' ? 70 : node.type === 'function' ? 55 : node.type === 'method' ? 45 : 10;
  score += nodeIsTest(node) === wantsTest ? 200 : -300;
  if (['import', 'property', 'variable', 'mock'].includes(node.type)) score -= 150;
  return score;
}

function rankTargets(graph: CompactCASGraph, nodes: CompactNodeView[], wantsTest: boolean): CompactNodeView[] {
  const degree = new Map<number, number>();
  const degreeOf = (node: CompactNodeView): number => {
    let value = degree.get(node.denseId);
    if (value === undefined) {
      value = graph.incomingEdges(node.denseId, { limit: 1 }).total + graph.outgoingEdges(node.denseId, { limit: 1 }).total;
      degree.set(node.denseId, value);
    }
    return value;
  };
  return [...nodes].sort((left, right) =>
    targetScore(right, wantsTest) - targetScore(left, wantsTest)
    || degreeOf(right) - degreeOf(left)
    || (left.sourceLine ?? Number.MAX_SAFE_INTEGER) - (right.sourceLine ?? Number.MAX_SAFE_INTEGER)
    || left.denseId - right.denseId);
}

function fileTargetMatches(graph: CompactCASGraph, target: string): CompactNodeView[] {
  const normalizedTarget = normalizeCodingTarget(target);
  const pathTarget = target.replace(/\\/g, '/');
  const looksLikePath = /[\/]/.test(pathTarget) || /\.[a-z0-9]+$/i.test(pathTarget);
  if (!looksLikePath && !normalizedTarget) return [];
  const matches: CompactNodeView[] = [];
  for (let denseId = 0; denseId < graph.nodeCount && matches.length < MAX_FILE_TARGET_MATCHES; denseId += 1) {
    const file = graph.decodeString(graph.nodes.sourceFile[denseId]);
    if (!file) continue;
    const normalizedFile = file.replace(/\\/g, '/');
    const basename = normalizedFile.split('/').pop() || normalizedFile;
    const stem = basename.replace(/\.[^.]+$/, '');
    if ((looksLikePath && normalizedFile.endsWith(pathTarget)) || normalizeCodingTarget(stem) === normalizedTarget) matches.push(graph.nodeAt(denseId));
  }
  return matches;
}

export function resolveCompactTarget(graph: CompactCASGraph, target: string, extraCandidateIds: readonly string[] = []): CompactNodeView | undefined {
  const exact = graph.nodeById(target);
  if (exact) return exact;
  const wantsTest = /(^|[^a-z])(tests?|specs?|e2e)([^a-z]|$)/i.test(target);
  const fileMatch = rankTargets(graph, fileTargetMatches(graph, target), wantsTest)[0];
  if (fileMatch) return fileMatch;
  const name = target.replace(/[()]/g, '').trim().split(/[.:#/\\]/).filter(Boolean).pop() || '';
  const seen = new Set<string>();
  const candidates: CompactNodeView[] = [];
  const nameMatches = name ? Array.from(graph.findNodes({ name, limit: TARGET_SEARCH_LIMIT }).denseIds, denseId => graph.nodeAt(denseId)) : [];
  for (const node of [...nameMatches, ...extraCandidateIds.map(id => graph.nodeById(id))]) {
    if (!node || seen.has(node.id)) continue;
    seen.add(node.id);
    candidates.push(node);
  }
  if (candidates.length === 0) return undefined;
  const lowered = target.toLowerCase();
  const qualified = candidates.find(node => (node.qualifiedName || '').toLowerCase() === lowered)
    || candidates.find(node => (node.qualifiedName || '').toLowerCase().endsWith(lowered))
    || candidates.find(node => node.id.toLowerCase() === lowered);
  if (qualified) return qualified;
  return rankTargets(graph, candidates, wantsTest)[0];
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

export function computeChangeRiskScope(graph: CompactCASGraph, target: CompactNodeView): ScopedQueryScope & { upstreamNodes: number; upstreamTruncated: boolean } {
  const base = computeScopedQueryScope(graph, target, {});
  const keepIds = new Set(base.keepIds);
  const upstream = graph.traverse(target.denseId, {
    direction: 'incoming',
    maxDepth: MAX_UPSTREAM_DEPTH,
    maxNodes: MAX_SCOPED_NODES,
    maxEdges: MAX_SCOPED_EDGES,
  });
  let upstreamTruncated = upstream.truncated;
  for (const denseId of upstream.nodeDenseIds) {
    if (keepIds.size >= MAX_SCOPED_NODES) { upstreamTruncated = true; break; }
    keepIds.add(graph.nodeAt(denseId).id);
  }
  return {
    ...base,
    keepIds,
    truncated: base.truncated || upstreamTruncated,
    upstreamNodes: upstream.nodeDenseIds.length,
    upstreamTruncated,
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

function pinnedGraphArtifact(pinned: PinnedAnalysisGeneration): { filePath: string; codec: 'none' | 'brotli' | 'zstd' } | null {
  const descriptor = pinned.segmented.manifest.sections.find(item => item.name === 'graph');
  if (!descriptor?.file || path.basename(descriptor.file) !== descriptor.file) return null;
  const filePath = path.join(pinned.segmented.directory, descriptor.file);
  return { filePath, codec: compressionCodecForPath(filePath) };
}

async function loadScopedRecords(
  pinned: PinnedAnalysisGeneration,
  keepIds: ReadonlySet<string>,
  graph: CompactCASGraph,
): Promise<ScopedGraphSection | null> {
  const descriptor = pinned.segmented.manifest.record_store;
  if (!isSupportedCasRecordStoreDescriptor(descriptor)) return null;
  const store = await openCasRecordStore(pinned.segmented.directory, descriptor, { nodeCount: graph.nodeCount, edgeCount: graph.edgeCount });
  const denseIds: number[] = [];
  for (const id of keepIds) {
    const node = graph.nodeById(id);
    if (node) denseIds.push(node.denseId);
  }
  denseIds.sort((left, right) => left - right);
  const edgeOrdinals: number[] = [];
  let edgesTruncated = false;
  for (const denseId of denseIds) {
    let offset = 0;
    while (true) {
      const page = graph.outgoingEdges(denseId, { offset, limit: 500 });
      for (const edge of page.items) {
        if (!keepIds.has(edge.targetId)) continue;
        if (edgeOrdinals.length >= MAX_SCOPED_EDGES) { edgesTruncated = true; break; }
        edgeOrdinals.push(edge.ordinal);
      }
      if (edgesTruncated || page.nextOffset === undefined) break;
      offset = page.nextOffset;
    }
    if (edgesTruncated) break;
  }
  edgeOrdinals.sort((left, right) => left - right);
  const nodes = await store.nodes.read(denseIds);
  const edges = await store.edges.read(edgeOrdinals);
  return {
    nodes,
    edges,
    scanned: { nodes: graph.nodeCount, edges: graph.edgeCount },
    edgesTruncated,
    source: 'record-store',
    stats: store.stats(),
  };
}

export async function loadScopedGraphSection(
  pinned: PinnedAnalysisGeneration,
  keepIds: ReadonlySet<string>,
  graph?: CompactCASGraph,
): Promise<ScopedGraphSection | null> {
  if (graph) {
    const records = await loadScopedRecords(pinned, keepIds, graph);
    if (records) return records;
  }
  const artifact = pinnedGraphArtifact(pinned);
  if (!artifact) return null;
  const [{ parser }, { pick }, { streamArray }, { chain }] = await Promise.all(
    STREAM_MODULES.map(specifier => import(specifier) as Promise<any>),
  ) as [{ parser: () => unknown }, { pick: (options: { filter: RegExp }) => unknown }, { streamArray: () => unknown }, { chain: (stages: unknown[]) => NodeJS.EventEmitter }];
  const scanned = { nodes: 0, edges: 0 };
  const nodes: CASNode[] = [];
  const edges: CASEdge[] = [];
  let edgesTruncated = false;
  const pipeline = chain([decompressStream(artifact.filePath, artifact.codec), parser(), pick({ filter: /^(nodes|edges)$/ }), streamArray()]);
  await new Promise<void>((resolve, reject) => {
    pipeline.on('data', (item: { value: Record<string, unknown> }) => {
      const record = item.value;
      if (!record || typeof record !== 'object') return;
      if (isEdgeRecord(record)) {
        scanned.edges += 1;
        if (!keepIds.has(record.source) || !keepIds.has(record.target)) return;
        if (edges.length >= MAX_SCOPED_EDGES) { edgesTruncated = true; return; }
        edges.push(record as unknown as CASEdge);
        return;
      }
      scanned.nodes += 1;
      const id = record.id;
      if (typeof id === 'string' && keepIds.has(id)) nodes.push(record as unknown as CASNode);
    });
    pipeline.on('end', resolve);
    pipeline.on('error', reject);
  });
  return { nodes, edges, scanned, edgesTruncated, source: 'stream' };
}

async function searchCandidateIds(pinned: PinnedAnalysisGeneration, target: string): Promise<string[]> {
  try {
    const search = await loadCompactCASSearch(pinned.filePath, pinned.segmented);
    if (!search) return [];
    const hits = await searchCompactCAS(search.graph, search.index, target, search.readPostings, search.readSearchText, { limit: 50 });
    return hits.map(hit => hit.id);
  } catch {
    return [];
  }
}

export async function planScopedQuery(
  pinned: PinnedAnalysisGeneration,
  tool: string,
  args: Record<string, unknown> | undefined,
): Promise<{ scope: ScopedQueryScope; target: CompactNodeView; graphNodeCount: number; graph: CompactCASGraph } | { targetNotFound: string } | null> {
  const target = scopedQueryTarget(tool, args);
  if (!target || !SCOPED_QUERY_TOOLS.has(tool)) return null;
  const graph = await loadCompactCASGraph(pinned.filePath, pinned.segmented);
  if (!graph) return null;
  if (EXACT_ID_SCOPED_TOOLS.has(tool)) {
    const exact = graph.nodeById(target);
    if (!exact) return { targetNotFound: target };
    const scope = tool === 'assess_change_risk' ? computeChangeRiskScope(graph, exact) : computeScopedQueryScope(graph, exact, {});
    return { scope, target: exact, graphNodeCount: graph.nodeCount, graph };
  }
  const resolved = resolveCompactTarget(graph, target, await searchCandidateIds(pinned, target));
  if (!resolved) return { targetNotFound: target };
  const scope = computeScopedQueryScope(graph, resolved, {
    callerLimit: args?.caller_limit,
    calleeLimit: args?.callee_limit,
  });
  return { scope, target: resolved, graphNodeCount: graph.nodeCount, graph };
}
