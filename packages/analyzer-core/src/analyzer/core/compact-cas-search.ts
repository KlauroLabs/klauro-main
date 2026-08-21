import type { CASOutput } from '../../types/cas.types';
import type { CompactCASGraph } from './compact-cas-graph';

const encoder = new TextEncoder();
const EMPTY_POSTING = new Uint32Array(0);
export const COMPACT_CAS_SEARCH_CHUNK_NODES = 1024;

export interface CompactCASSearchIndex {
  textChunkNodes: number;
  descriptionBytes: Uint8Array;
  descriptionOffsets: Uint32Array;
  postings: Map<string, Uint32Array>;
}

export interface CompactCASSearchHotIndex {
  textChunkNodes: number;
  descriptionOffsets: Uint32Array;
}

export interface CompactCASSearchText {
  description: string;
}

export interface CompactCASSearchOptions {
  type?: string;
  category?: string;
  level?: number;
  file?: string;
  limit?: number;
}

export interface CompactCASSearchResult {
  id: string;
  name: string;
  type: string;
  qualified_name?: string;
  category?: string;
  level?: number;
  level_name?: string;
  file?: string;
  line?: number;
  description?: string;
  tags?: string[];
}

export type CompactCASPostingReader = (keys: readonly string[]) => Promise<Map<string, Uint32Array>>;
export const COMPACT_CAS_SEARCH_SHARDS = 256;

const SEARCH_STOPWORDS = new Set([
  'a', 'an', 'the', 'of', 'on', 'in', 'to', 'for', 'with', 'and', 'or', 'is',
  'are', 'that', 'this', 'where', 'do', 'we', 'from', 'into', 'until', 'by',
  'before', 'given', 'as', 'at', 'it', 'its', 'their', 'your', 'be', 'has',
]);

const SEARCH_TYPE_PRIORITY: Record<string, number> = {
  class: 0, service: 0, controller: 0, module: 0, gateway: 0,
  function: 1, method: 1, custom_hook: 1, functional_component: 1, react_page: 1,
  entity: 2, repository: 2, guard: 2, middleware: 2, interceptor: 2, dto: 2,
  variable: 3, constant_util: 3, property: 3, function_util: 3,
  import: 4,
};

function splitCamelCase(value: string): string[] {
  return value
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[-_./]/g, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

function matchesWordBoundary(value: string, queryWords: string[]): boolean {
  const words = splitCamelCase(value);
  return queryWords.every(queryWord => words.some(word => word.includes(queryWord)));
}

function* iterateSearchTokens(value: string): Generator<string> {
  let token = '';
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    const code = character.charCodeAt(0);
    const isUpper = code >= 65 && code <= 90;
    const isLower = code >= 97 && code <= 122;
    const isDigit = code >= 48 && code <= 57;
    if (!isUpper && !isLower && !isDigit) {
      if (token) yield token;
      token = '';
      continue;
    }
    const previous = index > 0 ? value.charCodeAt(index - 1) : 0;
    const previousIsLowerOrDigit = (previous >= 97 && previous <= 122) || (previous >= 48 && previous <= 57);
    if (isUpper && previousIsLowerOrDigit) {
      if (token) yield token;
      token = '';
    }
    token += character.toLowerCase();
  }
  if (token) yield token;
}

function* iterateGrams(prefix: 'n' | 'q' | 'd', value: string): Generator<string> {
  const lower = value.toLowerCase();
  for (let width = 1; width <= Math.min(3, lower.length); width += 1) {
    for (let index = 0; index <= lower.length - width; index += 1) yield `${prefix}:${lower.slice(index, index + width)}`;
  }
}

export function* iterateCompactCASSearchPostings(
  cas: Pick<CASOutput, 'nodes'>,
  graph: CompactCASGraph,
): Generator<readonly [key: string, denseId: number]> {
  for (let denseId = 0; denseId < graph.nodeCount; denseId += 1) {
    const originalOrdinal = graph.nodes.originalOrdinal[denseId];
    const node = cas.nodes[originalOrdinal];
    if (!node || graph.decodeString(graph.nodes.id[denseId]) !== node.id) {
      throw new Error(`Compact CAS search source does not match dense node ${denseId}`);
    }
    const keys = new Set<string>();
    for (const key of iterateGrams('n', node.name)) keys.add(key);
    for (const key of iterateGrams('q', node.qualified_name ?? '')) keys.add(key);
    for (const key of iterateGrams('d', node.description ?? '')) keys.add(key);
    for (const value of [node.name, node.qualified_name ?? '', node.description ?? '', node.documentation?.raw ?? '']) {
      for (const token of iterateSearchTokens(value)) keys.add(`t:${token}`);
    }
    for (const comment of node.comments ?? []) {
      for (const token of iterateSearchTokens(comment.text)) keys.add(`t:${token}`);
    }
    keys.add(`f:type:${node.type}`);
    if (node.category !== undefined) keys.add(`f:category:${node.category}`);
    if (node.level !== undefined) keys.add(`f:level:${node.level}`);
    if (node.source?.file) keys.add(`f:file:${normalizeFile(node.source.file)}`);
    for (const key of keys) yield [key, denseId];
  }
}

export function encodeCompactCASSearchIndex(cas: Pick<CASOutput, 'nodes'>, graph: CompactCASGraph): CompactCASSearchIndex {
  const text = encodeCompactCASSearchText(cas, graph);
  const mutable = new Map<string, number[]>();
  for (const [key, denseId] of iterateCompactCASSearchPostings(cas, graph)) {
    const values = mutable.get(key) || [];
    if (values[values.length - 1] !== denseId) values.push(denseId);
    mutable.set(key, values);
  }
  const postings = new Map([...mutable].map(([key, values]) => [key, Uint32Array.from(values)]));
  const index = { ...text, postings };
  validateCompactCASSearchLayout(index, graph.nodeCount);
  return index;
}

export function encodeCompactCASSearchText(
  cas: Pick<CASOutput, 'nodes'>,
  graph: CompactCASGraph,
): Omit<CompactCASSearchIndex, 'postings'> {
  const descriptionOffsets = new Uint32Array(graph.nodeCount + 1);
  let descriptionByteLength = 0;
  for (let denseId = 0; denseId < graph.nodeCount; denseId += 1) {
    const node = cas.nodes[graph.nodes.originalOrdinal[denseId]];
    descriptionOffsets[denseId] = descriptionByteLength;
    descriptionByteLength += encoder.encode(node.description ?? '').byteLength;
    if (descriptionByteLength >= 0xffffffff) {
      throw new RangeError('Compact CAS search text exceeds uint32 storage');
    }
  }
  descriptionOffsets[graph.nodeCount] = descriptionByteLength;
  const descriptionBytes = new Uint8Array(descriptionByteLength);
  for (let denseId = 0; denseId < graph.nodeCount; denseId += 1) {
    const node = cas.nodes[graph.nodes.originalOrdinal[denseId]];
    encoder.encodeInto(node.description ?? '', descriptionBytes.subarray(descriptionOffsets[denseId], descriptionOffsets[denseId + 1]));
  }
  return {
    textChunkNodes: COMPACT_CAS_SEARCH_CHUNK_NODES,
    descriptionBytes,
    descriptionOffsets,
  };
}

export function compactCASPostingShard(key: string, shardCount = COMPACT_CAS_SEARCH_SHARDS): number {
  if (!Number.isSafeInteger(shardCount) || shardCount < 1 || shardCount > 65_536) throw new RangeError('shardCount is invalid');
  let hash = 0x811c9dc5;
  const bytes = encoder.encode(key);
  for (const byte of bytes) hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
  return hash % shardCount;
}

export function validateCompactCASSearchLayout(index: CompactCASSearchIndex | CompactCASSearchHotIndex, nodeCount: number): void {
  if (!Number.isSafeInteger(index.textChunkNodes) || index.textChunkNodes < 1 || index.textChunkNodes > 65_536) {
    throw new Error('Compact CAS search text chunk size is invalid');
  }
  if (index.descriptionOffsets.length !== nodeCount + 1) {
    throw new Error(`Compact CAS search description offsets length ${index.descriptionOffsets.length} does not match ${nodeCount + 1}`);
  }
  validateOffsets('description offsets', index.descriptionOffsets, 'descriptionBytes' in index ? index.descriptionBytes.byteLength : index.descriptionOffsets[nodeCount]);
  if ('postings' in index) {
    for (const [key, ordinals] of index.postings) validatePosting(key, ordinals, nodeCount);
  }
}

export function validatePosting(key: string, ordinals: Uint32Array, nodeCount: number): void {
  let previous = -1;
  for (let index = 0; index < ordinals.length; index += 1) {
    const ordinal = ordinals[index];
    if (ordinal >= nodeCount) throw new Error(`Compact CAS search posting '${key}' ordinal ${ordinal} is outside ${nodeCount}`);
    if (ordinal <= previous) throw new Error(`Compact CAS search posting '${key}' is not strictly ordered at ${index}`);
    previous = ordinal;
  }
}

function postingIncludes(ordinals: Uint32Array, denseId: number): boolean {
  let low = 0;
  let high = ordinals.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const candidate = ordinals[middle];
    if (candidate === denseId) return true;
    if (candidate < denseId) low = middle + 1;
    else high = middle - 1;
  }
  return false;
}

function validateOffsets(name: string, offsets: Uint32Array, terminal: number): void {
  if (offsets.length === 0 || offsets[0] !== 0) throw new Error(`Compact CAS search ${name} must start at zero`);
  for (let index = 1; index < offsets.length; index += 1) {
    if (offsets[index] < offsets[index - 1]) throw new Error(`Compact CAS search ${name} must be monotone at index ${index}`);
  }
  if (offsets[offsets.length - 1] !== terminal) throw new Error(`Compact CAS search ${name} must end at ${terminal}`);
}

function queryGrams(value: string): string[] {
  const lower = value.toLowerCase();
  const width = Math.min(3, lower.length);
  if (width === 0) return [];
  return [...new Set(Array.from({ length: lower.length - width + 1 }, (_, index) => lower.slice(index, index + width)))];
}

function intersectPostings(lists: readonly Uint32Array[]): Iterable<number> {
  return {
    *[Symbol.iterator](): Generator<number> {
      if (lists.length === 0 || lists.some(list => list.length === 0)) return;
      const offsets = new Uint32Array(lists.length);
      while (true) {
        let candidate = 0;
        for (let index = 0; index < lists.length; index += 1) {
          if (offsets[index] >= lists[index].length) return;
          candidate = Math.max(candidate, lists[index][offsets[index]]);
        }
        let aligned = true;
        for (let index = 0; index < lists.length; index += 1) {
          while (offsets[index] < lists[index].length && lists[index][offsets[index]] < candidate) offsets[index] += 1;
          if (offsets[index] >= lists[index].length) return;
          if (lists[index][offsets[index]] !== candidate) aligned = false;
        }
        if (!aligned) continue;
        yield candidate;
        for (let index = 0; index < lists.length; index += 1) offsets[index] += 1;
      }
    },
  };
}

function unionPostings(groups: readonly Iterable<number>[]): Iterable<number> {
  return {
    *[Symbol.iterator](): Generator<number> {
      const iterators = groups.map(group => group[Symbol.iterator]());
      const current = iterators.map(iterator => iterator.next());
      while (current.some(item => !item.done)) {
        let next = Number.MAX_SAFE_INTEGER;
        for (const item of current) if (!item.done && item.value < next) next = item.value;
        yield next;
        for (let index = 0; index < current.length; index += 1) {
          while (!current[index].done && current[index].value === next) current[index] = iterators[index].next();
        }
      }
    },
  };
}

function normalizeFile(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '');
}

export async function searchCompactCAS(
  graph: CompactCASGraph,
  index: CompactCASSearchHotIndex,
  query: string,
  readPostings: CompactCASPostingReader,
  readSearchText: (denseIds: readonly number[]) => Promise<Map<number, CompactCASSearchText>>,
  options: CompactCASSearchOptions = {},
): Promise<CompactCASSearchResult[]> {
  if (query.length > 1024 || new TextEncoder().encode(query).byteLength > 4096) {
    throw new RangeError('Compact CAS search query exceeds its 4096-byte limit');
  }
  validateCompactCASSearchLayout(index, graph.nodeCount);
  const limit = options.limit || 25;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > graph.limits.maxPageSize) {
    throw new RangeError(`limit must be an integer from 1 through ${graph.limits.maxPageSize}`);
  }
  const queryLower = query.toLowerCase();
  const queryWords = queryLower.split(/\s+/).filter(Boolean);
  const contentWords = queryWords.filter(word => word.length > 1 && !SEARCH_STOPWORDS.has(word));
  const literalGrams = queryGrams(queryLower);
  const camelGrams = queryWords.flatMap(queryGrams);
  const filterKeys = [
    options.type !== undefined ? `f:type:${options.type}` : undefined,
    options.category !== undefined ? `f:category:${options.category}` : undefined,
    options.level !== undefined ? `f:level:${options.level}` : undefined,
    options.file !== undefined ? `f:file:${normalizeFile(options.file)}` : undefined,
  ].filter((key): key is string => Boolean(key));
  const groups = [
    ...(['n', 'q', 'd'] as const).map(prefix => literalGrams.map(gram => `${prefix}:${gram}`)),
    ...(queryWords.length > 1 ? (['n', 'q'] as const).map(prefix => camelGrams.map(gram => `${prefix}:${gram}`)) : []),
    ...contentWords.map(word => [`t:${word}`]),
  ].filter(group => group.length > 0);
  const filteredGroups = groups.map(group => [...group, ...filterKeys]);
  const keys = [...new Set(filteredGroups.flat())];
  const postings = await readPostings(keys);
  const contentPostings = contentWords.map(word => postings.get(`t:${word}`) || EMPTY_POSTING);
  const candidates = unionPostings(filteredGroups.map(group => intersectPostings(group.map(key => postings.get(key) || new Uint32Array(0)))));
  const requestedFile = options.file ? normalizeFile(options.file) : undefined;
  type Ranked = { denseId: number; score: number; typeRank: number; originalOrdinal: number; description: string };
  const exact: Ranked[] = [];
  const overlapping: Ranked[] = [];
  const exactOrder = (left: Ranked, right: Ranked): number => left.score - right.score || left.typeRank - right.typeRank || left.originalOrdinal - right.originalOrdinal;
  const overlapOrder = (left: Ranked, right: Ranked): number => right.score - left.score || left.typeRank - right.typeRank || left.originalOrdinal - right.originalOrdinal;
  const retain = (items: Ranked[], item: Ranked, compare: (left: Ranked, right: Ranked) => number): void => {
    items.push(item);
    items.sort(compare);
    if (items.length > limit) items.length = limit;
  };
  let chunk: number[] = [];
  const processChunk = async (): Promise<void> => {
    if (chunk.length === 0) return;
    const texts = await readSearchText(chunk);
    for (const denseId of chunk) {
      const node = graph.nodeAt(denseId);
      if (options.type && node.type !== options.type) continue;
      if (options.category && node.category !== options.category) continue;
      if (options.level !== undefined && node.level !== options.level) continue;
      if (requestedFile && (!node.sourceFile || normalizeFile(node.sourceFile) !== requestedFile)) continue;
      const searchText = texts.get(denseId) ?? { description: '' };
      const nameLower = node.name.toLowerCase();
      const qualifiedLower = node.qualifiedName?.toLowerCase();
      const direct = nameLower.includes(queryLower) || Boolean(qualifiedLower?.includes(queryLower)) || searchText.description.toLowerCase().includes(queryLower);
      const camel = queryWords.length > 1 && (matchesWordBoundary(node.name, queryWords) || Boolean(node.qualifiedName && matchesWordBoundary(node.qualifiedName, queryWords)));
      const typeRank = SEARCH_TYPE_PRIORITY[node.type] ?? 3;
      if (direct || camel) {
        const rank = nameLower === queryLower || qualifiedLower === queryLower ? 0 : nameLower.startsWith(queryLower) ? 1 : nameLower.includes(queryLower) ? 2 : 3;
        retain(exact, { denseId, score: rank, typeRank, originalOrdinal: node.originalOrdinal, description: searchText.description }, exactOrder);
      } else if (contentWords.length > 0) {
        let overlap = 0;
        for (const ordinals of contentPostings) if (postingIncludes(ordinals, denseId)) overlap += 1;
        if (overlap > 0) retain(overlapping, { denseId, score: overlap, typeRank, originalOrdinal: node.originalOrdinal, description: searchText.description }, overlapOrder);
      }
    }
    chunk = [];
  };
  let activeTextChunk = -1;
  for (const denseId of candidates) {
    const textChunk = Math.floor(denseId / index.textChunkNodes);
    if (activeTextChunk !== -1 && textChunk !== activeTextChunk) await processChunk();
    activeTextChunk = textChunk;
    chunk.push(denseId);
  }
  await processChunk();
  return [...exact, ...overlapping].slice(0, limit).map(({ denseId, description }) => {
    const node = graph.nodeAt(denseId);
    return {
      id: node.id, name: node.name, type: node.type, qualified_name: node.qualifiedName,
      category: node.category, level: node.level, level_name: node.levelName,
      file: node.sourceFile, line: node.sourceLine, description: description || undefined, tags: node.tags,
    };
  });
}
