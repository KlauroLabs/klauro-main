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
import { CAS_SEMANTIC_TABLES, edgeRecordKey, isSupportedCasRecordStoreDescriptor, isSupportedCasSemanticStoreDescriptor, openCasRecordStore, openCasSemanticStore, type CasRecordStoreReadStats, type CasSemanticTableName } from './cas-record-store';
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

export const SCOPED_QUERY_TOOLS = new Set(['get_coding_context', 'assess_change_risk', 'find_tests', 'get_agent_context']);
const MAX_AGENT_SEEDS = 12;
const MAX_FILE_NODES = 400;
const MAX_AGENT_NEIGHBORHOOD_NODES = 600;
const MAX_AGENT_NEIGHBORHOOD_EDGES = 4000;
const MAX_EDGE_ORDER_MAP_BYTES = 96 * 1024 * 1024;
export const LIGHT_NODE_ABSENT_FIELDS = ['description', 'description_source', 'metadata', 'documentation', 'call_graph', 'perspectives', 'contract', 'subcategories', 'analyzers', 'role'] as const;
export const LIGHT_EDGE_ABSENT_FIELDS = ['metadata', 'weight', 'evidence'] as const;
const EXACT_ID_SCOPED_TOOLS = new Set(['assess_change_risk', 'find_tests']);
const MAX_UPSTREAM_DEPTH = 1000;
const MAX_CONTAINS_DEPTH = 32;

export function scopedSmallSections(tool: string, required: readonly CasSectionName[]): CasSectionName[] {
  return required.filter(section => section !== 'graph' && (section !== 'calls' || tool === 'assess_change_risk' || tool === 'get_agent_context'));
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
  incomplete?: string;
}

export interface ScopedGraphSection {
  nodes: CASNode[];
  edges: CASEdge[];
  scanned: { nodes: number; edges: number };
  edgesTruncated: boolean;
  source: 'record-store' | 'stream';
  stats?: CasRecordStoreReadStats;
  edgeRecordOrdinals?: number[];
  edgeOriginalIndexByOrdinal?: Uint32Array;
  edgeOrderMapSkipped?: string;
}

export interface AgentContextProjection {
  nodes: CASNode[];
  edges: CASEdge[];
  keepIds: Set<string>;
  scope: ScopedQueryScope;
  source: 'record-store' | 'stream';
  lightNodes: number;
  lightEdges: number;
  fullEdgesTruncated: boolean;
  edgeOrder: 'original' | 'compact-canonical';
  edgeOrderReason?: string;
  stats?: CasRecordStoreReadStats;
}

function boundedLimit(value: unknown): number {
  const parsed = typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_NEIGHBOR_LIMIT;
  return Math.min(parsed, MAX_NEIGHBOR_LIMIT);
}

export function scopedQueryTarget(tool: string, args: Record<string, unknown> | undefined): string | undefined {
  if (!args) return undefined;
  if (tool === 'get_coding_context' && typeof args.target === 'string' && args.target.trim()) return args.target.trim();
  if (tool === 'get_agent_context') {
    const task = args.task as { target?: unknown; related_paths?: unknown } | undefined;
    if (typeof task?.target === 'string' && task.target.trim()) return task.target.trim();
    if (Array.isArray(task?.related_paths) && typeof task.related_paths[0] === 'string' && task.related_paths[0].trim()) return task.related_paths[0].trim();
  }
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

function collectNeighbors(graph: CompactCASGraph, denseId: number, direction: 'incoming' | 'outgoing', keepIds: Set<string>): { total: number; incomplete: boolean } {
  let offset: number | undefined = 0;
  let total = 0;
  while (offset !== undefined) {
    const page: ReturnType<CompactCASGraph['incomingEdges']> = direction === 'incoming' ? graph.incomingEdges(denseId, { offset, limit: 500 }) : graph.outgoingEdges(denseId, { offset, limit: 500 });
    total = page.total;
    for (const edge of page.items) {
      if (keepIds.size >= MAX_SCOPED_NODES) return { total, incomplete: true };
      keepIds.add(direction === 'incoming' ? edge.sourceId : edge.targetId);
    }
    offset = page.nextOffset;
  }
  return { total, incomplete: false };
}

function collectContainingAncestors(graph: CompactCASGraph, target: CompactNodeView, keepIds: Set<string>): void {
  let current = target.denseId;
  for (let depth = 0; depth < MAX_CONTAINS_DEPTH; depth += 1) {
    let parentDenseId: number | undefined;
    let offset: number | undefined = 0;
    while (offset !== undefined && parentDenseId === undefined) {
      const page: ReturnType<CompactCASGraph['incomingEdges']> = graph.incomingEdges(current, { offset, limit: 500 });
      const parent = page.items.find(edge => edge.type === 'contains');
      if (parent) parentDenseId = parent.source;
      offset = page.nextOffset;
    }
    if (parentDenseId === undefined) return;
    keepIds.add(graph.nodeAt(parentDenseId).id);
    current = parentDenseId;
  }
}

export interface ExactScopedQueryScope extends ScopedQueryScope {
  upstreamNodes: number;
  upstreamTruncated: boolean;
}

export function computeChangeRiskScope(graph: CompactCASGraph, target: CompactNodeView): ExactScopedQueryScope {
  const keepIds = new Set<string>([target.id]);
  const incoming = collectNeighbors(graph, target.denseId, 'incoming', keepIds);
  const outgoing = collectNeighbors(graph, target.denseId, 'outgoing', keepIds);
  collectContainingAncestors(graph, target, keepIds);
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
  const reasons = [
    incoming.incomplete ? `${incoming.total} direct callers exceed the ${MAX_SCOPED_NODES}-node scope` : null,
    outgoing.incomplete ? `${outgoing.total} direct callees exceed the ${MAX_SCOPED_NODES}-node scope` : null,
    upstreamTruncated ? `the transitive caller closure exceeds ${MAX_SCOPED_NODES} nodes or ${MAX_SCOPED_EDGES} edges` : null,
  ].filter((reason): reason is string => Boolean(reason));
  return {
    targetId: target.id,
    keepIds,
    callerCount: incoming.total,
    calleeCount: outgoing.total,
    truncated: reasons.length > 0,
    ...(reasons.length > 0 ? { incomplete: reasons.join('; ') } : {}),
    upstreamNodes: upstream.nodeDenseIds.length,
    upstreamTruncated,
  };
}

export function computeTestLookupScope(graph: CompactCASGraph, target: CompactNodeView): ScopedQueryScope {
  const keepIds = new Set<string>([target.id]);
  const incoming = collectNeighbors(graph, target.denseId, 'incoming', keepIds);
  collectContainingAncestors(graph, target, keepIds);
  const outgoing = graph.outgoingEdges(target.denseId, { limit: 1 });
  return {
    targetId: target.id,
    keepIds,
    callerCount: incoming.total,
    calleeCount: outgoing.total,
    truncated: incoming.incomplete,
    ...(incoming.incomplete ? { incomplete: `${incoming.total} direct callers exceed the ${MAX_SCOPED_NODES}-node scope` } : {}),
  };
}

function lightNode(view: CompactNodeView): CASNode {
  return {
    id: view.id,
    name: view.name,
    type: view.type,
    ...(view.qualifiedName !== undefined ? { qualified_name: view.qualifiedName } : {}),
    ...(view.category !== undefined ? { category: view.category } : {}),
    ...(view.level !== undefined ? { level: view.level } : {}),
    ...(view.levelName !== undefined ? { level_name: view.levelName } : {}),
    ...(view.tags ? { tags: [...view.tags] } : {}),
    ...(view.sourceFile !== undefined ? { source: { file: view.sourceFile, ...(view.sourceLine !== undefined ? { line: view.sourceLine } : {}) } } : {}),
    ...(view.isTest ? { metadata: { is_test: true } } : {}),
  } as CASNode;
}

export function computeAgentContextScope(graph: CompactCASGraph, seedIds: readonly string[], files: readonly string[]): ScopedQueryScope {
  const keepIds = new Set<string>();
  const reasons: string[] = [];
  let callerCount = 0;
  let calleeCount = 0;
  for (const file of files) {
    const siblings = graph.findNodes({ sourceFile: file, limit: MAX_FILE_NODES });
    for (const denseId of siblings.denseIds) keepIds.add(graph.nodeAt(denseId).id);
    if (siblings.nextOffset !== undefined) reasons.push(`${file} has more than ${MAX_FILE_NODES} nodes; only the first ${MAX_FILE_NODES} carry full records`);
  }
  for (const seedId of seedIds.slice(0, MAX_AGENT_SEEDS)) {
    const seed = graph.nodeById(seedId);
    if (!seed) continue;
    keepIds.add(seed.id);
    const incoming = collectNeighbors(graph, seed.denseId, 'incoming', keepIds);
    const outgoing = collectNeighbors(graph, seed.denseId, 'outgoing', keepIds);
    if (seedId === seedIds[0]) { callerCount = incoming.total; calleeCount = outgoing.total; }
    collectContainingAncestors(graph, seed, keepIds);
    if (incoming.incomplete || outgoing.incomplete) reasons.push(`${seed.id} has more incident edges than the ${MAX_SCOPED_NODES}-node scope`);
    const neighborhood = graph.traverse(seed.denseId, { direction: 'both', maxDepth: 2, maxNodes: MAX_AGENT_NEIGHBORHOOD_NODES, maxEdges: MAX_AGENT_NEIGHBORHOOD_EDGES });
    for (const denseId of neighborhood.nodeDenseIds) {
      if (keepIds.size >= MAX_SCOPED_NODES) { reasons.push(`the two-hop neighbourhood of ${seed.id} exceeds the ${MAX_SCOPED_NODES}-node scope`); break; }
      keepIds.add(graph.nodeAt(denseId).id);
    }
    if (neighborhood.truncated) reasons.push(`the two-hop neighbourhood of ${seed.id} carries full records for its first ${MAX_AGENT_NEIGHBORHOOD_NODES} nodes only`);
    if (seed.sourceFile && !files.includes(seed.sourceFile)) {
      const siblings = graph.findNodes({ sourceFile: seed.sourceFile, limit: Math.max(0, Math.min(MAX_FILE_NODES, MAX_SCOPED_NODES - keepIds.size)) });
      for (const denseId of siblings.denseIds) keepIds.add(graph.nodeAt(denseId).id);
      if (siblings.nextOffset !== undefined) reasons.push(`${seed.sourceFile} has more nodes than the scope can carry`);
    }
    if (seedId === seedIds[0]) {
      const upstream = graph.traverse(seed.denseId, { direction: 'incoming', maxDepth: MAX_UPSTREAM_DEPTH, maxNodes: MAX_SCOPED_NODES, maxEdges: MAX_SCOPED_EDGES });
      for (const denseId of upstream.nodeDenseIds) {
        if (keepIds.size >= MAX_SCOPED_NODES) { reasons.push(`the caller closure of ${seed.id} exceeds the ${MAX_SCOPED_NODES}-node scope`); break; }
        keepIds.add(graph.nodeAt(denseId).id);
      }
      if (upstream.truncated) reasons.push(`the caller closure of ${seed.id} was cut at ${MAX_SCOPED_NODES} nodes or ${MAX_SCOPED_EDGES} edges`);
    }
  }
  const unique = [...new Set(reasons)];
  return {
    targetId: seedIds[0] ?? '',
    keepIds,
    callerCount,
    calleeCount,
    truncated: unique.length > 0,
    ...(unique.length > 0 ? { incomplete: unique.join('; ') } : {}),
  };
}

export async function loadAgentContextProjection(
  pinned: PinnedAnalysisGeneration,
  graph: CompactCASGraph,
  scope: ScopedQueryScope,
): Promise<AgentContextProjection | null> {
  const section = scope.keepIds.size > 0 ? await loadScopedGraphSection(pinned, scope.keepIds, graph, { edgeOrderMap: true }) : { nodes: [], edges: [], scanned: { nodes: graph.nodeCount, edges: graph.edgeCount }, edgesTruncated: false, source: 'record-store' as const };
  if (!section) return null;
  const fullById = new Map(section.nodes.map(node => [node.id, node]));
  const ordered: Array<{ ordinal: number; node: CASNode }> = [];
  for (let denseId = 0; denseId < graph.nodeCount; denseId += 1) {
    const view = graph.nodeAt(denseId);
    ordered.push({ ordinal: view.originalOrdinal, node: fullById.get(view.id) ?? lightNode(view) });
  }
  ordered.sort((left, right) => left.ordinal - right.ordinal);
  const nodes = ordered.map(entry => entry.node);
  const edges: CASEdge[] = new Array(graph.edgeCount);
  const recordOrdinals = section.edgeRecordOrdinals;
  if (recordOrdinals && section.source === 'record-store') {
    const descriptor = pinned.segmented.manifest.record_store;
    const store = isSupportedCasRecordStoreDescriptor(descriptor) ? await openCasRecordStore(pinned.segmented.directory, descriptor, { nodeCount: graph.nodeCount, edgeCount: graph.edgeCount }) : null;
    for (let ordinal = 0; ordinal < graph.edgeCount; ordinal += 1) {
      const view = graph.edgeAt(ordinal);
      const slot = store ? store.edges.recordOrdinal(ordinal) : ordinal;
      edges[slot] = { id: view.id, source: view.sourceId, target: view.targetId, type: view.type, ...(view.category !== undefined ? { category: view.category } : {}) } as CASEdge;
    }
    recordOrdinals.forEach((slot, index) => { edges[slot] = section.edges[index]; });
  } else {
    const full = new Map<string, CASEdge[]>();
    for (const edge of section.edges) {
      const key = edgeRecordKey(edge);
      const bucket = full.get(key);
      if (bucket) bucket.push(edge); else full.set(key, [edge]);
    }
    const orderMap = section.edgeOriginalIndexByOrdinal;
    for (let ordinal = 0; ordinal < graph.edgeCount; ordinal += 1) {
      const view = graph.edgeAt(ordinal);
      const bucket = full.get(edgeRecordKey({ id: view.id, source: view.sourceId, target: view.targetId, type: view.type, category: view.category }));
      const slot = orderMap ? orderMap[ordinal] : ordinal;
      edges[slot] = bucket?.shift() ?? ({ id: view.id, source: view.sourceId, target: view.targetId, type: view.type, ...(view.category !== undefined ? { category: view.category } : {}) } as CASEdge);
    }
  }
  return {
    nodes,
    edges,
    keepIds: new Set(scope.keepIds),
    scope,
    source: section.source,
    lightNodes: graph.nodeCount - fullById.size,
    lightEdges: graph.edgeCount - section.edges.length,
    fullEdgesTruncated: Boolean(section.edgesTruncated),
    edgeOrder: recordOrdinals || section.edgeOriginalIndexByOrdinal ? 'original' : 'compact-canonical',
    ...(section.edgeOrderMapSkipped ? { edgeOrderReason: section.edgeOrderMapSkipped } : {}),
    stats: section.stats,
  };
}

export function agentContextProjectionGaps(projection: AgentContextProjection): Record<string, unknown> {
  return {
    mode: 'bounded-projection',
    full_record_nodes: projection.keepIds.size,
    light_nodes: projection.lightNodes,
    light_edges: projection.lightEdges,
    light_node_fields_absent: [...LIGHT_NODE_ABSENT_FIELDS],
    light_edge_fields_absent: [...LIGHT_EDGE_ABSENT_FIELDS],
    computed_on_light_records: [
      'readiness gates that count nodes, edges and method calls (exact: counts do not need heavy fields)',
      'language coverage note (exact: file and type only)',
      'architecture and conformance relevance scans over id, name, qualified name, type and file (exact)',
      'natural-language target scoring outside the kept neighbourhood (approximate: description text is absent on light nodes; the compact search index supplied the candidate seeds)',
      'representative target ranking (approximate: synthetic call-site filtering reads description on light nodes)',
    ],
    edge_order: projection.edgeOrder,
    ...(projection.edgeOrderReason ? { edge_order_reason: projection.edgeOrderReason, approximate_because_of_edge_order: ['direct_callers, callees and call-chain listings follow compact-canonical order instead of analysis order'] } : {}),
    full_edges_truncated: projection.fullEdgesTruncated,
    ...(projection.fullEdgesTruncated ? { approximate_because_of_edge_truncation: [
      'callers and callees beyond the loaded full edges carry light edges only (ids and types exact, edge metadata absent)',
      'coding context call-site details for clipped edges',
      'on-demand change-risk scoring evidence read from edge metadata',
    ] } : {}),
    ...(projection.scope.incomplete ? { full_record_coverage: projection.scope.incomplete } : {}),
  };
}

export function scopedQueryCapacityOutcome(tool: string, scope: ScopedQueryScope, loaderTruncated = false): Record<string, unknown> | undefined {
  if (!EXACT_ID_SCOPED_TOOLS.has(tool)) return undefined;
  if (!scope.incomplete && !loaderTruncated) return undefined;
  if (!scope.incomplete) scope = { ...scope, incomplete: `the induced edge set of the scope exceeds the ${MAX_SCOPED_EDGES}-edge loader bound` };
  const reason = `${tool} could not be answered exactly within the bounded query worker: ${scope.incomplete}. No partial result is returned; nothing was scored.`;
  if (tool === 'assess_change_risk') return { risk: null, incomplete: true, reason, transitive_impact: null, change_risk_context: null };
  return { incomplete: true, reason, suites: null, total_suites: null };
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
  const originalOrdinal = new Map<string, number>();
  for (const denseId of denseIds) originalOrdinal.set(graph.nodeAt(denseId).id, graph.nodeAt(denseId).originalOrdinal);
  nodes.sort((left, right) => (originalOrdinal.get(left.id) ?? 0) - (originalOrdinal.get(right.id) ?? 0));
  const edges = await store.edges.read(edgeOrdinals);
  const edgeRecordOrdinals = edgeOrdinals.map(ordinal => store.edges.recordOrdinal(ordinal)).sort((left, right) => left - right);
  return {
    nodes,
    edges,
    scanned: { nodes: graph.nodeCount, edges: graph.edgeCount },
    edgesTruncated,
    source: 'record-store',
    stats: store.stats(),
    edgeRecordOrdinals,
  };
}

export async function loadScopedGraphSection(
  pinned: PinnedAnalysisGeneration,
  keepIds: ReadonlySet<string>,
  graph?: CompactCASGraph,
  options: { edgeOrderMap?: boolean } = {},
): Promise<ScopedGraphSection | null> {
  if (graph) {
    const records = await loadScopedRecords(pinned, keepIds, graph);
    if (records) return records;
  }
  let edgeOrderMapSkipped: string | undefined;
  let mapBytes = 0;
  const ordinalByKey = graph && options.edgeOrderMap ? new Map<string, number[]>() : undefined;
  if (graph && ordinalByKey) {
    for (let ordinal = 0; ordinal < graph.edgeCount; ordinal += 1) {
      const view = graph.edgeAt(ordinal);
      const key = edgeRecordKey({ id: view.id, source: view.sourceId, target: view.targetId, type: view.type, category: view.category });
      mapBytes += key.length * 2 + 16;
      if (mapBytes > MAX_EDGE_ORDER_MAP_BYTES) { edgeOrderMapSkipped = `edge order map would need more than ${MAX_EDGE_ORDER_MAP_BYTES} bytes`; ordinalByKey.clear(); break; }
      const bucket = ordinalByKey.get(key);
      if (bucket) bucket.push(ordinal); else ordinalByKey.set(key, [ordinal]);
    }
  }
  const orderMapActive = Boolean(graph && ordinalByKey && !edgeOrderMapSkipped);
  const originalIndexByOrdinal = orderMapActive ? new Uint32Array(graph!.edgeCount) : undefined;
  const assignedOrdinals = orderMapActive ? new Uint8Array(graph!.edgeCount) : undefined;
  let assignedCount = 0;
  let unmatchedStreamEdges = 0;
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
        if (orderMapActive && ordinalByKey && originalIndexByOrdinal && assignedOrdinals) {
          const bucket = ordinalByKey.get(edgeRecordKey(record as CASEdge));
          const ordinal = bucket?.shift();
          if (ordinal === undefined) unmatchedStreamEdges += 1;
          else if (assignedOrdinals[ordinal]) unmatchedStreamEdges += 1;
          else { assignedOrdinals[ordinal] = 1; originalIndexByOrdinal[ordinal] = scanned.edges; assignedCount += 1; }
        }
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
  if (orderMapActive && graph) {
    const leftover = [...ordinalByKey!.values()].reduce((sum, bucket) => sum + bucket.length, 0);
    if (unmatchedStreamEdges > 0 || leftover > 0 || assignedCount !== graph.edgeCount || scanned.edges !== graph.edgeCount || scanned.nodes !== graph.nodeCount) {
      edgeOrderMapSkipped = `stream and compact edge sets differ (assigned ${assignedCount} of ${graph.edgeCount}, unmatched ${unmatchedStreamEdges}, leftover ${leftover}, scanned ${scanned.nodes}/${scanned.edges} vs ${graph.nodeCount}/${graph.edgeCount})`;
    }
  }
  return {
    nodes,
    edges,
    scanned,
    edgesTruncated,
    source: 'stream',
    ...(originalIndexByOrdinal && !edgeOrderMapSkipped ? { edgeOriginalIndexByOrdinal: originalIndexByOrdinal } : {}),
    ...(edgeOrderMapSkipped ? { edgeOrderMapSkipped } : {}),
  };
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
  if (tool === 'get_agent_context') {
    const task = (args?.task ?? {}) as { target?: string; related_paths?: string[] };
    const seeds: string[] = [];
    const resolved = task.target ? resolveCompactTarget(graph, task.target, await searchCandidateIds(pinned, task.target)) : undefined;
    if (resolved) seeds.push(resolved.id);
    if (task.target) for (const id of await searchCandidateIds(pinned, task.target)) if (!seeds.includes(id) && graph.nodeById(id)) seeds.push(id);
    const files = (task.related_paths ?? []).filter((file): file is string => typeof file === 'string' && file.trim().length > 0);
    if (seeds.length === 0 && files.length === 0) return { targetNotFound: target };
    const scope = computeAgentContextScope(graph, seeds, files);
    return { scope, target: resolved ?? graph.nodeById(seeds[0]) ?? graph.nodeAt(0), graphNodeCount: graph.nodeCount, graph };
  }
  if (EXACT_ID_SCOPED_TOOLS.has(tool)) {
    const exact = graph.nodeById(target);
    if (!exact) return { targetNotFound: target };
    const scope = tool === 'assess_change_risk' ? computeChangeRiskScope(graph, exact) : computeTestLookupScope(graph, exact);
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

export interface ScopedSemanticCollections {
  collections: Partial<Record<CasSemanticTableName, unknown[]>> & { reachability_index?: unknown };
  projected: Record<string, { total: number; matched: number; read: number }>;
  stats: CasRecordStoreReadStats;
}

export const NODE_KEYED_SEMANTIC_TABLES: readonly CasSemanticTableName[] = ['method_calls', 'change_risks'];

export async function loadScopedSemanticCollections(
  pinned: PinnedAnalysisGeneration,
  graph: CompactCASGraph,
  keepIds: ReadonlySet<string>,
  tables: readonly CasSemanticTableName[] = NODE_KEYED_SEMANTIC_TABLES,
): Promise<ScopedSemanticCollections | null> {
  const descriptor = pinned.segmented.manifest.semantic_store;
  if (!isSupportedCasSemanticStoreDescriptor(descriptor)) return null;
  const totals = pinned.segmented.manifest.collection_totals;
  const store = await openCasSemanticStore(pinned.segmented.directory, descriptor, {
    nodeCount: graph.nodeCount,
    totals: totals ? Object.fromEntries(CAS_SEMANTIC_TABLES.filter(name => typeof totals[name] === 'number').map(name => [name, totals[name]])) : undefined,
  });
  const denseIds: number[] = [];
  for (const id of keepIds) {
    const node = graph.nodeById(id);
    if (node) denseIds.push(node.denseId);
  }
  const collections: ScopedSemanticCollections['collections'] = {};
  const projected: Record<string, { total: number; matched: number; read: number }> = {};
  const reachability = await store.readReachabilityIndex();
  if (reachability !== undefined) collections.reachability_index = reachability;
  for (const table of tables) {
    if (!store.tables.has(table)) {
      const total = totals?.[table];
      if (typeof total === 'number' && total === 0) { collections[table] = []; projected[table] = { total: 0, matched: 0, read: 0 }; }
      continue;
    }
    const result = await store.readByNodes(table, denseIds);
    collections[table] = result.records;
    projected[table] = { total: result.total, matched: result.matched, read: result.read };
  }
  return { collections, projected, stats: store.stats() };
}
