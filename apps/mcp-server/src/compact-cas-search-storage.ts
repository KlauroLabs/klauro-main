import * as crypto from 'node:crypto';
import * as path from 'node:path';
import * as fs from 'fs-extra';
import { open, type FileHandle } from 'node:fs/promises';
import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import type { CompactCASGraph } from '../../../packages/analyzer-core/src/analyzer/core/compact-cas-graph';
import {
  COMPACT_CAS_SEARCH_SHARDS,
  compactCASPostingShard,
  iterateCompactCASSearchPostings,
  validatePosting,
} from '../../../packages/analyzer-core/src/analyzer/core/compact-cas-search';
import type { CasRawColumnDescriptor } from './cas-sections';

const DEFAULT_RUN_BYTES = 64 * 1024 * 1024;
const MIN_RUN_BYTES = 1024 * 1024;
const MAX_RUN_BYTES = 128 * 1024 * 1024;
const IO_BUFFER_BYTES = 256 * 1024;
const MAGIC = Buffer.from('KCSPST02');

interface PostingRecord {
  shard: number;
  key: string;
  denseIds: Uint32Array;
}

interface ActiveRun {
  record: PostingRecord;
  reader: AsyncIterator<PostingRecord>;
}

export interface CompactCASPostingArtifacts {
  columns: Record<string, CasRawColumnDescriptor>;
  shardCount: number;
  recordCount: number;
  runCount: number;
}

function compareRecords(left: PostingRecord, right: PostingRecord): number {
  return left.shard - right.shard
    || (left.key < right.key ? -1 : left.key > right.key ? 1 : 0)
    || left.denseIds[0] - right.denseIds[0];
}

function pushRun(heap: ActiveRun[], value: ActiveRun): void {
  heap.push(value);
  let index = heap.length - 1;
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2);
    if (compareRecords(heap[parent].record, heap[index].record) <= 0) break;
    [heap[parent], heap[index]] = [heap[index], heap[parent]];
    index = parent;
  }
}

function popRun(heap: ActiveRun[]): ActiveRun {
  const first = heap[0];
  const last = heap.pop()!;
  if (heap.length === 0) return first;
  heap[0] = last;
  let index = 0;
  while (true) {
    const left = index * 2 + 1;
    const right = left + 1;
    let smallest = index;
    if (left < heap.length && compareRecords(heap[left].record, heap[smallest].record) < 0) smallest = left;
    if (right < heap.length && compareRecords(heap[right].record, heap[smallest].record) < 0) smallest = right;
    if (smallest === index) return first;
    [heap[index], heap[smallest]] = [heap[smallest], heap[index]];
    index = smallest;
  }
}

async function* readBinaryRecords(filePath: string): AsyncGenerator<PostingRecord> {
  let carry = Buffer.alloc(0);
  for await (const value of fs.createReadStream(filePath, { highWaterMark: IO_BUFFER_BYTES })) {
    const chunk = value as Buffer;
    const bytes = carry.length > 0 ? Buffer.concat([carry, chunk]) : chunk;
    let offset = 0;
    while (offset + 10 <= bytes.length) {
      const shard = bytes.readUInt16LE(offset);
      const keyBytes = bytes.readUInt32LE(offset + 2);
      if (keyBytes > 16 * 1024 * 1024) throw new Error('Compact CAS posting run key exceeds storage limit');
      if (offset + 10 + keyBytes > bytes.length) break;
      const count = bytes.readUInt32LE(offset + 6 + keyBytes);
      const recordBytes = 10 + keyBytes + count * 4;
      if (offset + recordBytes > bytes.length) break;
      const key = bytes.subarray(offset + 6, offset + 6 + keyBytes).toString('utf8');
      const denseIds = new Uint32Array(count);
      for (let index = 0; index < count; index += 1) {
        denseIds[index] = bytes.readUInt32LE(offset + 10 + keyBytes + index * 4);
      }
      yield { shard, key, denseIds };
      offset += recordBytes;
    }
    carry = offset === bytes.length ? Buffer.alloc(0) : Buffer.from(bytes.subarray(offset));
  }
  if (carry.length > 0) throw new Error('Compact CAS posting run is truncated');
}

async function checksumFile(filePath: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

function phaseSnapshot(startedAt: number): { duration_ms: number; rss_mb: number; heap_mb: number; max_rss_mb: number } {
  const memory = process.memoryUsage();
  return {
    duration_ms: Date.now() - startedAt,
    rss_mb: Math.round(memory.rss / 1024 / 1024),
    heap_mb: Math.round(memory.heapUsed / 1024 / 1024),
    max_rss_mb: Math.round(process.resourceUsage().maxRSS / 1024),
  };
}

async function writeRun(
  postings: readonly Map<string, number[]>[],
  filePath: string,
): Promise<void> {
  const handle = await open(filePath, 'w');
  const buffer = Buffer.allocUnsafe(IO_BUFFER_BYTES);
  let position = 0;
  let filePosition = 0;
  const flush = async (): Promise<void> => {
    if (position === 0) return;
    await handle.write(buffer, 0, position, filePosition);
    filePosition += position;
    position = 0;
  };
  for (let shard = 0; shard < postings.length; shard += 1) {
    for (const key of [...postings[shard].keys()].sort()) {
      const keyBytes = Buffer.from(key);
      const denseIds = postings[shard].get(key)!;
      const recordBytes = 10 + keyBytes.length + denseIds.length * 4;
      if (recordBytes > buffer.length) {
        await flush();
        const record = Buffer.allocUnsafe(recordBytes);
        record.writeUInt16LE(shard, 0);
        record.writeUInt32LE(keyBytes.length, 2);
        keyBytes.copy(record, 6);
        record.writeUInt32LE(denseIds.length, 6 + keyBytes.length);
        for (let index = 0; index < denseIds.length; index += 1) record.writeUInt32LE(denseIds[index], 10 + keyBytes.length + index * 4);
        await handle.write(record, 0, record.length, filePosition);
        filePosition += record.length;
        continue;
      }
      if (position + recordBytes > buffer.length) await flush();
      buffer.writeUInt16LE(shard, position);
      buffer.writeUInt32LE(keyBytes.length, position + 2);
      keyBytes.copy(buffer, position + 6);
      buffer.writeUInt32LE(denseIds.length, position + 6 + keyBytes.length);
      for (let index = 0; index < denseIds.length; index += 1) buffer.writeUInt32LE(denseIds[index], position + 10 + keyBytes.length + index * 4);
      position += recordBytes;
    }
  }
  await flush();
  await handle.close();
}

async function mergeRuns(
  runPaths: readonly string[],
  directory: string,
): Promise<Record<string, CasRawColumnDescriptor>> {
  const readers = runPaths.map(runPath => readBinaryRecords(runPath)[Symbol.asyncIterator]());
  const active: ActiveRun[] = [];
  for (const reader of readers) {
    const next = await reader.next();
    if (!next.done) pushRun(active, { record: next.value, reader });
  }
  const columns: Record<string, CasRawColumnDescriptor> = {};
  let shard = -1;
  let handle: FileHandle | undefined;
  let filePath = '';
  let position = 0;
  let entries = 0;
  let key = '';
  let postingCount = 0;
  let postingCountPosition = 0;
  let previousDenseId = 0;
  let previousRecord: PostingRecord | undefined;
  const pending = Buffer.allocUnsafe(IO_BUFFER_BYTES);
  let pendingBytes = 0;
  const flushBytes = async (): Promise<void> => {
    if (!handle || pendingBytes === 0) return;
    await handle.write(pending, 0, pendingBytes, position);
    position += pendingBytes;
    pendingBytes = 0;
  };
  const append = async (bytes: Buffer): Promise<void> => {
    if (bytes.length > pending.length) {
      await flushBytes();
      await handle!.write(bytes, 0, bytes.length, position);
      position += bytes.length;
      return;
    }
    if (pendingBytes + bytes.length > pending.length) await flushBytes();
    bytes.copy(pending, pendingBytes);
    pendingBytes += bytes.length;
  };
  const finishKey = async (): Promise<void> => {
    if (!handle || !key) return;
    await flushBytes();
    const count = Buffer.allocUnsafe(4);
    count.writeUInt32LE(postingCount);
    await handle.write(count, 0, count.length, postingCountPosition);
    key = '';
  };
  const finishShard = async (): Promise<void> => {
    if (!handle) return;
    await finishKey();
    const count = Buffer.allocUnsafe(4);
    count.writeUInt32LE(entries);
    await handle.write(count, 0, count.length, MAGIC.length);
    await handle.close();
    const stat = await fs.stat(filePath);
    columns[`postings.shard.${shard}`] = {
      file: path.basename(filePath), encoding: 'uint8', length: stat.size, bytes: stat.size,
      sha256: await checksumFile(filePath),
    };
    handle = undefined;
  };
  const startShard = async (nextShard: number): Promise<void> => {
    await finishShard();
    shard = nextShard;
    filePath = path.join(directory, `search.postings.${shard}.bin`);
    handle = await open(filePath, 'w');
    const header = Buffer.alloc(MAGIC.length + 4);
    MAGIC.copy(header);
    await handle.write(header, 0, header.length, 0);
    position = header.length;
    entries = 0;
  };
  const startKey = async (nextKey: string): Promise<void> => {
    await finishKey();
    key = nextKey;
    postingCount = 0;
    previousDenseId = 0;
    entries += 1;
    const keyBytes = Buffer.from(key);
    const header = Buffer.allocUnsafe(8 + keyBytes.length);
    header.writeUInt32LE(keyBytes.length, 0);
    keyBytes.copy(header, 4);
    header.writeUInt32LE(0, 4 + keyBytes.length);
    postingCountPosition = position + 4 + keyBytes.length;
    await append(header);
  };
  while (active.length > 0) {
    const current = popRun(active);
    const record = current.record;
    if (!previousRecord || compareRecords(previousRecord, record) !== 0) {
      if (record.shard !== shard) await startShard(record.shard);
      if (record.key !== key) await startKey(record.key);
      for (const denseId of record.denseIds) {
        let delta = postingCount === 0 ? denseId : denseId - previousDenseId;
        if (!Number.isSafeInteger(delta) || delta < 0 || delta > 0xffffffff) throw new RangeError(`Posting delta ${delta} is outside uint32`);
        if (pendingBytes + 5 > pending.length) await flushBytes();
        do {
          let byte = delta & 0x7f;
          delta >>>= 7;
          if (delta > 0) byte |= 0x80;
          pending[pendingBytes++] = byte;
        } while (delta > 0);
        previousDenseId = denseId;
        postingCount += 1;
      }
      previousRecord = record;
    }
    const next = await current.reader.next();
    if (!next.done) {
      current.record = next.value;
      pushRun(active, current);
    }
  }
  await finishShard();
  return columns;
}

export async function buildCompactCASPostingArtifacts(
  cas: Pick<CASOutput, 'nodes'>,
  graph: CompactCASGraph,
  directory: string,
  shardCount = COMPACT_CAS_SEARCH_SHARDS,
  runByteLimit = Number(process.env.KLAURO_COMPACT_POSTING_RUN_BYTES) || DEFAULT_RUN_BYTES,
): Promise<CompactCASPostingArtifacts> {
  if (!Number.isSafeInteger(runByteLimit) || runByteLimit < 1 || runByteLimit > MAX_RUN_BYTES) {
    throw new RangeError(`Compact CAS posting run byte limit must be from 1 through ${MAX_RUN_BYTES}`);
  }
  if (runByteLimit === DEFAULT_RUN_BYTES) runByteLimit = Math.max(MIN_RUN_BYTES, Math.min(MAX_RUN_BYTES, runByteLimit));
  const startedAt = Date.now();
  const runDir = path.join(directory, 'search-posting-runs');
  await fs.ensureDir(runDir);
  const runPaths: string[] = [];
  let postings = Array.from({ length: shardCount }, () => new Map<string, number[]>());
  let bufferedRecords = 0;
  let bufferedBytes = 0;
  let recordCount = 0;
  const flushRun = async (): Promise<void> => {
    if (bufferedRecords === 0) return;
    const runPath = path.join(runDir, `run-${runPaths.length}.bin`);
    await writeRun(postings, runPath);
    runPaths.push(runPath);
    postings = Array.from({ length: shardCount }, () => new Map<string, number[]>());
    bufferedRecords = 0;
    bufferedBytes = 0;
  };
  for (const [key, denseId] of iterateCompactCASSearchPostings(cas, graph)) {
    const shard = compactCASPostingShard(key, shardCount);
    const ordinals = postings[shard].get(key) || [];
    if (ordinals.length === 0) bufferedBytes += Buffer.byteLength(key, 'utf8') + 64;
    ordinals.push(denseId);
    postings[shard].set(key, ordinals);
    bufferedRecords += 1;
    bufferedBytes += 8;
    recordCount += 1;
    if (bufferedBytes >= runByteLimit) await flushRun();
  }
  await flushRun();
  process.stderr.write(`${JSON.stringify({ event: 'compact_cas_postings_emitted', records: recordCount, runs: runPaths.length, ...phaseSnapshot(startedAt) })}\n`);

  const mergeStartedAt = Date.now();
  const columns = await mergeRuns(runPaths, directory);
  process.stderr.write(`${JSON.stringify({ event: 'compact_cas_postings_merged', runs: runPaths.length, ...phaseSnapshot(mergeStartedAt) })}\n`);
  await fs.remove(runDir);
  return { columns, shardCount, recordCount, runCount: runPaths.length };
}

export function decodeCompactCASPostingShard(
  bytes: Uint8Array,
  requestedKeys: ReadonlySet<string>,
  nodeCount: number,
): Map<string, Uint32Array> {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buffer.length < MAGIC.length + 4 || !buffer.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('Compact CAS posting shard has invalid format or version');
  }
  let offset = MAGIC.length;
  const entryCount = buffer.readUInt32LE(offset);
  offset += 4;
  const result = new Map<string, Uint32Array>();
  let previousKey = '';
  for (let entry = 0; entry < entryCount; entry += 1) {
    if (offset + 4 > buffer.length) throw new Error('Compact CAS posting shard is truncated before a key');
    const keyBytes = buffer.readUInt32LE(offset);
    offset += 4;
    if (offset + keyBytes + 4 > buffer.length) throw new Error('Compact CAS posting shard key exceeds file bounds');
    const key = buffer.subarray(offset, offset + keyBytes).toString('utf8');
    offset += keyBytes;
    if (entry > 0 && key <= previousKey) throw new Error('Compact CAS posting shard keys are not strictly sorted');
    previousKey = key;
    const count = buffer.readUInt32LE(offset);
    offset += 4;
    const ordinals = requestedKeys.has(key) ? new Uint32Array(count) : undefined;
    let ordinal = 0;
    for (let index = 0; index < count; index += 1) {
      let delta = 0;
      let shift = 0;
      while (true) {
        if (offset >= buffer.length || shift > 28) throw new Error(`Compact CAS posting '${key}' has an invalid varint`);
        const byte = buffer[offset++];
        delta |= (byte & 0x7f) << shift;
        if ((byte & 0x80) === 0) break;
        shift += 7;
      }
      if (index > 0 && delta === 0) throw new Error(`Compact CAS posting '${key}' contains a duplicate ordinal`);
      const nextOrdinal = index === 0 ? delta : ordinal + delta;
      if (nextOrdinal > 0xffffffff || nextOrdinal >= nodeCount) {
        throw new Error(`Compact CAS posting '${key}' ordinal ${nextOrdinal} is outside ${nodeCount}`);
      }
      ordinal = nextOrdinal >>> 0;
      if (ordinals) ordinals[index] = ordinal;
    }
    if (ordinals) {
      validatePosting(key, ordinals, nodeCount);
      result.set(key, ordinals);
    }
  }
  if (offset !== buffer.length) throw new Error('Compact CAS posting shard has trailing bytes');
  return result;
}
