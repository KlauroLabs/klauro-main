import type { CASEdge, CASNode, CASOutput } from '../../types/cas.types';

const ABSENT = 0xffffffff;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface CompactCASGraphLimits {
  maxNodes: number;
  maxEdges: number;
  maxStrings: number;
  maxStringBytes: number;
  maxPageSize: number;
  maxTraversalNodes: number;
  maxTraversalEdges: number;
  maxTraversalDepth: number;
}

export interface CompactStringDictionary {
  bytes: Uint8Array;
  offsets: Uint32Array;
}

export interface CompactNodeColumns {
  id: Uint32Array;
  name: Uint32Array;
  type: Uint32Array;
  qualifiedName: Uint32Array;
  category: Uint32Array;
  sourceFile: Uint32Array;
  sourceLine: Uint32Array;
}

export interface CompactEdgeColumns {
  id: Uint32Array;
  source: Uint32Array;
  target: Uint32Array;
  type: Uint32Array;
  category: Uint32Array;
}

export interface CompactAdjacencyIndex {
  offsets: Uint32Array;
  edgeOrdinals: Uint32Array;
}

export interface CompactNodeView {
  denseId: number;
  id: string;
  name: string;
  type: string;
  qualifiedName?: string;
  category?: string;
  sourceFile?: string;
  sourceLine?: number;
}

export interface CompactEdgeView {
  ordinal: number;
  id: string;
  source: number;
  target: number;
  sourceId: string;
  targetId: string;
  type: string;
  category?: string;
}

export interface CompactPage<T> {
  items: T[];
  total: number;
  nextOffset?: number;
}

export interface CompactDenseIdPage {
  denseIds: Uint32Array;
  total: number;
  nextOffset?: number;
}

export interface CompactNodeSearchRequest {
  name?: string;
  type?: string;
  category?: string;
  sourceFile?: string;
  offset?: number;
  limit: number;
}

export interface CompactTraversalRequest {
  direction: 'outgoing' | 'incoming' | 'both';
  maxDepth: number;
  maxNodes: number;
  maxEdges: number;
}

export interface CompactTraversalResult {
  nodeDenseIds: Uint32Array;
  edgeOrdinals: Uint32Array;
  truncated: boolean;
}

export interface CompactCASParityResult {
  ok: boolean;
  errors: string[];
}

type StructuralCAS = Pick<CASOutput, 'nodes' | 'edges'>;

interface CanonicalEdge {
  edge: CASEdge;
  source: number;
  target: number;
}

const DEFAULT_LIMITS: CompactCASGraphLimits = {
  maxNodes: 10_000_000,
  maxEdges: 100_000_000,
  maxStrings: 100_000_000,
  maxStringBytes: 0xfffffffe,
  maxPageSize: 10_000,
  maxTraversalNodes: 100_000,
  maxTraversalEdges: 1_000_000,
  maxTraversalDepth: 1_000,
};

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareOptionalStrings(left: string | undefined, right: string | undefined): number {
  if (left === undefined) return right === undefined ? 0 : -1;
  if (right === undefined) return 1;
  return compareStrings(left, right);
}

function assertCount(name: string, value: number, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum || value >= ABSENT) {
    throw new RangeError(`${name} ${value} exceeds the supported maximum ${Math.min(maximum, ABSENT - 1)}`);
  }
}

function assertPositiveBound(name: string, value: number, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`${name} must be an integer from 1 through ${maximum}`);
  }
}

function resolveLimits(overrides: Partial<CompactCASGraphLimits>): CompactCASGraphLimits {
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1 || value >= ABSENT) {
      throw new RangeError(`${name} must be an integer from 1 through ${ABSENT - 1}`);
    }
  }
  return limits;
}

function canonicalizeNodes(nodes: CASNode[], limits: CompactCASGraphLimits): CASNode[] {
  assertCount('node count', nodes.length, limits.maxNodes);
  const sorted = [...nodes].sort((left, right) => compareStrings(left.id, right.id));
  for (let index = 0; index < sorted.length; index += 1) {
    const node = sorted[index];
    if (!node.id) throw new Error(`CAS node at canonical index ${index} has an empty id`);
    if (index > 0 && sorted[index - 1].id === node.id) {
      throw new Error(`CAS contains duplicate node id ${node.id}`);
    }
  }
  return sorted;
}

function canonicalizeEdges(
  edges: CASEdge[],
  denseById: Map<string, number>,
  limits: CompactCASGraphLimits
): CanonicalEdge[] {
  assertCount('edge count', edges.length, limits.maxEdges);
  const canonical = edges.map((edge, ordinal) => {
    const source = denseById.get(edge.source);
    const target = denseById.get(edge.target);
    if (source === undefined || target === undefined) {
      const endpoints = [source === undefined ? `source ${edge.source}` : '', target === undefined ? `target ${edge.target}` : '']
        .filter(Boolean)
        .join(' and ');
      throw new Error(`CAS edge ${edge.id || `at index ${ordinal}`} has unresolved ${endpoints}`);
    }
    return { edge, source, target };
  });
  canonical.sort((left, right) => (
    left.source - right.source
    || left.target - right.target
    || compareStrings(left.edge.type, right.edge.type)
    || compareStrings(left.edge.id, right.edge.id)
    || compareOptionalStrings(left.edge.category, right.edge.category)
  ));
  return canonical;
}

function collectStrings(nodes: CASNode[], edges: CanonicalEdge[], limits: CompactCASGraphLimits): string[] {
  const values = new Set<string>();
  for (const node of nodes) {
    values.add(node.id);
    values.add(node.name);
    values.add(node.type);
    if (node.qualified_name !== undefined) values.add(node.qualified_name);
    if (node.category !== undefined) values.add(node.category);
    if (node.source?.file !== undefined) values.add(node.source.file);
  }
  for (const { edge } of edges) {
    values.add(edge.id);
    values.add(edge.type);
    if (edge.category !== undefined) values.add(edge.category);
  }
  assertCount('string count', values.size, limits.maxStrings);
  return [...values].sort(compareStrings);
}

function buildDictionary(values: string[], limits: CompactCASGraphLimits): {
  dictionary: CompactStringDictionary;
  indexByValue: Map<string, number>;
} {
  const encoded = values.map(value => encoder.encode(value));
  const byteLength = encoded.reduce((total, value) => total + value.byteLength, 0);
  assertCount('dictionary byte count', byteLength, limits.maxStringBytes);
  const bytes = new Uint8Array(byteLength);
  const offsets = new Uint32Array(values.length + 1);
  const indexByValue = new Map<string, number>();
  let offset = 0;
  for (let index = 0; index < values.length; index += 1) {
    offsets[index] = offset;
    bytes.set(encoded[index], offset);
    offset += encoded[index].byteLength;
    indexByValue.set(values[index], index);
  }
  offsets[values.length] = offset;
  return { dictionary: { bytes, offsets }, indexByValue };
}

function stringReference(value: string | undefined, indexByValue: Map<string, number>): number {
  if (value === undefined) return ABSENT;
  const reference = indexByValue.get(value);
  if (reference === undefined) throw new Error(`String dictionary is missing ${JSON.stringify(value)}`);
  return reference;
}

function buildAdjacency(nodeCount: number, edges: CanonicalEdge[], endpoint: 'source' | 'target'): CompactAdjacencyIndex {
  const offsets = new Uint32Array(nodeCount + 1);
  for (const edge of edges) offsets[edge[endpoint] + 1] += 1;
  for (let index = 1; index < offsets.length; index += 1) offsets[index] += offsets[index - 1];
  const edgeOrdinals = new Uint32Array(edges.length);
  const positions = offsets.slice(0, nodeCount);
  for (let ordinal = 0; ordinal < edges.length; ordinal += 1) {
    const denseId = edges[ordinal][endpoint];
    edgeOrdinals[positions[denseId]] = ordinal;
    positions[denseId] += 1;
  }
  return { offsets, edgeOrdinals };
}

export class CompactCASGraph {
  readonly dictionary: CompactStringDictionary;
  readonly nodes: CompactNodeColumns;
  readonly edges: CompactEdgeColumns;
  readonly outgoing: CompactAdjacencyIndex;
  readonly incoming: CompactAdjacencyIndex;
  readonly limits: CompactCASGraphLimits;

  constructor(
    dictionary: CompactStringDictionary,
    nodes: CompactNodeColumns,
    edges: CompactEdgeColumns,
    outgoing: CompactAdjacencyIndex,
    incoming: CompactAdjacencyIndex,
    limits: CompactCASGraphLimits
  ) {
    this.dictionary = dictionary;
    this.nodes = nodes;
    this.edges = edges;
    this.outgoing = outgoing;
    this.incoming = incoming;
    this.limits = limits;
  }

  get nodeCount(): number {
    return this.nodes.id.length;
  }

  get edgeCount(): number {
    return this.edges.id.length;
  }

  get encodedByteLength(): number {
    let total = this.dictionary.bytes.byteLength + this.dictionary.offsets.byteLength;
    for (const column of Object.values(this.nodes)) total += column.byteLength;
    for (const column of Object.values(this.edges)) total += column.byteLength;
    total += this.outgoing.offsets.byteLength + this.outgoing.edgeOrdinals.byteLength;
    total += this.incoming.offsets.byteLength + this.incoming.edgeOrdinals.byteLength;
    return total;
  }

  decodeString(reference: number): string | undefined {
    if (reference === ABSENT) return undefined;
    if (!Number.isSafeInteger(reference) || reference < 0 || reference + 1 >= this.dictionary.offsets.length) {
      throw new RangeError(`String reference ${reference} is outside the dictionary`);
    }
    return decoder.decode(this.dictionary.bytes.subarray(
      this.dictionary.offsets[reference],
      this.dictionary.offsets[reference + 1]
    ));
  }

  nodeAt(denseId: number): CompactNodeView {
    this.assertDenseId(denseId);
    return {
      denseId,
      id: this.requiredString(this.nodes.id[denseId]),
      name: this.requiredString(this.nodes.name[denseId]),
      type: this.requiredString(this.nodes.type[denseId]),
      qualifiedName: this.decodeString(this.nodes.qualifiedName[denseId]),
      category: this.decodeString(this.nodes.category[denseId]),
      sourceFile: this.decodeString(this.nodes.sourceFile[denseId]),
      sourceLine: this.nodes.sourceLine[denseId] === ABSENT ? undefined : this.nodes.sourceLine[denseId],
    };
  }

  nodeById(id: string): CompactNodeView | undefined {
    let low = 0;
    let high = this.nodeCount - 1;
    while (low <= high) {
      const middle = low + Math.floor((high - low) / 2);
      const candidate = this.requiredString(this.nodes.id[middle]);
      if (candidate === id) return this.nodeAt(middle);
      if (candidate < id) low = middle + 1;
      else high = middle - 1;
    }
    return undefined;
  }

  findNodes(request: CompactNodeSearchRequest): CompactDenseIdPage {
    assertPositiveBound('limit', request.limit, this.limits.maxPageSize);
    const offset = request.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0) throw new RangeError('offset must be a non-negative integer');
    const filters: Array<[Uint32Array, number]> = [];
    for (const [value, column] of [
      [request.name, this.nodes.name],
      [request.type, this.nodes.type],
      [request.category, this.nodes.category],
      [request.sourceFile, this.nodes.sourceFile],
    ] as Array<[string | undefined, Uint32Array]>) {
      if (value === undefined) continue;
      const reference = this.dictionaryReference(value);
      if (reference === undefined) return { denseIds: new Uint32Array(0), total: 0 };
      filters.push([column, reference]);
    }
    const denseIds: number[] = [];
    let total = 0;
    for (let denseId = 0; denseId < this.nodeCount; denseId += 1) {
      if (!filters.every(([column, reference]) => column[denseId] === reference)) continue;
      if (total >= offset && denseIds.length < request.limit) denseIds.push(denseId);
      total += 1;
    }
    const consumed = Math.min(offset + denseIds.length, total);
    return {
      denseIds: Uint32Array.from(denseIds),
      total,
      nextOffset: consumed < total ? consumed : undefined,
    };
  }

  edgeAt(ordinal: number): CompactEdgeView {
    if (!Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal >= this.edgeCount) {
      throw new RangeError(`Edge ordinal ${ordinal} is outside the graph`);
    }
    const source = this.edges.source[ordinal];
    const target = this.edges.target[ordinal];
    return {
      ordinal,
      id: this.requiredString(this.edges.id[ordinal]),
      source,
      target,
      sourceId: this.requiredString(this.nodes.id[source]),
      targetId: this.requiredString(this.nodes.id[target]),
      type: this.requiredString(this.edges.type[ordinal]),
      category: this.decodeString(this.edges.category[ordinal]),
    };
  }

  outgoingEdges(denseId: number, request: { offset?: number; limit: number }): CompactPage<CompactEdgeView> {
    return this.edgePage(this.outgoing, denseId, request);
  }

  incomingEdges(denseId: number, request: { offset?: number; limit: number }): CompactPage<CompactEdgeView> {
    return this.edgePage(this.incoming, denseId, request);
  }

  traverse(startDenseId: number, request: CompactTraversalRequest): CompactTraversalResult {
    this.assertDenseId(startDenseId);
    assertPositiveBound('maxDepth', request.maxDepth, this.limits.maxTraversalDepth);
    assertPositiveBound('maxNodes', request.maxNodes, this.limits.maxTraversalNodes);
    assertPositiveBound('maxEdges', request.maxEdges, this.limits.maxTraversalEdges);
    const visited = new Uint8Array(this.nodeCount);
    const nodes: number[] = [startDenseId];
    const edges: number[] = [];
    const edgeSeen = new Set<number>();
    const queue: Array<{ denseId: number; depth: number }> = [{ denseId: startDenseId, depth: 0 }];
    visited[startDenseId] = 1;
    let cursor = 0;
    let truncated = false;
    while (cursor < queue.length) {
      const current = queue[cursor];
      cursor += 1;
      if (current.depth >= request.maxDepth) {
        if (this.degree(current.denseId, request.direction) > 0) truncated = true;
        continue;
      }
      const indexes = request.direction === 'outgoing'
        ? [this.outgoing]
        : request.direction === 'incoming'
          ? [this.incoming]
          : [this.outgoing, this.incoming];
      for (const index of indexes) {
        const begin = index.offsets[current.denseId];
        const end = index.offsets[current.denseId + 1];
        for (let position = begin; position < end; position += 1) {
          const ordinal = index.edgeOrdinals[position];
          if (!edgeSeen.has(ordinal)) {
            if (edges.length >= request.maxEdges) {
              truncated = true;
              return { nodeDenseIds: Uint32Array.from(nodes), edgeOrdinals: Uint32Array.from(edges), truncated };
            }
            edgeSeen.add(ordinal);
            edges.push(ordinal);
          }
          const next = index === this.outgoing ? this.edges.target[ordinal] : this.edges.source[ordinal];
          if (visited[next] === 0) {
            if (nodes.length >= request.maxNodes) {
              truncated = true;
              continue;
            }
            visited[next] = 1;
            nodes.push(next);
            queue.push({ denseId: next, depth: current.depth + 1 });
          }
        }
      }
    }
    return { nodeDenseIds: Uint32Array.from(nodes), edgeOrdinals: Uint32Array.from(edges), truncated };
  }

  private requiredString(reference: number): string {
    const value = this.decodeString(reference);
    if (value === undefined) throw new Error('Required compact string is absent');
    return value;
  }

  private dictionaryReference(value: string): number | undefined {
    let low = 0;
    let high = this.dictionary.offsets.length - 2;
    while (low <= high) {
      const middle = low + Math.floor((high - low) / 2);
      const candidate = this.requiredString(middle);
      if (candidate === value) return middle;
      if (candidate < value) low = middle + 1;
      else high = middle - 1;
    }
    return undefined;
  }

  private assertDenseId(denseId: number): void {
    if (!Number.isSafeInteger(denseId) || denseId < 0 || denseId >= this.nodeCount) {
      throw new RangeError(`Dense node id ${denseId} is outside the graph`);
    }
  }

  private degree(denseId: number, direction: CompactTraversalRequest['direction']): number {
    const outgoing = this.outgoing.offsets[denseId + 1] - this.outgoing.offsets[denseId];
    const incoming = this.incoming.offsets[denseId + 1] - this.incoming.offsets[denseId];
    return direction === 'outgoing' ? outgoing : direction === 'incoming' ? incoming : outgoing + incoming;
  }

  private edgePage(
    index: CompactAdjacencyIndex,
    denseId: number,
    request: { offset?: number; limit: number }
  ): CompactPage<CompactEdgeView> {
    this.assertDenseId(denseId);
    assertPositiveBound('limit', request.limit, this.limits.maxPageSize);
    const offset = request.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0) throw new RangeError('offset must be a non-negative integer');
    const begin = index.offsets[denseId];
    const end = index.offsets[denseId + 1];
    const total = end - begin;
    const pageBegin = begin + Math.min(offset, total);
    const pageEnd = Math.min(pageBegin + request.limit, end);
    const items: CompactEdgeView[] = [];
    for (let position = pageBegin; position < pageEnd; position += 1) {
      items.push(this.edgeAt(index.edgeOrdinals[position]));
    }
    const consumed = pageEnd - begin;
    return { items, total, nextOffset: consumed < total ? consumed : undefined };
  }
}

export function encodeCompactCASGraph(
  cas: StructuralCAS,
  limitOverrides: Partial<CompactCASGraphLimits> = {}
): CompactCASGraph {
  const limits = resolveLimits(limitOverrides);
  const nodes = canonicalizeNodes(cas.nodes, limits);
  const denseById = new Map(nodes.map((node, denseId) => [node.id, denseId]));
  const edges = canonicalizeEdges(cas.edges, denseById, limits);
  const strings = collectStrings(nodes, edges, limits);
  const { dictionary, indexByValue } = buildDictionary(strings, limits);
  const nodeColumns: CompactNodeColumns = {
    id: new Uint32Array(nodes.length),
    name: new Uint32Array(nodes.length),
    type: new Uint32Array(nodes.length),
    qualifiedName: new Uint32Array(nodes.length),
    category: new Uint32Array(nodes.length),
    sourceFile: new Uint32Array(nodes.length),
    sourceLine: new Uint32Array(nodes.length),
  };
  for (let denseId = 0; denseId < nodes.length; denseId += 1) {
    const node = nodes[denseId];
    nodeColumns.id[denseId] = stringReference(node.id, indexByValue);
    nodeColumns.name[denseId] = stringReference(node.name, indexByValue);
    nodeColumns.type[denseId] = stringReference(node.type, indexByValue);
    nodeColumns.qualifiedName[denseId] = stringReference(node.qualified_name, indexByValue);
    nodeColumns.category[denseId] = stringReference(node.category, indexByValue);
    nodeColumns.sourceFile[denseId] = stringReference(node.source?.file, indexByValue);
    const line = node.source?.line;
    if (line !== undefined && (!Number.isSafeInteger(line) || line < 0 || line >= ABSENT)) {
      throw new RangeError(`Node ${node.id} has unsupported source line ${line}`);
    }
    nodeColumns.sourceLine[denseId] = line ?? ABSENT;
  }
  const edgeColumns: CompactEdgeColumns = {
    id: new Uint32Array(edges.length),
    source: new Uint32Array(edges.length),
    target: new Uint32Array(edges.length),
    type: new Uint32Array(edges.length),
    category: new Uint32Array(edges.length),
  };
  for (let ordinal = 0; ordinal < edges.length; ordinal += 1) {
    const { edge, source, target } = edges[ordinal];
    edgeColumns.id[ordinal] = stringReference(edge.id, indexByValue);
    edgeColumns.source[ordinal] = source;
    edgeColumns.target[ordinal] = target;
    edgeColumns.type[ordinal] = stringReference(edge.type, indexByValue);
    edgeColumns.category[ordinal] = stringReference(edge.category, indexByValue);
  }
  return new CompactCASGraph(
    dictionary,
    nodeColumns,
    edgeColumns,
    buildAdjacency(nodes.length, edges, 'source'),
    buildAdjacency(nodes.length, edges, 'target'),
    limits
  );
}

export function validateCompactCASParity(
  graph: CompactCASGraph,
  cas: StructuralCAS,
  maxErrors = 100
): CompactCASParityResult {
  assertPositiveBound('maxErrors', maxErrors, 10_000);
  const errors: string[] = [];
  const addError = (message: string): void => {
    if (errors.length < maxErrors) errors.push(message);
  };
  let expected: CompactCASGraph;
  try {
    expected = encodeCompactCASGraph(cas, graph.limits);
  } catch (error) {
    return { ok: false, errors: [error instanceof Error ? error.message : String(error)] };
  }
  const compare = (name: string, left: Uint8Array | Uint32Array, right: Uint8Array | Uint32Array): void => {
    if (left.length !== right.length) {
      addError(`${name} length ${left.length} does not match ${right.length}`);
      return;
    }
    for (let index = 0; index < left.length && errors.length < maxErrors; index += 1) {
      if (left[index] !== right[index]) addError(`${name}[${index}] ${left[index]} does not match ${right[index]}`);
    }
  };
  compare('dictionary.bytes', graph.dictionary.bytes, expected.dictionary.bytes);
  compare('dictionary.offsets', graph.dictionary.offsets, expected.dictionary.offsets);
  for (const key of Object.keys(expected.nodes) as Array<keyof CompactNodeColumns>) {
    compare(`nodes.${key}`, graph.nodes[key], expected.nodes[key]);
  }
  for (const key of Object.keys(expected.edges) as Array<keyof CompactEdgeColumns>) {
    compare(`edges.${key}`, graph.edges[key], expected.edges[key]);
  }
  compare('outgoing.offsets', graph.outgoing.offsets, expected.outgoing.offsets);
  compare('outgoing.edgeOrdinals', graph.outgoing.edgeOrdinals, expected.outgoing.edgeOrdinals);
  compare('incoming.offsets', graph.incoming.offsets, expected.incoming.offsets);
  compare('incoming.edgeOrdinals', graph.incoming.edgeOrdinals, expected.incoming.edgeOrdinals);
  return { ok: errors.length === 0, errors };
}
