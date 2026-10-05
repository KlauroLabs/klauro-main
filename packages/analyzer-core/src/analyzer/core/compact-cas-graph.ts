import type { CASEdge, CASNode, CASOutput } from '../../types/cas.types';

const ABSENT = 0xffffffff;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface CompactCASGraphLimits {
  maxNodes: number;
  maxVertices: number;
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
  originalOrdinal: Uint32Array;
  vertex: Uint32Array;
  id: Uint32Array;
  name: Uint32Array;
  type: Uint32Array;
  qualifiedName: Uint32Array;
  category: Uint32Array;
  sourceFile: Uint32Array;
  sourceLine: Uint32Array;
  level: Uint32Array;
  levelName: Uint32Array;
  flags: Uint32Array;
  tagOffsets: Uint32Array;
  tagReferences: Uint32Array;
}

export interface CompactVertexColumns {
  id: Uint32Array;
  node: Uint32Array;
  kind: Uint8Array;
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
  originalOrdinal: number;
  id: string;
  name: string;
  type: string;
  qualifiedName?: string;
  category?: string;
  sourceFile?: string;
  sourceLine?: number;
  level?: number;
  levelName?: string;
  tags?: string[];
  isTest: boolean;
  isGenerated: boolean;
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

type StructuralCAS = Pick<CASOutput, 'nodes' | 'edges'> & Partial<Pick<CASOutput, 'entry_points' | 'exit_points'>>;

interface CanonicalEdge {
  edge: CASEdge;
  source: number;
  target: number;
}

const DEFAULT_LIMITS: CompactCASGraphLimits = {
  maxNodes: 10_000_000,
  maxVertices: 20_000_000,
  maxEdges: 100_000_000,
  maxStrings: 1_000_000,
  maxStringBytes: 128 * 1024 * 1024,
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

function firstOccurrences(nodes: CASNode[]): Map<string, { node: CASNode; ordinal: number }> {
  const byId = new Map<string, { node: CASNode; ordinal: number }>();
  for (const node of nodes) {
    if (!byId.has(node.id)) byId.set(node.id, { node, ordinal: byId.size });
  }
  return byId;
}

function originalOrdinals(nodes: CASNode[]): Map<string, number> {
  return new Map([...firstOccurrences(nodes)].map(([id, held]) => [id, held.ordinal]));
}

function canonicalizeNodes(nodes: CASNode[], limits: CompactCASGraphLimits): CASNode[] {
  const unique = [...firstOccurrences(nodes).values()].map(held => held.node);
  assertCount('node count', unique.length, limits.maxNodes);
  const sorted = unique.sort((left, right) => compareStrings(left.id, right.id));
  sorted.forEach((node, index) => {
    if (!node.id) throw new Error(`CAS node at canonical index ${index} has an empty id`);
  });
  return sorted;
}

function canonicalizeEdges(
  edges: CASEdge[],
  vertexById: Map<string, number>,
  limits: CompactCASGraphLimits
): CanonicalEdge[] {
  assertCount('edge count', edges.length, limits.maxEdges);
  const canonical = edges.map((edge, ordinal) => {
    const source = vertexById.get(edge.source);
    const target = vertexById.get(edge.target);
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

function collectStrings(nodes: CASNode[], edges: CanonicalEdge[], limits: CompactCASGraphLimits, extraValues: readonly string[] = []): string[] {
  const values = new Set<string>();
  for (const node of nodes) {
    values.add(node.id);
    values.add(node.name);
    values.add(node.type);
    if (node.qualified_name !== undefined) values.add(node.qualified_name);
    if (node.category !== undefined) values.add(node.category);
    if (node.source?.file !== undefined) values.add(node.source.file);
    if (node.level_name !== undefined) values.add(node.level_name);
    for (const tag of node.tags || []) values.add(tag);
  }
  for (const { edge } of edges) {
    values.add(edge.id);
    values.add(edge.source);
    values.add(edge.target);
    values.add(edge.type);
    if (edge.category !== undefined) values.add(edge.category);
  }
  for (const value of extraValues) values.add(value);
  assertCount('string count', values.size, limits.maxStrings);
  return [...values].sort(compareStrings);
}

function buildDictionary(values: string[], limits: CompactCASGraphLimits): {
  dictionary: CompactStringDictionary;
  indexByValue: Map<string, number>;
} {
  const byteLength = values.reduce((total, value) => total + encoder.encode(value).byteLength, 0);
  assertCount('dictionary byte count', byteLength, limits.maxStringBytes);
  const bytes = new Uint8Array(byteLength);
  const offsets = new Uint32Array(values.length + 1);
  const indexByValue = new Map<string, number>();
  let offset = 0;
  for (let index = 0; index < values.length; index += 1) {
    offsets[index] = offset;
    const encoded = bytes.subarray(offset);
    const result = encoder.encodeInto(values[index], encoded);
    offset += result.written;
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
  readonly vertices: CompactVertexColumns;
  readonly edges: CompactEdgeColumns;
  readonly outgoing: CompactAdjacencyIndex;
  readonly incoming: CompactAdjacencyIndex;
  readonly limits: CompactCASGraphLimits;

  constructor(
    dictionary: CompactStringDictionary,
    nodes: CompactNodeColumns,
    vertices: CompactVertexColumns,
    edges: CompactEdgeColumns,
    outgoing: CompactAdjacencyIndex,
    incoming: CompactAdjacencyIndex,
    limits: CompactCASGraphLimits
  ) {
    this.dictionary = dictionary;
    this.nodes = nodes;
    this.vertices = vertices;
    this.edges = edges;
    this.outgoing = outgoing;
    this.incoming = incoming;
    this.limits = resolveLimits(limits);
    validateCompactCASGraphLayout(this);
  }

  get nodeCount(): number {
    return this.nodes.id.length;
  }

  get edgeCount(): number {
    return this.edges.id.length;
  }

  get vertexCount(): number {
    return this.vertices.id.length;
  }

  get encodedByteLength(): number {
    let total = this.dictionary.bytes.byteLength + this.dictionary.offsets.byteLength;
    for (const column of Object.values(this.nodes)) total += column.byteLength;
    for (const column of Object.values(this.vertices)) total += column.byteLength;
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
      originalOrdinal: this.nodes.originalOrdinal[denseId],
      id: this.requiredString(this.nodes.id[denseId]),
      name: this.requiredString(this.nodes.name[denseId]),
      type: this.requiredString(this.nodes.type[denseId]),
      qualifiedName: this.decodeString(this.nodes.qualifiedName[denseId]),
      category: this.decodeString(this.nodes.category[denseId]),
      sourceFile: this.decodeString(this.nodes.sourceFile[denseId]),
      sourceLine: this.nodes.sourceLine[denseId] === ABSENT ? undefined : this.nodes.sourceLine[denseId],
      level: this.nodes.level[denseId] === ABSENT ? undefined : this.nodes.level[denseId],
      levelName: this.decodeString(this.nodes.levelName[denseId]),
      tags: (this.nodes.flags[denseId] & 4) !== 0
        ? Array.from(
          this.nodes.tagReferences.subarray(this.nodes.tagOffsets[denseId], this.nodes.tagOffsets[denseId + 1]),
          reference => this.requiredString(reference),
        )
        : undefined,
      isTest: (this.nodes.flags[denseId] & 1) !== 0,
      isGenerated: (this.nodes.flags[denseId] & 2) !== 0,
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
      sourceId: this.requiredString(this.vertices.id[source]),
      targetId: this.requiredString(this.vertices.id[target]),
      type: this.requiredString(this.edges.type[ordinal]),
      category: this.decodeString(this.edges.category[ordinal]),
    };
  }

  outgoingEdges(denseId: number, request: { offset?: number; limit: number }): CompactPage<CompactEdgeView> {
    this.assertDenseId(denseId);
    return this.edgePage(this.outgoing, this.nodes.vertex[denseId], request);
  }

  incomingEdges(denseId: number, request: { offset?: number; limit: number }): CompactPage<CompactEdgeView> {
    this.assertDenseId(denseId);
    return this.edgePage(this.incoming, this.nodes.vertex[denseId], request);
  }

  traverse(startDenseId: number, request: CompactTraversalRequest): CompactTraversalResult {
    this.assertDenseId(startDenseId);
    assertPositiveBound('maxDepth', request.maxDepth, this.limits.maxTraversalDepth);
    assertPositiveBound('maxNodes', request.maxNodes, this.limits.maxTraversalNodes);
    assertPositiveBound('maxEdges', request.maxEdges, this.limits.maxTraversalEdges);
    const visited = new Uint8Array(this.vertexCount);
    const nodes: number[] = [startDenseId];
    const edges: number[] = [];
    const edgeSeen = new Set<number>();
    const startVertex = this.nodes.vertex[startDenseId];
    const queue: Array<{ vertex: number; depth: number }> = [{ vertex: startVertex, depth: 0 }];
    visited[startVertex] = 1;
    let cursor = 0;
    let truncated = false;
    while (cursor < queue.length) {
      const current = queue[cursor];
      cursor += 1;
      if (current.depth >= request.maxDepth) {
        if (this.degree(current.vertex, request.direction) > 0) truncated = true;
        continue;
      }
      const indexes = request.direction === 'outgoing'
        ? [this.outgoing]
        : request.direction === 'incoming'
          ? [this.incoming]
          : [this.outgoing, this.incoming];
      for (const index of indexes) {
        const begin = index.offsets[current.vertex];
        const end = index.offsets[current.vertex + 1];
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
          const nextVertex = index === this.outgoing ? this.edges.target[ordinal] : this.edges.source[ordinal];
          if (visited[nextVertex] === 0) {
            const nextNode = this.vertices.node[nextVertex];
            if (nextNode !== ABSENT && nodes.length >= request.maxNodes) {
              truncated = true;
              continue;
            }
            visited[nextVertex] = 1;
            if (nextNode !== ABSENT) nodes.push(nextNode);
            queue.push({ vertex: nextVertex, depth: current.depth + 1 });
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

  private degree(vertex: number, direction: CompactTraversalRequest['direction']): number {
    const outgoing = this.outgoing.offsets[vertex + 1] - this.outgoing.offsets[vertex];
    const incoming = this.incoming.offsets[vertex + 1] - this.incoming.offsets[vertex];
    return direction === 'outgoing' ? outgoing : direction === 'incoming' ? incoming : outgoing + incoming;
  }

  private edgePage(
    index: CompactAdjacencyIndex,
    vertex: number,
    request: { offset?: number; limit: number }
  ): CompactPage<CompactEdgeView> {
    assertPositiveBound('limit', request.limit, this.limits.maxPageSize);
    const offset = request.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0) throw new RangeError('offset must be a non-negative integer');
    const begin = index.offsets[vertex];
    const end = index.offsets[vertex + 1];
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

export function validateCompactCASGraphLayout(graph: CompactCASGraph): void {
  const nodeCount = graph.nodes.id.length;
  const vertexCount = graph.vertices.id.length;
  const edgeCount = graph.edges.id.length;
  assertCount('node count', nodeCount, graph.limits.maxNodes);
  assertCount('vertex count', vertexCount, graph.limits.maxVertices);
  assertCount('edge count', edgeCount, graph.limits.maxEdges);

  const dictionaryOffsets = graph.dictionary.offsets;
  if (dictionaryOffsets.length === 0) throw new Error('Compact CAS graph dictionary offsets must include an initial offset');
  assertCount('string count', dictionaryOffsets.length - 1, graph.limits.maxStrings);
  assertCount('dictionary byte count', graph.dictionary.bytes.byteLength, graph.limits.maxStringBytes);
  validateOffsets('dictionary offsets', dictionaryOffsets, graph.dictionary.bytes.byteLength);
  let previousDictionaryValue: string | undefined;
  for (let index = 0; index < dictionaryOffsets.length - 1; index += 1) {
    const value = decoder.decode(graph.dictionary.bytes.subarray(dictionaryOffsets[index], dictionaryOffsets[index + 1]));
    if (previousDictionaryValue !== undefined && value <= previousDictionaryValue) {
      throw new Error(`Compact CAS graph dictionary is not strictly sorted at index ${index}`);
    }
    previousDictionaryValue = value;
  }

  for (const [name, values] of Object.entries(graph.nodes)) {
    if (name === 'tagOffsets' || name === 'tagReferences') continue;
    if (values.length !== nodeCount) {
      throw new Error(`Compact CAS graph node column ${name} length ${values.length} does not match node count ${nodeCount}`);
    }
  }
  if (graph.nodes.tagOffsets.length !== nodeCount + 1) {
    throw new Error(`Compact CAS graph node tag offsets length ${graph.nodes.tagOffsets.length} does not match ${nodeCount + 1}`);
  }
  validateOffsets('node tag offsets', graph.nodes.tagOffsets, graph.nodes.tagReferences.length);

  const stringCount = dictionaryOffsets.length - 1;
  const validateStringReferences = (name: string, values: Uint32Array, allowAbsent: boolean): void => {
    for (let index = 0; index < values.length; index += 1) {
      const reference = values[index];
      if (reference === ABSENT && allowAbsent) continue;
      if (reference >= stringCount) {
        throw new Error(`Compact CAS graph ${name}[${index}] string reference ${reference} is outside ${stringCount}`);
      }
    }
  };
  validateStringReferences('nodes.id', graph.nodes.id, false);
  validateStringReferences('nodes.name', graph.nodes.name, false);
  validateStringReferences('nodes.type', graph.nodes.type, false);
  validateStringReferences('nodes.qualifiedName', graph.nodes.qualifiedName, true);
  validateStringReferences('nodes.category', graph.nodes.category, true);
  validateStringReferences('nodes.sourceFile', graph.nodes.sourceFile, true);
  validateStringReferences('nodes.levelName', graph.nodes.levelName, true);
  validateStringReferences('nodes.tagReferences', graph.nodes.tagReferences, false);
  validateStringReferences('vertices.id', graph.vertices.id, false);
  validateStringReferences('edges.id', graph.edges.id, false);
  validateStringReferences('edges.type', graph.edges.type, false);
  validateStringReferences('edges.category', graph.edges.category, true);
  const originalOrdinals = new Uint8Array(nodeCount);
  for (let denseId = 0; denseId < nodeCount; denseId += 1) {
    const ordinal = graph.nodes.originalOrdinal[denseId];
    if (ordinal >= nodeCount) throw new Error(`Compact CAS graph original ordinal[${denseId}] ${ordinal} is outside ${nodeCount}`);
    if (originalOrdinals[ordinal] !== 0) throw new Error(`Compact CAS graph original ordinal ${ordinal} is duplicated`);
    originalOrdinals[ordinal] = 1;
  }

  if (graph.vertices.node.length !== vertexCount || graph.vertices.kind.length !== vertexCount) {
    throw new Error('Compact CAS graph vertex column length does not match vertex count');
  }
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    const denseId = graph.vertices.node[vertex];
    if (denseId !== ABSENT && denseId >= nodeCount) {
      throw new Error(`Compact CAS graph vertex node[${vertex}] ${denseId} is outside ${nodeCount}`);
    }
    if (vertex > 0 && graph.vertices.id[vertex] <= graph.vertices.id[vertex - 1]) {
      throw new Error(`Compact CAS graph vertex ids are not strictly sorted at vertex ${vertex}`);
    }
    if (graph.vertices.kind[vertex] < 1 || graph.vertices.kind[vertex] > 7) {
      throw new Error(`Compact CAS graph vertex kind[${vertex}] ${graph.vertices.kind[vertex]} is invalid`);
    }
    const hasNode = (graph.vertices.kind[vertex] & 1) !== 0;
    if (hasNode !== (denseId !== ABSENT)) {
      throw new Error(`Compact CAS graph vertex node kind is inconsistent at vertex ${vertex}`);
    }
  }
  for (let denseId = 0; denseId < nodeCount; denseId += 1) {
    const vertex = graph.nodes.vertex[denseId];
    if (vertex >= vertexCount || graph.vertices.node[vertex] !== denseId || graph.vertices.id[vertex] !== graph.nodes.id[denseId]) {
      throw new Error(`Compact CAS graph node-to-vertex mapping is inconsistent at dense id ${denseId}`);
    }
  }

  for (const [name, values] of Object.entries(graph.edges)) {
    if (values.length !== edgeCount) {
      throw new Error(`Compact CAS graph edge column ${name} length ${values.length} does not match edge count ${edgeCount}`);
    }
  }

  for (let ordinal = 0; ordinal < edgeCount; ordinal += 1) {
    if (graph.edges.source[ordinal] >= vertexCount) {
      throw new Error(`Compact CAS graph edge source[${ordinal}] ${graph.edges.source[ordinal]} is outside ${vertexCount}`);
    }
    if (graph.edges.target[ordinal] >= vertexCount) {
      throw new Error(`Compact CAS graph edge target[${ordinal}] ${graph.edges.target[ordinal]} is outside ${vertexCount}`);
    }
  }

  validateAdjacency('outgoing', graph.outgoing, graph.edges.source, vertexCount, edgeCount);
  validateAdjacency('incoming', graph.incoming, graph.edges.target, vertexCount, edgeCount);
  for (let denseId = 1; denseId < nodeCount; denseId += 1) {
    if (graph.nodes.id[denseId] <= graph.nodes.id[denseId - 1]) {
      throw new Error(`Compact CAS graph node ids are not strictly sorted at dense id ${denseId}`);
    }
  }
}

function validateOffsets(name: string, offsets: Uint32Array, terminal: number): void {
  if (offsets[0] !== 0) throw new Error(`Compact CAS graph ${name} must start at zero`);
  for (let index = 1; index < offsets.length; index += 1) {
    if (offsets[index] < offsets[index - 1]) {
      throw new Error(`Compact CAS graph ${name} must be monotone at index ${index}`);
    }
  }
  if (offsets[offsets.length - 1] !== terminal) {
    throw new Error(`Compact CAS graph ${name} must end at ${terminal}`);
  }
}

function validateAdjacency(
  name: string,
  adjacency: CompactAdjacencyIndex,
  endpoints: Uint32Array,
  vertexCount: number,
  edgeCount: number
): void {
  if (adjacency.offsets.length !== vertexCount + 1) {
    throw new Error(`Compact CAS graph ${name} offsets length ${adjacency.offsets.length} does not match ${vertexCount + 1}`);
  }
  if (adjacency.edgeOrdinals.length !== edgeCount) {
    throw new Error(`Compact CAS graph ${name} edge ordinals length ${adjacency.edgeOrdinals.length} does not match ${edgeCount}`);
  }
  validateOffsets(`${name} offsets`, adjacency.offsets, edgeCount);
  const seen = new Uint8Array(edgeCount);
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    let previousOrdinal = -1;
    for (let index = adjacency.offsets[vertex]; index < adjacency.offsets[vertex + 1]; index += 1) {
      const ordinal = adjacency.edgeOrdinals[index];
      if (ordinal >= edgeCount) {
        throw new Error(`Compact CAS graph ${name} edge ordinal[${index}] ${ordinal} is outside ${edgeCount}`);
      }
      if (seen[ordinal] !== 0) throw new Error(`Compact CAS graph ${name} edge ordinal ${ordinal} is duplicated`);
      if (ordinal <= previousOrdinal) throw new Error(`Compact CAS graph ${name} edge ordinals are not ordered at index ${index}`);
      if (endpoints[ordinal] !== vertex) {
        throw new Error(`Compact CAS graph ${name} edge ordinal ${ordinal} is stored under vertex ${vertex} instead of ${endpoints[ordinal]}`);
      }
      seen[ordinal] = 1;
      previousOrdinal = ordinal;
    }
  }
}

export function encodeCompactCASGraph(
  cas: StructuralCAS,
  limitOverrides: Partial<CompactCASGraphLimits> = {}
): CompactCASGraph {
  const limits = resolveLimits(limitOverrides);
  const nodes = canonicalizeNodes(cas.nodes, limits);
  const originalOrdinalById = originalOrdinals(cas.nodes);
  const entryIds = new Set((cas.entry_points || []).map(entry => entry.id));
  const exitIds = new Set((cas.exit_points || []).map(exit => exit.id));
  const vertexIds = [...new Set([
    ...nodes.map(node => node.id),
    ...entryIds,
    ...exitIds,
  ])].sort(compareStrings);
  assertCount('vertex count', vertexIds.length, limits.maxVertices);
  const vertexById = new Map(vertexIds.map((id, vertex) => [id, vertex]));
  const denseById = new Map(nodes.map((node, denseId) => [node.id, denseId]));
  const edges = canonicalizeEdges(cas.edges, vertexById, limits);
  const strings = collectStrings(nodes, edges, limits, vertexIds);
  assertCount('string count', strings.length, limits.maxStrings);
  const { dictionary, indexByValue } = buildDictionary(strings, limits);
  const nodeColumns: CompactNodeColumns = {
    originalOrdinal: new Uint32Array(nodes.length),
    vertex: new Uint32Array(nodes.length),
    id: new Uint32Array(nodes.length),
    name: new Uint32Array(nodes.length),
    type: new Uint32Array(nodes.length),
    qualifiedName: new Uint32Array(nodes.length),
    category: new Uint32Array(nodes.length),
    sourceFile: new Uint32Array(nodes.length),
    sourceLine: new Uint32Array(nodes.length),
    level: new Uint32Array(nodes.length),
    levelName: new Uint32Array(nodes.length),
    flags: new Uint32Array(nodes.length),
    tagOffsets: new Uint32Array(nodes.length + 1),
    tagReferences: new Uint32Array(nodes.reduce((total, node) => total + (node.tags?.length || 0), 0)),
  };
  let tagOffset = 0;
  for (let denseId = 0; denseId < nodes.length; denseId += 1) {
    const node = nodes[denseId];
    nodeColumns.originalOrdinal[denseId] = originalOrdinalById.get(node.id)!;
    nodeColumns.vertex[denseId] = vertexById.get(node.id)!;
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
    const level = node.level;
    if (level !== undefined && (!Number.isSafeInteger(level) || level < 0 || level >= ABSENT)) {
      throw new RangeError(`Node ${node.id} has unsupported level ${level}`);
    }
    nodeColumns.level[denseId] = level ?? ABSENT;
    nodeColumns.levelName[denseId] = stringReference(node.level_name, indexByValue);
    nodeColumns.flags[denseId] = (node.metadata?.is_test ? 1 : 0)
      | (node.metadata?.is_generated ? 2 : 0)
      | (node.tags !== undefined ? 4 : 0);
    nodeColumns.tagOffsets[denseId] = tagOffset;
    for (const tag of node.tags || []) nodeColumns.tagReferences[tagOffset++] = stringReference(tag, indexByValue);
  }
  nodeColumns.tagOffsets[nodes.length] = tagOffset;
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
  const vertexColumns: CompactVertexColumns = {
    id: Uint32Array.from(vertexIds, id => stringReference(id, indexByValue)),
    node: Uint32Array.from(vertexIds, id => denseById.get(id) ?? ABSENT),
    kind: Uint8Array.from(vertexIds, id => (
      (denseById.has(id) ? 1 : 0)
      | (entryIds.has(id) ? 2 : 0)
      | (exitIds.has(id) ? 4 : 0)
    )),
  };
  return new CompactCASGraph(
    dictionary,
    nodeColumns,
    vertexColumns,
    edgeColumns,
    buildAdjacency(vertexIds.length, edges, 'source'),
    buildAdjacency(vertexIds.length, edges, 'target'),
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
  let nodes: CASNode[];
  let edges: CanonicalEdge[];
  let vertexIds: string[];
  try {
    validateCompactCASGraphLayout(graph);
    nodes = canonicalizeNodes(cas.nodes, graph.limits);
    const allowedVertices = new Set([
      ...nodes.map(node => node.id),
      ...(cas.entry_points || []).map(entry => entry.id),
      ...(cas.exit_points || []).map(exit => exit.id),
    ]);
    vertexIds = [...allowedVertices].sort(compareStrings);
    edges = canonicalizeEdges(cas.edges, new Map(vertexIds.map((id, vertex) => [id, vertex])), graph.limits);
  } catch (error) {
    return { ok: false, errors: [error instanceof Error ? error.message : String(error)] };
  }
  if (graph.nodeCount !== nodes.length) addError(`node count ${graph.nodeCount} does not match ${nodes.length}`);
  if (graph.vertexCount !== vertexIds.length) addError(`vertex count ${graph.vertexCount} does not match ${vertexIds.length}`);
  if (graph.edgeCount !== edges.length) addError(`edge count ${graph.edgeCount} does not match ${edges.length}`);
  const originalOrdinalById = originalOrdinals(cas.nodes);
  for (let denseId = 0; denseId < Math.min(graph.nodeCount, nodes.length) && errors.length < maxErrors; denseId += 1) {
    const actual = graph.nodeAt(denseId);
    const expected = nodes[denseId];
    const fields: Array<[string, unknown, unknown]> = [
      ['id', actual.id, expected.id], ['name', actual.name, expected.name], ['type', actual.type, expected.type],
      ['qualified_name', actual.qualifiedName, expected.qualified_name], ['category', actual.category, expected.category],
      ['source.file', actual.sourceFile, expected.source?.file], ['source.line', actual.sourceLine, expected.source?.line],
      ['level', actual.level, expected.level], ['level_name', actual.levelName, expected.level_name],
      ['is_test', actual.isTest, Boolean(expected.metadata?.is_test)],
      ['is_generated', actual.isGenerated, Boolean(expected.metadata?.is_generated)],
      ['original_ordinal', actual.originalOrdinal, originalOrdinalById.get(expected.id)],
      ['tags', JSON.stringify(actual.tags), JSON.stringify(expected.tags)],
    ];
    for (const [field, left, right] of fields) {
      if (left !== right) addError(`nodes.${field}[${denseId}] ${String(left)} does not match ${String(right)}`);
    }
  }
  const entryIds = new Set((cas.entry_points || []).map(entry => entry.id));
  const exitIds = new Set((cas.exit_points || []).map(exit => exit.id));
  const nodeIds = new Set(nodes.map(node => node.id));
  for (let vertex = 0; vertex < Math.min(graph.vertexCount, vertexIds.length) && errors.length < maxErrors; vertex += 1) {
    const id = graph.decodeString(graph.vertices.id[vertex]);
    const expectedId = vertexIds[vertex];
    const expectedKind = (nodeIds.has(expectedId) ? 1 : 0) | (entryIds.has(expectedId) ? 2 : 0) | (exitIds.has(expectedId) ? 4 : 0);
    if (id !== expectedId) addError(`vertices.id[${vertex}] ${String(id)} does not match ${expectedId}`);
    if (graph.vertices.kind[vertex] !== expectedKind) {
      addError(`vertices.kind[${vertex}] ${graph.vertices.kind[vertex]} does not match ${expectedKind}`);
    }
  }
  for (let ordinal = 0; ordinal < Math.min(graph.edgeCount, edges.length) && errors.length < maxErrors; ordinal += 1) {
    const actual = graph.edgeAt(ordinal);
    const expected = edges[ordinal].edge;
    for (const [field, left, right] of [
      ['id', actual.id, expected.id], ['source', actual.sourceId, expected.source],
      ['target', actual.targetId, expected.target], ['type', actual.type, expected.type],
      ['category', actual.category, expected.category],
    ] as Array<[string, unknown, unknown]>) {
      if (left !== right) addError(`edges.${field}[${ordinal}] ${String(left)} does not match ${String(right)}`);
    }
  }
  return { ok: errors.length === 0, errors };
}
