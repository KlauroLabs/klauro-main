import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import type { CASEdge, CASNode, CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import type { CompactCASGraph } from '../../../packages/analyzer-core/src/analyzer/core/compact-cas-graph';
import type { CasRawColumnDescriptor } from './cas-sections';

export const CAS_RECORD_STORE_FORMAT = 'klauro-cas-record-store';
export const CAS_RECORD_STORE_VERSION = 4;
export const CAS_RECORD_STORE_MAX_BLOCK_RECORDS = 256;
export const CAS_RECORD_STORE_TARGET_BLOCK_BYTES = 1024 * 1024;
export const CAS_RECORD_STORE_MAX_BLOCK_BYTES = 16 * 1024 * 1024;
export const CAS_RECORD_STORE_MAX_RECORD_BYTES = CAS_RECORD_STORE_MAX_BLOCK_BYTES;
export const CAS_RECORD_STORE_MAX_BLOCK_COMPRESSED_BYTES = CAS_RECORD_STORE_MAX_BLOCK_BYTES + 1024 * 1024;
const MAX_TABLE_BYTES = 0xffffffff;
const MAX_TABLE_RECORDS = 8_000_000;
const SHA256_BYTES = 32;
const UINT32_BYTES = 4;
const INDEX_COLUMNS = ['blockOffsets', 'blockRecords', 'recordOffsets', 'blockChecksums'] as const;
const RECORD_MAP_COLUMN = 'recordMap';

export interface CasRecordStoreTable {
  count: number;
  blocks: number;
  max_block_records: number;
  max_block_bytes: number;
  columns: Record<string, CasRawColumnDescriptor>;
}

export interface CasRecordStoreDescriptor {
  format: typeof CAS_RECORD_STORE_FORMAT;
  version: typeof CAS_RECORD_STORE_VERSION;
  codec: 'brotli';
  nodes: CasRecordStoreTable;
  edges: CasRecordStoreTable;
}

export interface CasRecordStoreReadBudget {
  maxRecords: number;
  maxDecodedBytes: number;
  maxCompressedBytes: number;
  maxIndexBytes: number;
  cacheBytes: number;
}

export interface CasRecordStoreReadStats {
  indexBytes: number;
  records: number;
  blocksPlanned: number;
  blockReads: number;
  cacheHits: number;
  compressedBytesPlanned: number;
  compressedBytesRead: number;
  decodedBytes: number;
}

export const DEFAULT_RECORD_STORE_READ_BUDGET: CasRecordStoreReadBudget = {
  maxRecords: 25_000,
  maxDecodedBytes: 64 * 1024 * 1024,
  maxCompressedBytes: 64 * 1024 * 1024,
  maxIndexBytes: 64 * 1024 * 1024,
  cacheBytes: 32 * 1024 * 1024,
};

export function isSupportedCasRecordStoreDescriptor(descriptor: unknown): descriptor is CasRecordStoreDescriptor {
  return !!descriptor && typeof descriptor === 'object'
    && (descriptor as CasRecordStoreDescriptor).format === CAS_RECORD_STORE_FORMAT
    && (descriptor as CasRecordStoreDescriptor).version === CAS_RECORD_STORE_VERSION
    && (descriptor as CasRecordStoreDescriptor).codec === 'brotli';
}

export class CasRecordStoreCapacityError extends Error {
  readonly code = 'cas_record_store_capacity_exhausted';
}

export function edgeRecordKey(edge: Pick<CASEdge, 'id' | 'source' | 'target' | 'type' | 'category'>): string {
  return JSON.stringify([edge.source, edge.target, edge.type, edge.id, edge.category ?? null]);
}

function sha256(bytes: Uint8Array): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function uint32ToBuffer(values: readonly number[]): Buffer {
  const buffer = Buffer.alloc(values.length * UINT32_BYTES);
  values.forEach((value, index) => buffer.writeUInt32LE(value, index * UINT32_BYTES));
  return buffer;
}

export function indexColumnBytes(name: (typeof INDEX_COLUMNS)[number] | typeof RECORD_MAP_COLUMN, count: number, blocks: number): number {
  switch (name) {
    case 'blockOffsets':
    case 'blockRecords':
      return (blocks + 1) * UINT32_BYTES;
    case 'recordOffsets':
      return (count + 1) * UINT32_BYTES;
    case 'blockChecksums':
      return blocks * SHA256_BYTES;
    case 'recordMap':
      return count * UINT32_BYTES;
  }
}

export function tableIndexBytes(table: Pick<CasRecordStoreTable, 'count' | 'blocks'> & { columns?: Record<string, unknown> }): number {
  const base = INDEX_COLUMNS.reduce((sum, name) => sum + indexColumnBytes(name, table.count, table.blocks), 0);
  return base + (table.columns && RECORD_MAP_COLUMN in table.columns ? indexColumnBytes(RECORD_MAP_COLUMN, table.count, table.blocks) : 0);
}

export interface WritableHandle {
  write(buffer: Buffer, offset: number, length: number, position: number | null): Promise<{ bytesWritten: number }>;
}

export async function writeFully(handle: WritableHandle, buffer: Buffer): Promise<void> {
  let written = 0;
  while (written < buffer.byteLength) {
    const { bytesWritten } = await handle.write(buffer, written, buffer.byteLength - written, null);
    if (!Number.isInteger(bytesWritten) || bytesWritten <= 0) throw new Error(`CAS record store write made no progress at byte ${written} of ${buffer.byteLength}`);
    written += bytesWritten;
  }
}

class StreamingTableWriter {
  private readonly blockOffsets: number[] = [0];
  private readonly blockRecords: number[] = [0];
  private readonly recordOffsets: number[] = [0];
  private readonly checksums: Buffer[] = [];
  private readonly pending: Buffer[] = [];
  private pendingBytes = 0;
  private compressedBytes = 0;
  private decodedBytes = 0;
  private count = 0;
  private handle: fs.promises.FileHandle | undefined;
  private readonly blocksHash = crypto.createHash('sha256');

  constructor(private readonly directory: string, private readonly prefix: string, private readonly recordMap?: readonly number[]) {}

  private get blocksFile(): string {
    return `${this.prefix}.blocks.bin`;
  }

  async push(record: unknown): Promise<void> {
    const bytes = Buffer.from(JSON.stringify(record), 'utf8');
    if (bytes.byteLength > CAS_RECORD_STORE_MAX_RECORD_BYTES) throw new CasRecordStoreCapacityError(`CAS record ${this.count} is ${bytes.byteLength} bytes, above ${CAS_RECORD_STORE_MAX_RECORD_BYTES}`);
    if (this.pending.length > 0 && (this.pendingBytes + bytes.byteLength > CAS_RECORD_STORE_TARGET_BLOCK_BYTES || this.pending.length >= CAS_RECORD_STORE_MAX_BLOCK_RECORDS)) {
      await this.flush();
    }
    this.pending.push(bytes);
    this.pendingBytes += bytes.byteLength;
    this.count += 1;
    this.decodedBytes += bytes.byteLength;
    if (this.count > MAX_TABLE_RECORDS || this.decodedBytes > MAX_TABLE_BYTES) throw new CasRecordStoreCapacityError(`CAS record store ${this.prefix} exceeds its addressing limits`);
    this.recordOffsets.push(this.decodedBytes);
  }

  private async flush(): Promise<void> {
    if (this.pending.length === 0) return;
    const decoded = Buffer.concat(this.pending);
    const compressed = zlib.brotliCompressSync(decoded, {
      params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: decoded.byteLength },
    });
    if (compressed.byteLength > CAS_RECORD_STORE_MAX_BLOCK_COMPRESSED_BYTES) throw new CasRecordStoreCapacityError(`CAS record store ${this.prefix} block compresses to ${compressed.byteLength} bytes, above ${CAS_RECORD_STORE_MAX_BLOCK_COMPRESSED_BYTES}`);
    if (this.compressedBytes + compressed.byteLength > MAX_TABLE_BYTES) throw new CasRecordStoreCapacityError(`CAS record store ${this.prefix} compressed data exceeds addressing limits`);
    if (!this.handle) this.handle = await fs.promises.open(path.join(this.directory, this.blocksFile), 'w');
    await writeFully(this.handle, compressed);
    this.blocksHash.update(compressed);
    this.compressedBytes += compressed.byteLength;
    this.blockOffsets.push(this.compressedBytes);
    this.blockRecords.push(this.count);
    this.checksums.push(crypto.createHash('sha256').update(compressed).digest());
    this.pending.length = 0;
    this.pendingBytes = 0;
  }

  async finish(): Promise<CasRecordStoreTable> {
    await this.flush();
    if (!this.handle) this.handle = await fs.promises.open(path.join(this.directory, this.blocksFile), 'w');
    await this.handle.sync();
    await this.handle.close();
    const written = await fs.promises.stat(path.join(this.directory, this.blocksFile));
    if (written.size !== this.compressedBytes) throw new Error(`CAS record store ${this.prefix} wrote ${written.size} block bytes, expected ${this.compressedBytes}`);
    const columns: Record<string, CasRawColumnDescriptor> = {
      blocks: { file: this.blocksFile, encoding: 'uint8', length: this.compressedBytes, bytes: this.compressedBytes, sha256: this.blocksHash.digest('hex') },
    };
    const writeIndex = async (name: (typeof INDEX_COLUMNS)[number] | typeof RECORD_MAP_COLUMN, bytes: Buffer, encoding: 'uint8' | 'uint32-le', length: number): Promise<void> => {
      const file = `${this.prefix}.${name}.bin`;
      const target = path.join(this.directory, file);
      const handle = await fs.promises.open(target, 'w');
      try {
        await writeFully(handle, bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      const stat = await fs.promises.stat(target);
      if (stat.size !== bytes.byteLength || bytes.byteLength !== indexColumnBytes(name, this.count, this.blockOffsets.length - 1)) throw new Error(`CAS record store ${this.prefix} index column ${name} has an unexpected size`);
      columns[name] = { file, encoding, length, bytes: bytes.byteLength, sha256: sha256(bytes) };
    };
    await writeIndex('blockOffsets', uint32ToBuffer(this.blockOffsets), 'uint32-le', this.blockOffsets.length);
    await writeIndex('blockRecords', uint32ToBuffer(this.blockRecords), 'uint32-le', this.blockRecords.length);
    await writeIndex('recordOffsets', uint32ToBuffer(this.recordOffsets), 'uint32-le', this.recordOffsets.length);
    const checksumBytes = Buffer.concat(this.checksums);
    await writeIndex('blockChecksums', checksumBytes, 'uint8', checksumBytes.byteLength);
    if (this.recordMap) {
      if (this.recordMap.length !== this.count) throw new Error(`CAS record store ${this.prefix} record map covers ${this.recordMap.length} of ${this.count} records`);
      await writeIndex(RECORD_MAP_COLUMN, uint32ToBuffer(this.recordMap), 'uint32-le', this.recordMap.length);
    }
    return {
      count: this.count,
      blocks: this.blockOffsets.length - 1,
      max_block_records: CAS_RECORD_STORE_MAX_BLOCK_RECORDS,
      max_block_bytes: CAS_RECORD_STORE_MAX_BLOCK_BYTES,
      columns,
    };
  }

  async abort(): Promise<void> {
    if (this.handle) await this.handle.close().catch(() => undefined);
    await fs.promises.rm(path.join(this.directory, this.blocksFile), { force: true }).catch(() => undefined);
  }
}

function orderedNodes(output: CASOutput, graph: CompactCASGraph): CASNode[] {
  const byId = new Map<string, CASNode>();
  for (const node of output.nodes || []) byId.set(node.id, node);
  const ordered: CASNode[] = new Array(graph.nodeCount);
  for (let denseId = 0; denseId < graph.nodeCount; denseId += 1) {
    const view = graph.nodeAt(denseId);
    const node = byId.get(view.id);
    if (!node) throw new Error(`CAS record store cannot find node ${view.id} for dense id ${denseId}`);
    ordered[denseId] = node;
  }
  return ordered;
}

function compactEdgeRecordMap(output: CASOutput, graph: CompactCASGraph): number[] {
  const edges = output.edges || [];
  const buckets = new Map<string, number[]>();
  edges.forEach((edge, index) => {
    const key = edgeRecordKey(edge);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(index); else buckets.set(key, [index]);
  });
  const cursors = new Map<string, number>();
  const recordMap: number[] = new Array(graph.edgeCount);
  for (let ordinal = 0; ordinal < graph.edgeCount; ordinal += 1) {
    const view = graph.edgeAt(ordinal);
    const key = edgeRecordKey({ id: view.id, source: view.sourceId, target: view.targetId, type: view.type, category: view.category });
    const bucket = buckets.get(key);
    const cursor = cursors.get(key) ?? 0;
    if (!bucket || cursor >= bucket.length) throw new Error(`CAS record store cannot find edge ${view.id} for compact ordinal ${ordinal}`);
    cursors.set(key, cursor + 1);
    recordMap[ordinal] = bucket[cursor];
  }
  if (edges.length !== graph.edgeCount) throw new Error(`CAS record store edge count ${edges.length} does not match the compact graph ${graph.edgeCount}`);
  return recordMap;
}

export async function writeCasRecordStore(
  directory: string,
  output: CASOutput,
  graph: CompactCASGraph,
): Promise<{ descriptor: CasRecordStoreDescriptor } | { skipped: string }> {
  const nodesWriter = new StreamingTableWriter(directory, 'records.nodes');
  let edgesWriter = new StreamingTableWriter(directory, 'records.edges');
  try {
    for (const node of orderedNodes(output, graph)) await nodesWriter.push(node);
    edgesWriter = new StreamingTableWriter(directory, 'records.edges', compactEdgeRecordMap(output, graph));
    for (const edge of output.edges || []) await edgesWriter.push(edge);
    const [nodes, edges] = [await nodesWriter.finish(), await edgesWriter.finish()];
    return { descriptor: { format: CAS_RECORD_STORE_FORMAT, version: CAS_RECORD_STORE_VERSION, codec: 'brotli', nodes, edges } };
  } catch (error) {
    await nodesWriter.abort();
    await edgesWriter.abort();
    for (const suffix of [...INDEX_COLUMNS, RECORD_MAP_COLUMN]) {
      for (const prefix of ['records.nodes', 'records.edges']) await fs.promises.rm(path.join(directory, `${prefix}.${suffix}.bin`), { force: true }).catch(() => undefined);
    }
    if (error instanceof CasRecordStoreCapacityError) return { skipped: error.message };
    throw error;
  }
}

function safeCount(value: unknown, name: string, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > max) throw new Error(`CAS record store ${name} is invalid`);
  return value as number;
}

async function readExactFile(filePath: string, expectedBytes: number, name: string): Promise<Buffer> {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size !== expectedBytes) throw new Error(`CAS record store column ${name} file size ${stat.size} does not match ${expectedBytes}`);
    const bytes = Buffer.alloc(expectedBytes);
    let read = 0;
    while (read < expectedBytes) {
      const { bytesRead } = await handle.read(bytes, read, expectedBytes - read, read);
      if (bytesRead <= 0) throw new Error(`CAS record store column ${name} is truncated at ${read} of ${expectedBytes}`);
      read += bytesRead;
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function readVerifiedColumn(directory: string, name: string, column: CasRawColumnDescriptor | undefined, expectedBytes: number): Promise<Buffer> {
  if (!column) throw new Error(`CAS record store column ${name} is missing from the manifest`);
  if (path.basename(column.file) !== column.file) throw new Error(`CAS record store column ${name} has an invalid file path`);
  if (column.bytes !== expectedBytes) throw new Error(`CAS record store column ${name} declares ${String(column.bytes)} bytes, expected ${expectedBytes}`);
  if (typeof column.sha256 !== 'string' || column.sha256.length !== 64) throw new Error(`CAS record store column ${name} has an invalid checksum`);
  const bytes = await readExactFile(path.join(directory, column.file), expectedBytes, name);
  if (sha256(bytes) !== column.sha256) throw new Error(`CAS record store column ${name} checksum mismatch`);
  return bytes;
}

function readUint32Column(bytes: Buffer): Uint32Array {
  const values = new Uint32Array(bytes.byteLength / UINT32_BYTES);
  for (let index = 0; index < values.length; index += 1) values[index] = bytes.readUInt32LE(index * UINT32_BYTES);
  return values;
}

function assertMonotone(values: Uint32Array, name: string, maxStep: number): void {
  for (let index = 1; index < values.length; index += 1) {
    const step = values[index] - values[index - 1];
    if (step < 0 || step > maxStep) throw new Error(`CAS record store column ${name} is not a bounded monotone offset sequence at ${index}`);
  }
}

class SharedBlockCache {
  private readonly entries = new Map<string, Buffer>();
  private bytes = 0;

  constructor(private readonly limit: number) {}

  get(key: string): Buffer | undefined {
    const value = this.entries.get(key);
    if (!value) return undefined;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  put(key: string, value: Buffer): void {
    if (value.byteLength > this.limit) return;
    while (this.bytes + value.byteLength > this.limit && this.entries.size > 0) {
      const oldest = this.entries.keys().next().value as string;
      this.bytes -= this.entries.get(oldest)!.byteLength;
      this.entries.delete(oldest);
    }
    this.entries.set(key, value);
    this.bytes += value.byteLength;
  }

  get usedBytes(): number {
    return this.bytes;
  }
}

class ReadLedger {
  readonly stats: CasRecordStoreReadStats = { indexBytes: 0, records: 0, blocksPlanned: 0, blockReads: 0, cacheHits: 0, compressedBytesPlanned: 0, compressedBytesRead: 0, decodedBytes: 0 };

  constructor(private readonly budget: CasRecordStoreReadBudget) {}

  chargeIndex(bytes: number): void {
    if (this.stats.indexBytes + bytes > this.budget.maxIndexBytes) throw new CasRecordStoreCapacityError(`CAS record store index needs ${this.stats.indexBytes + bytes} bytes, above ${this.budget.maxIndexBytes}`);
    this.stats.indexBytes += bytes;
  }

  reserve(records: number, decodedBytes: number, compressedBytes: number, blocks: number): void {
    if (this.stats.records + records > this.budget.maxRecords) throw new CasRecordStoreCapacityError(`CAS record store query of ${this.stats.records + records} records exceeds ${this.budget.maxRecords}`);
    if (this.stats.decodedBytes + decodedBytes > this.budget.maxDecodedBytes) throw new CasRecordStoreCapacityError(`CAS record store query needs ${this.stats.decodedBytes + decodedBytes} decoded bytes, above ${this.budget.maxDecodedBytes}`);
    if (this.stats.compressedBytesPlanned + compressedBytes > this.budget.maxCompressedBytes) throw new CasRecordStoreCapacityError(`CAS record store query needs ${this.stats.compressedBytesPlanned + compressedBytes} compressed bytes, above ${this.budget.maxCompressedBytes}`);
    this.stats.records += records;
    this.stats.decodedBytes += decodedBytes;
    this.stats.compressedBytesPlanned += compressedBytes;
    this.stats.blocksPlanned += blocks;
  }
}

export class CasRecordTable<T> {
  private constructor(
    private readonly filePath: string,
    private readonly cacheKey: string,
    private readonly blocksBytes: number,
    private readonly blockOffsets: Uint32Array,
    private readonly blockRecords: Uint32Array,
    private readonly recordOffsets: Uint32Array,
    private readonly checksums: Buffer,
    readonly count: number,
    private readonly cache: SharedBlockCache,
    private readonly ledger: ReadLedger,
    private readonly recordMap: Uint32Array | undefined,
  ) {}

  static async open<T>(directory: string, prefix: string, table: CasRecordStoreTable, cache: SharedBlockCache, ledger: ReadLedger, requireRecordMap = false): Promise<CasRecordTable<T>> {
    const count = safeCount(table.count, `${prefix} count`, MAX_TABLE_RECORDS);
    const blocks = safeCount(table.blocks, `${prefix} blocks`, MAX_TABLE_RECORDS);
    if (table.max_block_bytes !== CAS_RECORD_STORE_MAX_BLOCK_BYTES || table.max_block_records !== CAS_RECORD_STORE_MAX_BLOCK_RECORDS) throw new Error(`CAS record store ${prefix} block limits are unsupported`);
    if ((count === 0) !== (blocks === 0) || blocks > count) throw new Error(`CAS record store ${prefix} block count does not match its record count`);
    if (!table.columns || typeof table.columns !== 'object') throw new Error(`CAS record store ${prefix} columns are missing`);
    const blocksColumn = table.columns.blocks;
    if (!blocksColumn || path.basename(blocksColumn.file) !== blocksColumn.file) throw new Error(`CAS record store ${prefix} blocks column is invalid`);
    safeCount(blocksColumn.bytes, `${prefix} blocks bytes`, Math.min(MAX_TABLE_BYTES, blocks * CAS_RECORD_STORE_MAX_BLOCK_COMPRESSED_BYTES));
    const filePath = path.join(directory, blocksColumn.file);
    const stat = await fs.promises.stat(filePath).catch(() => null);
    if (!stat || !stat.isFile() || stat.size !== blocksColumn.bytes) throw new Error(`CAS record store ${prefix} blocks file size ${stat?.size ?? 'missing'} does not match ${blocksColumn.bytes}`);
    ledger.chargeIndex(tableIndexBytes({ count, blocks, columns: table.columns }));
    const column = (name: (typeof INDEX_COLUMNS)[number] | typeof RECORD_MAP_COLUMN): Promise<Buffer> => readVerifiedColumn(directory, `${prefix}.${name}`, table.columns[name], indexColumnBytes(name, count, blocks));
    const blockOffsets = readUint32Column(await column('blockOffsets'));
    const blockRecords = readUint32Column(await column('blockRecords'));
    const recordOffsets = readUint32Column(await column('recordOffsets'));
    const checksums = await column('blockChecksums');
    assertMonotone(blockOffsets, `${prefix}.blockOffsets`, CAS_RECORD_STORE_MAX_BLOCK_COMPRESSED_BYTES);
    assertMonotone(blockRecords, `${prefix}.blockRecords`, CAS_RECORD_STORE_MAX_BLOCK_RECORDS);
    assertMonotone(recordOffsets, `${prefix}.recordOffsets`, CAS_RECORD_STORE_MAX_RECORD_BYTES);
    if (blockOffsets[0] !== 0 || blockOffsets[blocks] !== blocksColumn.bytes) throw new Error(`CAS record store ${prefix} block offsets do not cover the block data`);
    if (blockRecords[0] !== 0 || blockRecords[blocks] !== count) throw new Error(`CAS record store ${prefix} block records do not cover the record count`);
    for (let block = 0; block < blocks; block += 1) {
      if (blockRecords[block + 1] <= blockRecords[block]) throw new Error(`CAS record store ${prefix} block ${block} is empty`);
      if (blockOffsets[block + 1] <= blockOffsets[block]) throw new Error(`CAS record store ${prefix} block ${block} has no compressed data`);
      if (recordOffsets[blockRecords[block + 1]] - recordOffsets[blockRecords[block]] > CAS_RECORD_STORE_MAX_BLOCK_BYTES) throw new Error(`CAS record store ${prefix} block ${block} exceeds the decoded block limit`);
    }
    let recordMap: Uint32Array | undefined;
    if (requireRecordMap && !(RECORD_MAP_COLUMN in table.columns)) throw new Error(`CAS record store ${prefix} is missing its required record map`);
    if (RECORD_MAP_COLUMN in table.columns) {
      ledger.chargeIndex(count);
      recordMap = readUint32Column(await column(RECORD_MAP_COLUMN));
      const seen = new Uint8Array(count);
      for (let ordinal = 0; ordinal < count; ordinal += 1) {
        const record = recordMap[ordinal];
        if (record >= count || seen[record]) throw new Error(`CAS record store ${prefix} record map is not a permutation at ${ordinal}`);
        seen[record] = 1;
      }
    }
    return new CasRecordTable<T>(filePath, `${directory}:${prefix}`, blocksColumn.bytes, blockOffsets, blockRecords, recordOffsets, checksums, count, cache, ledger, recordMap);
  }

  recordOrdinal(ordinal: number): number {
    if (!Number.isInteger(ordinal) || ordinal < 0 || ordinal >= this.count) throw new Error(`CAS record store ordinal ${ordinal} is out of range`);
    return this.recordMap ? this.recordMap[ordinal] : ordinal;
  }

  private blockOf(ordinal: number): number {
    let low = 0;
    let high = this.blockRecords.length - 2;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (this.blockRecords[middle] <= ordinal) low = middle; else high = middle - 1;
    }
    return low;
  }

  private decodedBlockBytes(block: number): number {
    return this.recordOffsets[this.blockRecords[block + 1]] - this.recordOffsets[this.blockRecords[block]];
  }

  plan(ordinals: readonly number[]): { ordinals: number[]; blocks: number[]; decodedBytes: number; compressedBytes: number } {
    for (const ordinal of ordinals) {
      if (!Number.isInteger(ordinal) || ordinal < 0 || ordinal >= this.count) throw new Error(`CAS record store ordinal ${ordinal} is out of range`);
    }
    const unique = [...new Set(this.recordMap ? ordinals.map(ordinal => this.recordMap![ordinal]) : ordinals)].sort((left, right) => left - right);
    const blocks = new Set<number>();
    for (const ordinal of unique) blocks.add(this.blockOf(ordinal));
    let decodedBytes = 0;
    let compressedBytes = 0;
    for (const block of blocks) {
      decodedBytes += this.decodedBlockBytes(block);
      compressedBytes += this.blockOffsets[block + 1] - this.blockOffsets[block];
    }
    this.ledger.reserve(unique.length, decodedBytes, compressedBytes, blocks.size);
    return { ordinals: unique, blocks: [...blocks].sort((left, right) => left - right), decodedBytes, compressedBytes };
  }

  private async decodedBlock(handle: fs.promises.FileHandle, block: number): Promise<Buffer> {
    const key = `${this.cacheKey}:${block}`;
    const cached = this.cache.get(key);
    if (cached) {
      this.ledger.stats.cacheHits += 1;
      return cached;
    }
    const start = this.blockOffsets[block];
    const end = this.blockOffsets[block + 1];
    if (end > this.blocksBytes || end - start > CAS_RECORD_STORE_MAX_BLOCK_COMPRESSED_BYTES) throw new Error(`CAS record store block ${block} is out of bounds`);
    const compressed = Buffer.alloc(end - start);
    let read = 0;
    while (read < compressed.byteLength) {
      const { bytesRead } = await handle.read(compressed, read, compressed.byteLength - read, start + read);
      if (bytesRead <= 0) throw new Error(`CAS record store block ${block} is truncated`);
      read += bytesRead;
      this.ledger.stats.compressedBytesRead += bytesRead;
    }
    this.ledger.stats.blockReads += 1;
    const expectedChecksum = this.checksums.subarray(block * SHA256_BYTES, (block + 1) * SHA256_BYTES);
    if (!crypto.createHash('sha256').update(compressed).digest().equals(expectedChecksum)) throw new Error(`CAS record store block ${block} checksum mismatch`);
    const expectedBytes = this.decodedBlockBytes(block);
    const decoded = zlib.brotliDecompressSync(compressed, { maxOutputLength: expectedBytes });
    if (decoded.byteLength !== expectedBytes) throw new Error(`CAS record store block ${block} decoded to ${decoded.byteLength} bytes, expected ${expectedBytes}`);
    this.cache.put(key, decoded);
    return decoded;
  }

  async read(ordinals: readonly number[]): Promise<T[]> {
    const plan = this.plan(ordinals);
    if (plan.ordinals.length === 0) return [];
    const handle = await fs.promises.open(this.filePath, 'r');
    try {
      const results: T[] = [];
      let cursor = 0;
      for (const block of plan.blocks) {
        const decoded = await this.decodedBlock(handle, block);
        const base = this.recordOffsets[this.blockRecords[block]];
        const last = this.blockRecords[block + 1];
        while (cursor < plan.ordinals.length && plan.ordinals[cursor] < last) {
          const ordinal = plan.ordinals[cursor];
          results.push(JSON.parse(decoded.subarray(this.recordOffsets[ordinal] - base, this.recordOffsets[ordinal + 1] - base).toString('utf8')) as T);
          cursor += 1;
        }
      }
      if (cursor !== plan.ordinals.length) throw new Error('CAS record store read did not cover every planned record');
      return results;
    } finally {
      await handle.close();
    }
  }
}

export interface CasRecordStore {
  nodes: CasRecordTable<CASNode>;
  edges: CasRecordTable<CASEdge>;
  cacheBytes(): number;
  stats(): CasRecordStoreReadStats;
}

export async function openCasRecordStore(
  directory: string,
  descriptor: CasRecordStoreDescriptor,
  expected: { nodeCount: number; edgeCount: number },
  budget: Partial<CasRecordStoreReadBudget> = {},
): Promise<CasRecordStore> {
  if (!isSupportedCasRecordStoreDescriptor(descriptor)) throw new Error('CAS record store format, version or codec is unsupported');
  if (!descriptor.nodes || !descriptor.edges || descriptor.nodes.count !== expected.nodeCount || descriptor.edges.count !== expected.edgeCount) {
    throw new Error(`CAS record store counts (${String(descriptor.nodes?.count)}/${String(descriptor.edges?.count)}) do not match the compact graph (${expected.nodeCount}/${expected.edgeCount})`);
  }
  const resolved: CasRecordStoreReadBudget = { ...DEFAULT_RECORD_STORE_READ_BUDGET, ...budget };
  for (const [name, value] of Object.entries(resolved)) safeCount(value, `read budget ${name}`, Number.MAX_SAFE_INTEGER);
  const ledger = new ReadLedger(resolved);
  for (const table of [descriptor.nodes, descriptor.edges]) {
    safeCount(table.count, 'table count', MAX_TABLE_RECORDS);
    safeCount(table.blocks, 'table blocks', MAX_TABLE_RECORDS);
  }
  const indexBytes = tableIndexBytes(descriptor.nodes) + tableIndexBytes(descriptor.edges) + descriptor.edges.count;
  if (indexBytes > resolved.maxIndexBytes) throw new CasRecordStoreCapacityError(`CAS record store index needs ${indexBytes} bytes, above ${resolved.maxIndexBytes}`);
  const cache = new SharedBlockCache(resolved.cacheBytes);
  return {
    nodes: await CasRecordTable.open<CASNode>(directory, 'records.nodes', descriptor.nodes, cache, ledger),
    edges: await CasRecordTable.open<CASEdge>(directory, 'records.edges', descriptor.edges, cache, ledger, true),
    cacheBytes: () => cache.usedBytes,
    stats: () => ({ ...ledger.stats }),
  };
}

export const CAS_SEMANTIC_STORE_FORMAT = 'klauro-cas-semantic-store';
export const CAS_SEMANTIC_STORE_VERSION = 1;
export const CAS_SEMANTIC_TABLES = ['method_calls', 'change_risks', 'test_suites', 'mocks', 'fixtures'] as const;
export type CasSemanticTableName = (typeof CAS_SEMANTIC_TABLES)[number];
const MAX_POSTINGS_PER_RECORD = 64;

export interface CasSemanticTableDescriptor extends CasRecordStoreTable {
  postings: number;
  by_node: { offsets: CasRawColumnDescriptor; postings: CasRawColumnDescriptor };
}

export interface CasSemanticStoreDescriptor {
  format: typeof CAS_SEMANTIC_STORE_FORMAT;
  version: typeof CAS_SEMANTIC_STORE_VERSION;
  codec: 'brotli';
  node_count: number;
  tables: Partial<Record<CasSemanticTableName, CasSemanticTableDescriptor>>;
}

function semanticRecordNodeIds(table: CasSemanticTableName, record: Record<string, unknown>): string[] {
  const ids: string[] = [];
  const push = (value: unknown): void => { if (typeof value === 'string' && value) ids.push(value); };
  const pushAll = (value: unknown): void => { if (Array.isArray(value)) for (const item of value) push(item); };
  switch (table) {
    case 'method_calls': push(record.caller_node); push(record.target_node); break;
    case 'change_risks': push(record.node_id); break;
    case 'test_suites':
      pushAll((record.coverage as { nodes_tested?: unknown } | undefined)?.nodes_tested);
      for (const test of Array.isArray(record.tests) ? record.tests : []) pushAll((test as { targets?: unknown })?.targets);
      break;
    case 'mocks': push(record.target_node); pushAll(record.used_by); break;
    case 'fixtures': pushAll(record.used_by); pushAll(record.tested_by); break;
  }
  return [...new Set(ids)].slice(0, MAX_POSTINGS_PER_RECORD);
}

export function isSupportedCasSemanticStoreDescriptor(descriptor: unknown): descriptor is CasSemanticStoreDescriptor {
  return !!descriptor && typeof descriptor === 'object'
    && (descriptor as CasSemanticStoreDescriptor).format === CAS_SEMANTIC_STORE_FORMAT
    && (descriptor as CasSemanticStoreDescriptor).version === CAS_SEMANTIC_STORE_VERSION
    && (descriptor as CasSemanticStoreDescriptor).codec === 'brotli';
}

export async function writeCasSemanticStore(
  directory: string,
  output: CASOutput,
  graph: CompactCASGraph,
): Promise<{ descriptor: CasSemanticStoreDescriptor } | { skipped: string }> {
  const tables: Partial<Record<CasSemanticTableName, CasSemanticTableDescriptor>> = {};
  const writers: StreamingTableWriter[] = [];
  const written: string[] = [];
  try {
    for (const table of CAS_SEMANTIC_TABLES) {
      const records = (output as unknown as Record<string, unknown>)[table];
      if (!Array.isArray(records) || records.length === 0) continue;
      const prefix = `semantic.${table}`;
      const writer = new StreamingTableWriter(directory, prefix);
      writers.push(writer);
      const postingsByNode: number[][] = Array.from({ length: graph.nodeCount }, () => []);
      records.forEach((record, ordinal) => {
        for (const id of semanticRecordNodeIds(table, (record ?? {}) as Record<string, unknown>)) {
          const node = graph.nodeById(id);
          if (node) postingsByNode[node.denseId].push(ordinal);
        }
      });
      for (const record of records) await writer.push(record);
      const base = await writer.finish();
      written.push(base.columns.blocks.file, ...Object.values(base.columns).map(column => column.file));
      const offsets: number[] = [0];
      const postings: number[] = [];
      for (const list of postingsByNode) { for (const ordinal of list) postings.push(ordinal); offsets.push(postings.length); }
      const writeColumn = async (name: string, values: readonly number[]): Promise<CasRawColumnDescriptor> => {
        const file = `${prefix}.byNode.${name}.bin`;
        const bytes = uint32ToBuffer(values);
        const handle = await fs.promises.open(path.join(directory, file), 'w');
        try { await writeFully(handle, bytes); await handle.sync(); } finally { await handle.close(); }
        written.push(file);
        return { file, encoding: 'uint32-le', length: values.length, bytes: bytes.byteLength, sha256: sha256(bytes) };
      };
      tables[table] = {
        ...base,
        postings: postings.length,
        by_node: { offsets: await writeColumn('offsets', offsets), postings: await writeColumn('postings', postings) },
      };
    }
    return { descriptor: { format: CAS_SEMANTIC_STORE_FORMAT, version: CAS_SEMANTIC_STORE_VERSION, codec: 'brotli', node_count: graph.nodeCount, tables } };
  } catch (error) {
    for (const writer of writers) await writer.abort();
    for (const file of written) await fs.promises.rm(path.join(directory, file), { force: true }).catch(() => undefined);
    if (error instanceof CasRecordStoreCapacityError) return { skipped: error.message };
    throw error;
  }
}

export interface CasSemanticTableRead<T> {
  records: T[];
  total: number;
  matched: number;
  read: number;
}

export interface CasSemanticStore {
  tables: ReadonlySet<CasSemanticTableName>;
  readByNodes<T>(table: CasSemanticTableName, denseIds: readonly number[]): Promise<CasSemanticTableRead<T>>;
  stats(): CasRecordStoreReadStats;
}

export async function openCasSemanticStore(
  directory: string,
  descriptor: CasSemanticStoreDescriptor,
  expected: { nodeCount: number; totals?: Partial<Record<CasSemanticTableName, number>> },
  budget: Partial<CasRecordStoreReadBudget> = {},
): Promise<CasSemanticStore> {
  if (!isSupportedCasSemanticStoreDescriptor(descriptor)) throw new Error('CAS semantic store format, version or codec is unsupported');
  if (descriptor.node_count !== expected.nodeCount) throw new Error(`CAS semantic store node count ${String(descriptor.node_count)} does not match the compact graph ${expected.nodeCount}`);
  const resolved: CasRecordStoreReadBudget = { ...DEFAULT_RECORD_STORE_READ_BUDGET, ...budget };
  for (const [name, value] of Object.entries(resolved)) safeCount(value, `read budget ${name}`, Number.MAX_SAFE_INTEGER);
  const ledger = new ReadLedger(resolved);
  const cache = new SharedBlockCache(resolved.cacheBytes);
  const opened = new Map<CasSemanticTableName, { table: CasRecordTable<unknown>; offsets: Uint32Array; postings: Uint32Array }>();
  for (const name of CAS_SEMANTIC_TABLES) {
    const table = descriptor.tables[name];
    if (!table) continue;
    const expectedTotal = expected.totals?.[name];
    if (typeof expectedTotal === 'number' && expectedTotal !== table.count) throw new Error(`CAS semantic store ${name} count ${table.count} does not match the generation total ${expectedTotal}`);
    const prefix = `semantic.${name}`;
    const postingsCount = safeCount(table.postings, `${name} postings`, MAX_TABLE_RECORDS * MAX_POSTINGS_PER_RECORD);
    ledger.chargeIndex((expected.nodeCount + 1 + postingsCount) * UINT32_BYTES);
    const offsets = readUint32Column(await readVerifiedColumn(directory, `${prefix}.byNode.offsets`, table.by_node?.offsets, (expected.nodeCount + 1) * UINT32_BYTES));
    const postings = readUint32Column(await readVerifiedColumn(directory, `${prefix}.byNode.postings`, table.by_node?.postings, postingsCount * UINT32_BYTES));
    assertMonotone(offsets, `${prefix}.byNode.offsets`, MAX_POSTINGS_PER_RECORD * MAX_TABLE_RECORDS);
    if (offsets[0] !== 0 || offsets[expected.nodeCount] !== postingsCount) throw new Error(`CAS semantic store ${name} postings offsets do not cover the postings`);
    for (let index = 0; index < postings.length; index += 1) if (postings[index] >= table.count) throw new Error(`CAS semantic store ${name} posting ${index} is out of range`);
    const records = await CasRecordTable.open<unknown>(directory, prefix, table, cache, ledger);
    opened.set(name, { table: records, offsets, postings });
  }
  return {
    tables: new Set(opened.keys()),
    async readByNodes<T>(name: CasSemanticTableName, denseIds: readonly number[]): Promise<CasSemanticTableRead<T>> {
      const entry = opened.get(name);
      if (!entry) throw new Error(`CAS semantic store has no ${name} table`);
      const ordinals = new Set<number>();
      for (const denseId of denseIds) {
        if (!Number.isInteger(denseId) || denseId < 0 || denseId >= expected.nodeCount) throw new Error(`CAS semantic store dense id ${denseId} is out of range`);
        for (let position = entry.offsets[denseId]; position < entry.offsets[denseId + 1]; position += 1) ordinals.add(entry.postings[position]);
      }
      const sorted = [...ordinals].sort((left, right) => left - right);
      const records = await entry.table.read(sorted) as T[];
      return { records, total: entry.table.count, matched: sorted.length, read: records.length };
    },
    stats: () => ({ ...ledger.stats }),
  };
}
