import * as crypto from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'fs-extra';
import pLimit from 'p-limit';
import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import {
  createCasSectionManifest,
  selectExactCasSection,
  type CasRawColumnDescriptor,
  type CasSectionManifest,
} from './cas-sections';
import {
  CompactCASGraph,
  encodeCompactCASGraph,
  validateCompactCASParity,
  type CompactCASGraphLimits,
} from '../../../packages/analyzer-core/src/analyzer/core/compact-cas-graph';
import {
  COMPACT_CAS_SEARCH_CHUNK_NODES,
  compactCASPostingShard,
  encodeCompactCASSearchText,
  validateCompactCASSearchLayout,
  type CompactCASPostingReader,
  type CompactCASSearchHotIndex,
  type CompactCASSearchText,
} from '../../../packages/analyzer-core/src/analyzer/core/compact-cas-search';
import { buildCompactCASPostingArtifacts, decodeCompactCASPostingShard } from './compact-cas-search-storage';

interface SegmentedAnalysisPointer {
  manifest_version: 1;
  revision: string;
}

type JsonWriter = (
  filePath: string,
  value: unknown,
  options?: { spaces?: number },
) => Promise<void>;

export function segmentedAnalysisRoot(filePath: string): string {
  return `${filePath}.sections`;
}

export async function writeSegmentedAnalysis(
  filePath: string,
  output: CASOutput,
  extension: string,
  writeCompressedJson: JsonWriter,
  writeJson: JsonWriter,
  isCurrent: () => boolean = () => true,
): Promise<void> {
  if (!isCurrent()) return;
  const root = segmentedAnalysisRoot(filePath);
  const revision = `rev-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
  const revisionDir = path.join(root, revision);
  const tmpDir = `${revisionDir}.tmp`;
  const manifest = createCasSectionManifest(output);
  try {
    await fs.ensureDir(tmpDir);
    const writeSection = pLimit(2);
    await Promise.all(manifest.sections.map(descriptor => writeSection(async () => {
      const sectionFile = `${descriptor.name}.json${extension}`;
      const sectionPath = path.join(tmpDir, sectionFile);
      await writeCompressedJson(sectionPath, selectExactCasSection(output, descriptor.name), { spaces: 0 });
      const stat = await fs.stat(sectionPath);
      descriptor.file = sectionFile;
      descriptor.bytes = stat.size;
    })));
    const compactStartedAt = Date.now();
    const compactGraph = encodeCompactCASGraph(output);
    const parity = validateCompactCASParity(compactGraph, output);
    if (!parity.ok) throw new Error(`Compact CAS graph parity failed: ${parity.errors.join('; ')}`);
    const writeCompactColumn = async (
      columns: Record<string, CasRawColumnDescriptor>,
      prefix: string,
      name: string,
      values: Uint8Array | Uint32Array,
    ): Promise<void> => {
      const encoding = values instanceof Uint32Array ? 'uint32-le' : 'uint8';
      const bytes = encoding === 'uint8'
        ? Buffer.from(values.buffer, values.byteOffset, values.byteLength)
        : encodeUint32LittleEndian(values as Uint32Array);
      const file = `${prefix}.${name}.bin`;
      await fs.writeFile(path.join(tmpDir, file), bytes);
      columns[name] = {
        file,
        encoding,
        length: values.length,
        bytes: bytes.byteLength,
        sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      };
    };
    const compactColumns: NonNullable<CasSectionManifest['compact_graph']>['columns'] = {};
    await writeCompactColumn(compactColumns, 'graph', 'dictionary.bytes', compactGraph.dictionary.bytes);
    await writeCompactColumn(compactColumns, 'graph', 'dictionary.offsets', compactGraph.dictionary.offsets);
    for (const [name, values] of Object.entries(compactGraph.nodes)) await writeCompactColumn(compactColumns, 'graph', `nodes.${name}`, values);
    for (const [name, values] of Object.entries(compactGraph.vertices)) await writeCompactColumn(compactColumns, 'graph', `vertices.${name}`, values);
    for (const [name, values] of Object.entries(compactGraph.edges)) await writeCompactColumn(compactColumns, 'graph', `edges.${name}`, values);
    await writeCompactColumn(compactColumns, 'graph', 'outgoing.offsets', compactGraph.outgoing.offsets);
    await writeCompactColumn(compactColumns, 'graph', 'outgoing.edgeOrdinals', compactGraph.outgoing.edgeOrdinals);
    await writeCompactColumn(compactColumns, 'graph', 'incoming.offsets', compactGraph.incoming.offsets);
    await writeCompactColumn(compactColumns, 'graph', 'incoming.edgeOrdinals', compactGraph.incoming.edgeOrdinals);
    manifest.compact_graph = {
      format: 'klauro-compact-cas-graph',
      version: 1,
      node_count: compactGraph.nodeCount,
      vertex_count: compactGraph.vertexCount,
      edge_count: compactGraph.edgeCount,
      limits: compactGraph.limits,
      columns: compactColumns,
    };
    const compactSearch = encodeCompactCASSearchText(output, compactGraph);
    const searchColumns: NonNullable<CasSectionManifest['compact_search']>['columns'] = {};
    await writeCompactColumn(searchColumns, 'search', 'description.offsets', compactSearch.descriptionOffsets);
    await writeCompactColumn(searchColumns, 'search', 'auxiliaryText.offsets', compactSearch.auxiliaryTextOffsets);
    for (let start = 0; start < compactGraph.nodeCount; start += COMPACT_CAS_SEARCH_CHUNK_NODES) {
      const end = Math.min(start + COMPACT_CAS_SEARCH_CHUNK_NODES, compactGraph.nodeCount);
      const byteStart = compactSearch.descriptionOffsets[start];
      const byteEnd = compactSearch.descriptionOffsets[end];
      await writeCompactColumn(
        searchColumns,
        'search',
        `description.chunks.${Math.floor(start / COMPACT_CAS_SEARCH_CHUNK_NODES)}`,
        compactSearch.descriptionBytes.subarray(byteStart, byteEnd),
      );
      const auxiliaryByteStart = compactSearch.auxiliaryTextOffsets[start];
      const auxiliaryByteEnd = compactSearch.auxiliaryTextOffsets[end];
      await writeCompactColumn(
        searchColumns,
        'search',
        `auxiliaryText.chunks.${Math.floor(start / COMPACT_CAS_SEARCH_CHUNK_NODES)}`,
        compactSearch.auxiliaryTextBytes.subarray(auxiliaryByteStart, auxiliaryByteEnd),
      );
    }
    const postingArtifacts = await buildCompactCASPostingArtifacts(output, compactGraph, tmpDir);
    Object.assign(searchColumns, postingArtifacts.columns);
    manifest.compact_search = {
      format: 'klauro-compact-cas-search',
      version: 2,
      node_count: compactGraph.nodeCount,
      description_chunk_nodes: COMPACT_CAS_SEARCH_CHUNK_NODES,
      shard_count: postingArtifacts.shardCount,
      nonempty_shards: Object.keys(postingArtifacts.columns).map(name => Number(name.slice(name.lastIndexOf('.') + 1))).sort((left, right) => left - right),
      posting_records: postingArtifacts.recordCount,
      posting_runs: postingArtifacts.runCount,
      columns: searchColumns,
    };
    const compactDurationMs = Date.now() - compactStartedAt;
    if (compactDurationMs >= 1_000) {
      process.stderr.write(`${JSON.stringify({
        event: 'compact_cas_sidecar_built',
        duration_ms: compactDurationMs,
        graph_bytes: Object.values(compactColumns).reduce((sum, column) => sum + column.bytes, 0),
        search_bytes: Object.values(searchColumns).reduce((sum, column) => sum + column.bytes, 0),
        posting_records: postingArtifacts.recordCount,
        posting_runs: postingArtifacts.runCount,
        rss_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
        max_rss_mb: Math.round(process.resourceUsage().maxRSS / 1024),
      })}\n`);
    }
    await writeJson(path.join(tmpDir, 'manifest.json'), manifest, { spaces: 2 });
    if (!isCurrent()) return;
    await fs.ensureDir(root);
    await fs.move(tmpDir, revisionDir, { overwrite: false });
    if (!isCurrent()) {
      await fs.remove(revisionDir).catch(() => undefined);
      return;
    }
    await writeJson(path.join(root, 'current.json'), {
      manifest_version: 1,
      revision,
    } satisfies SegmentedAnalysisPointer, { spaces: 2 });
    if (!isCurrent()) {
      const currentPath = path.join(root, 'current.json');
      const current = await fs.readJson(currentPath).catch(() => null) as SegmentedAnalysisPointer | null;
      if (current?.revision === revision) await fs.remove(currentPath).catch(() => undefined);
      await fs.remove(revisionDir).catch(() => undefined);
      return;
    }
    const revisions = (await fs.readdir(root).catch(() => []))
      .filter(name => name.startsWith('rev-') && !name.endsWith('.tmp'))
      .sort()
      .reverse();
    for (const stale of revisions.slice(2)) await fs.remove(path.join(root, stale)).catch(() => undefined);
  } finally {
    await fs.remove(tmpDir).catch(() => undefined);
  }
}

function encodeUint32LittleEndian(values: Uint32Array): Buffer {
  const bytes = Buffer.allocUnsafe(values.length * 4);
  for (let index = 0; index < values.length; index += 1) bytes.writeUInt32LE(values[index], index * 4);
  return bytes;
}

function decodeUint32LittleEndian(bytes: Buffer, length: number, field: string): Uint32Array {
  if (bytes.byteLength !== length * 4) throw new Error(`Compact CAS graph column ${field} has an invalid byte length`);
  if (os.endianness() === 'LE' && bytes.byteOffset % 4 === 0) {
    return new Uint32Array(bytes.buffer, bytes.byteOffset, length);
  }
  const values = new Uint32Array(length);
  for (let index = 0; index < length; index += 1) values[index] = bytes.readUInt32LE(index * 4);
  return values;
}

export async function loadCompactCASGraph(filePath: string): Promise<CompactCASGraph | null> {
  const segmented = await resolveSegmentedAnalysis(filePath);
  const descriptor = segmented?.manifest.compact_graph;
  if (!segmented || !descriptor) return null;
  if (descriptor.format !== 'klauro-compact-cas-graph' || descriptor.version !== 1) {
    throw new Error('Compact CAS graph format or version is unsupported');
  }
  const loaded = new Map<string, Uint8Array | Uint32Array>();
  for (const [name, column] of Object.entries(descriptor.columns)) {
    loaded.set(name, await readRawColumn(segmented.directory, name, column, 'graph'));
  }
  const u8 = (name: string): Uint8Array => requiredColumn(loaded, name, Uint8Array);
  const u32 = (name: string): Uint32Array => requiredColumn(loaded, name, Uint32Array);
  const graph = new CompactCASGraph(
    { bytes: u8('dictionary.bytes'), offsets: u32('dictionary.offsets') },
    {
      originalOrdinal: u32('nodes.originalOrdinal'), vertex: u32('nodes.vertex'),
      id: u32('nodes.id'), name: u32('nodes.name'), type: u32('nodes.type'),
      qualifiedName: u32('nodes.qualifiedName'), category: u32('nodes.category'),
      sourceFile: u32('nodes.sourceFile'), sourceLine: u32('nodes.sourceLine'),
      level: u32('nodes.level'), levelName: u32('nodes.levelName'), flags: u32('nodes.flags'),
      tagOffsets: u32('nodes.tagOffsets'), tagReferences: u32('nodes.tagReferences'),
    },
    { id: u32('vertices.id'), node: u32('vertices.node'), kind: u8('vertices.kind') },
    {
      id: u32('edges.id'), source: u32('edges.source'), target: u32('edges.target'),
      type: u32('edges.type'), category: u32('edges.category'),
    },
    { offsets: u32('outgoing.offsets'), edgeOrdinals: u32('outgoing.edgeOrdinals') },
    { offsets: u32('incoming.offsets'), edgeOrdinals: u32('incoming.edgeOrdinals') },
    descriptor.limits as CompactCASGraphLimits,
  );
  if (graph.nodeCount !== descriptor.node_count || graph.vertexCount !== descriptor.vertex_count || graph.edgeCount !== descriptor.edge_count) {
    throw new Error('Compact CAS graph cardinality does not match its manifest');
  }
  return graph;
}

export interface LoadedCompactCASSearch {
  graph: CompactCASGraph;
  index: CompactCASSearchHotIndex;
  analysisTimestamp: string;
  readPostings: CompactCASPostingReader;
  readSearchText(denseIds: readonly number[]): Promise<Map<number, CompactCASSearchText>>;
}

export async function loadCompactCASSearch(filePath: string): Promise<LoadedCompactCASSearch | null> {
  const segmented = await resolveSegmentedAnalysis(filePath);
  const descriptor = segmented?.manifest.compact_search;
  if (!segmented || !descriptor) return null;
  if (descriptor.format !== 'klauro-compact-cas-search' || descriptor.version !== 2) {
    throw new Error('Compact CAS search format or version is unsupported');
  }
  const graph = await loadCompactCASGraph(filePath);
  if (!graph) throw new Error('Compact CAS search exists without its compact graph');
  if (descriptor.node_count !== graph.nodeCount) throw new Error('Compact CAS search cardinality does not match its graph');
  if (!Number.isSafeInteger(descriptor.description_chunk_nodes) || descriptor.description_chunk_nodes < 1) {
    throw new Error('Compact CAS search description chunk size is invalid');
  }
  const loaded = new Map<string, Uint8Array | Uint32Array>();
  for (const name of [
    'description.offsets',
    'auxiliaryText.offsets',
  ]) {
    const column = descriptor.columns[name];
    if (!column) throw new Error(`Compact CAS search column '${name}' is missing from the manifest`);
    loaded.set(name, await readRawColumn(segmented.directory, name, column, 'search'));
  }
  const u32 = (name: string): Uint32Array => requiredColumn(loaded, name, Uint32Array);
  const index: CompactCASSearchHotIndex = {
    textChunkNodes: descriptor.description_chunk_nodes,
    descriptionOffsets: u32('description.offsets'),
    auxiliaryTextOffsets: u32('auxiliaryText.offsets'),
  };
  validateCompactCASSearchLayout(index, graph.nodeCount);
  if (!Number.isSafeInteger(descriptor.shard_count) || descriptor.shard_count < 1 || descriptor.shard_count > 65_536) {
    throw new Error('Compact CAS search shard count is invalid');
  }
  if (!Array.isArray(descriptor.nonempty_shards)) throw new Error('Compact CAS search nonempty shard list is missing');
  if (!Number.isSafeInteger(descriptor.posting_records) || descriptor.posting_records < 0
    || !Number.isSafeInteger(descriptor.posting_runs) || descriptor.posting_runs < 0) {
    throw new Error('Compact CAS search posting build metadata is invalid');
  }
  let previousShard = -1;
  for (const shard of descriptor.nonempty_shards) {
    if (!Number.isSafeInteger(shard) || shard <= previousShard || shard >= descriptor.shard_count) {
      throw new Error('Compact CAS search nonempty shard list is invalid');
    }
    if (!descriptor.columns[`postings.shard.${shard}`]) throw new Error(`Compact CAS search posting shard ${shard} is missing`);
    previousShard = shard;
  }
  for (const name of Object.keys(descriptor.columns).filter(name => name.startsWith('postings.shard.'))) {
    const shard = Number(name.slice(name.lastIndexOf('.') + 1));
    if (!descriptor.nonempty_shards.includes(shard)) throw new Error(`Compact CAS search posting shard ${shard} is not declared nonempty`);
  }
  for (let start = 0; start < graph.nodeCount; start += descriptor.description_chunk_nodes) {
    const end = Math.min(start + descriptor.description_chunk_nodes, graph.nodeCount);
    const chunk = Math.floor(start / descriptor.description_chunk_nodes);
    for (const [prefix, offsets] of [
      ['description', index.descriptionOffsets],
      ['auxiliaryText', index.auxiliaryTextOffsets],
    ] as const) {
      const name = `${prefix}.chunks.${chunk}`;
      const column = descriptor.columns[name];
      if (!column || column.encoding !== 'uint8') throw new Error(`Compact CAS search column '${name}' is missing or has the wrong encoding`);
      const expectedBytes = offsets[end] - offsets[start];
      if (column.length !== expectedBytes || column.bytes !== expectedBytes) {
        throw new Error(`Compact CAS search column '${name}' length does not match its text offsets`);
      }
    }
  }
  return {
    graph,
    index,
    analysisTimestamp: segmented.manifest.analysis_timestamp,
    readPostings: keys => readPostingShards(segmented.directory, descriptor, keys),
    readSearchText: denseIds => readSearchTextChunks(segmented.directory, descriptor, index, denseIds),
  };
}

async function readPostingShards(
  directory: string,
  descriptor: NonNullable<CasSectionManifest['compact_search']>,
  keys: readonly string[],
): Promise<Map<string, Uint32Array>> {
  const requestedByShard = new Map<number, Set<string>>();
  for (const key of new Set(keys)) {
    const shard = compactCASPostingShard(key, descriptor.shard_count);
    const requested = requestedByShard.get(shard) || new Set<string>();
    requested.add(key);
    requestedByShard.set(shard, requested);
  }
  const nonempty = new Set(descriptor.nonempty_shards);
  const result = new Map<string, Uint32Array>();
  for (const [shard, requested] of requestedByShard) {
    if (!nonempty.has(shard)) continue;
    const name = `postings.shard.${shard}`;
    const column = descriptor.columns[name];
    if (!column) throw new Error(`Compact CAS search posting shard ${shard} is missing`);
    const bytes = await readRawColumn(directory, name, column, 'search');
    if (!(bytes instanceof Uint8Array) || bytes instanceof Uint32Array) throw new Error(`Compact CAS search posting shard ${shard} has the wrong encoding`);
    for (const [key, ordinals] of decodeCompactCASPostingShard(bytes, requested, descriptor.node_count)) result.set(key, ordinals);
  }
  return result;
}

async function readSearchTextChunks(
  directory: string,
  descriptor: NonNullable<CasSectionManifest['compact_search']>,
  index: CompactCASSearchHotIndex,
  denseIds: readonly number[],
): Promise<Map<number, CompactCASSearchText>> {
  const requested = [...new Set(denseIds)].sort((left, right) => left - right);
  const byChunk = new Map<number, number[]>();
  for (const denseId of requested) {
    if (!Number.isSafeInteger(denseId) || denseId < 0 || denseId >= descriptor.node_count) {
      throw new RangeError(`Dense node id ${denseId} is outside the compact search index`);
    }
    const chunk = Math.floor(denseId / descriptor.description_chunk_nodes);
    const entries = byChunk.get(chunk) || [];
    entries.push(denseId);
    byChunk.set(chunk, entries);
  }
  const descriptions = new Map<number, { description: string; auxiliaryText: string }>();
  const decoder = new TextDecoder();
  for (const [chunk, ordinals] of byChunk) {
    const firstDenseId = chunk * descriptor.description_chunk_nodes;
    const loadChunk = async (prefix: 'description' | 'auxiliaryText'): Promise<{ bytes: Uint8Array; offsets: Uint32Array }> => {
      const name = `${prefix}.chunks.${chunk}`;
      const column = descriptor.columns[name];
      if (!column) throw new Error(`Compact CAS search column '${name}' is missing from the manifest`);
      const bytes = await readRawColumn(directory, name, column, 'search');
      if (!(bytes instanceof Uint8Array) || bytes instanceof Uint32Array) {
        throw new Error(`Compact CAS search column '${name}' has the wrong encoding`);
      }
      return { bytes, offsets: prefix === 'description' ? index.descriptionOffsets : index.auxiliaryTextOffsets };
    };
    const descriptionChunk = await loadChunk('description');
    const auxiliaryTextChunk = await loadChunk('auxiliaryText');
    for (const denseId of ordinals) {
      const decode = (chunkData: { bytes: Uint8Array; offsets: Uint32Array }): string => {
        const chunkByteStart = chunkData.offsets[firstDenseId];
        return decoder.decode(chunkData.bytes.subarray(
          chunkData.offsets[denseId] - chunkByteStart,
          chunkData.offsets[denseId + 1] - chunkByteStart,
        ));
      };
      descriptions.set(denseId, {
        description: decode(descriptionChunk),
        auxiliaryText: decode(auxiliaryTextChunk),
      });
    }
  }
  return descriptions;
}

async function readRawColumn(
  directory: string,
  name: string,
  column: CasRawColumnDescriptor,
  kind: 'graph' | 'search',
): Promise<Uint8Array | Uint32Array> {
  if (path.basename(column.file) !== column.file) throw new Error(`Compact CAS ${kind} column '${name}' has an invalid file path`);
  const describedBytes = column.encoding === 'uint8' ? column.length : column.length * 4;
  if (!Number.isSafeInteger(column.length) || column.length < 0 || describedBytes !== column.bytes) {
    throw new Error(`Compact CAS ${kind} column '${name}' has inconsistent length metadata`);
  }
  const bytes = await fs.readFile(path.join(directory, column.file)).catch(error => {
    throw new Error(`Compact CAS ${kind} column '${name}' is missing: ${error instanceof Error ? error.message : String(error)}`);
  });
  if (bytes.byteLength !== column.bytes) {
    throw new Error(`Compact CAS ${kind} column '${name}' byte length ${bytes.byteLength} does not match ${column.bytes}`);
  }
  const checksum = crypto.createHash('sha256').update(bytes).digest('hex');
  if (checksum !== column.sha256) throw new Error(`Compact CAS ${kind} column '${name}' checksum mismatch`);
  return column.encoding === 'uint8'
    ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    : decodeUint32LittleEndian(bytes, column.length, name);
}

function requiredColumn<T extends Uint8Array | Uint32Array>(
  columns: Map<string, Uint8Array | Uint32Array>,
  name: string,
  expected: typeof Uint8Array | typeof Uint32Array,
): T {
  const value = columns.get(name);
  if (!value || !(value instanceof expected)) throw new Error(`Compact CAS graph column '${name}' is missing or has the wrong encoding`);
  return value as T;
}

export async function resolveSegmentedAnalysis(
  filePath: string,
): Promise<{ directory: string; manifest: CasSectionManifest } | null> {
  const root = segmentedAnalysisRoot(filePath);
  try {
    const pointer = await fs.readJson(path.join(root, 'current.json')) as SegmentedAnalysisPointer;
    if (pointer.manifest_version !== 1 || !pointer.revision) return null;
    const directory = path.join(root, pointer.revision);
    const manifest = await fs.readJson(path.join(directory, 'manifest.json')) as CasSectionManifest;
    if (manifest.manifest_version !== 1) return null;
    return { directory, manifest };
  } catch {
    return null;
  }
}
