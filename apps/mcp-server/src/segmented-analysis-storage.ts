import { writeCasRecordStore, writeCasSemanticStore } from './cas-record-store';
import * as crypto from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'fs-extra';
import { open, rename } from 'node:fs/promises';
import * as zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import pLimit from 'p-limit';
import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import type { SubCasNodeIndex } from './deployable-analysis';
import {
  createCasSectionManifest,
  selectExactCasSection,
  validateCasTreeProjection,
  type CasRawColumnDescriptor,
  type CasSectionManifest,
  type CasTreeNodeDescriptor,
  type CasTreeProjectionV2,
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
import { compressionCodecForPath, writeCompressedChunksAtomic } from './json-storage-writer';

interface SegmentedAnalysisPointerV1 {
  manifest_version: 1;
  revision: string;
}

interface SegmentedAnalysisPointerV2 {
  manifest_version: 2;
  current: string;
  previous?: string;
}

type SegmentedAnalysisPointer = SegmentedAnalysisPointerV1 | SegmentedAnalysisPointerV2;

type JsonWriter = (
  filePath: string,
  value: unknown,
  options?: { spaces?: number },
) => Promise<void>;

const segmentedWriteLocks = new Map<string, Promise<void>>();
const DEFAULT_SEGMENT_WRITE_LOCK_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_SEGMENT_WRITE_LOCK_STALE_MS = 15 * 60 * 1000;
const DEFAULT_SEGMENT_GENERATION_GRACE_MS = 15 * 60 * 1000;

function generationGraceMs(): number {
  const configured = Number(process.env.KLAURO_SEGMENT_GENERATION_GRACE_MS);
  return Number.isFinite(configured) && configured >= DEFAULT_SEGMENT_GENERATION_GRACE_MS
    ? configured
    : DEFAULT_SEGMENT_GENERATION_GRACE_MS;
}

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
  options: { rootOnlyTree?: boolean; childProjections?: Iterable<CASOutput>; subCasNodes?: SubCasNodeIndex } = {},
): Promise<void> {
  const root = segmentedAnalysisRoot(filePath);
  const previous = segmentedWriteLocks.get(root) || Promise.resolve();
  let release!: () => void;
  const active = new Promise<void>(resolve => { release = resolve; });
  const queued = previous.then(() => active);
  segmentedWriteLocks.set(root, queued);
  await previous;
  let releaseFileLock: (() => Promise<void>) | undefined;
  try {
    releaseFileLock = await acquireSegmentedWriteLock(root);
    await writeSegmentedAnalysisUnlocked(filePath, output, extension, writeCompressedJson, writeJson, isCurrent, options);
  } finally {
    if (releaseFileLock) await releaseFileLock();
    release();
    if (segmentedWriteLocks.get(root) === queued) segmentedWriteLocks.delete(root);
  }
}

async function acquireSegmentedWriteLock(root: string): Promise<() => Promise<void>> {
  await fs.ensureDir(root);
  const lockPath = path.join(root, '.write-lock');
  const configuredTimeout = Number(process.env.KLAURO_SEGMENT_WRITE_LOCK_TIMEOUT_MS);
  const configuredStale = Number(process.env.KLAURO_SEGMENT_WRITE_LOCK_STALE_MS);
  const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0
    ? configuredTimeout
    : DEFAULT_SEGMENT_WRITE_LOCK_TIMEOUT_MS;
  const staleMs = Number.isFinite(configuredStale) && configuredStale > 0
    ? configuredStale
    : DEFAULT_SEGMENT_WRITE_LOCK_STALE_MS;
  const deadline = Date.now() + timeoutMs;
  const token = `${process.pid}-${Date.now()}-${crypto.randomBytes(8).toString('hex')}`;
  while (true) {
    try {
      await fs.mkdir(lockPath);
      await fs.writeFile(path.join(lockPath, 'owner'), token);
      await syncDirectory(root);
      const heartbeat = setInterval(() => {
        const now = new Date();
        void fs.utimes(lockPath, now, now).catch(() => undefined);
      }, Math.max(1_000, Math.min(30_000, Math.floor(staleMs / 3))));
      heartbeat.unref();
      return async () => {
        clearInterval(heartbeat);
        const owner = await fs.readFile(path.join(lockPath, 'owner'), 'utf8').catch(() => null);
        if (owner === token) await fs.remove(lockPath).catch(() => undefined);
        await syncDirectory(root).catch(() => undefined);
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const stat = await fs.stat(lockPath).catch(() => null);
      if (stat && stat.mtimeMs < Date.now() - staleMs) {
        await fs.remove(lockPath).catch(() => undefined);
        continue;
      }
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for segmented analysis writer lock at ${lockPath}`);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
}

async function syncGenerationFiles(directory: string): Promise<void> {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const handle = await open(path.join(directory, entry.name), 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}

async function writeSegmentedAnalysisUnlocked(
  filePath: string,
  output: CASOutput,
  extension: string,
  writeCompressedJson: JsonWriter,
  writeJson: JsonWriter,
  isCurrent: () => boolean,
  options: { rootOnlyTree?: boolean; childProjections?: Iterable<CASOutput>; subCasNodes?: SubCasNodeIndex },
): Promise<void> {
  if (!isCurrent()) return;
  const root = segmentedAnalysisRoot(filePath);
  const staging = `staging-${process.pid}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
  const tmpDir = path.join(root, staging);
  const manifest = createCasSectionManifest(output);
  const projectedChildren = options.rootOnlyTree ? [...(options.childProjections || [])] : [];
  let recursiveProjection: CasTreeProjectionV2 | undefined;
  if (options.rootOnlyTree) {
    const rootId = output.id || output.analysis_id;
    const rootFields = Object.entries(output).filter(([, value]) => value !== undefined).map(([field]) => field);
    recursiveProjection = {
      format: 'recursive-cas-section-references',
      version: 2,
      root_id: rootId,
      ...(options.subCasNodes ? { sub_cas_nodes: options.subCasNodes } : {}),
      nodes: [{
        id: rootId,
        parent_id: null,
        child_ids: projectedChildren.map(child => child.id || child.analysis_id),
        logical_fields: [...new Set([...rootFields, ...(projectedChildren.length > 0 ? ['children'] : [])])].sort(),
        sections: manifest.sections,
      }],
    };
    manifest.tree_projection = recursiveProjection;
  }
  try {
    await fs.ensureDir(tmpDir);
    const sectionMetrics: Array<{ name: string; duration_ms: number; bytes: number }> = [];
    const writeSection = pLimit(4);
    await Promise.all(manifest.sections.map(descriptor => writeSection(async () => {
      const startedAt = Date.now();
      const sectionFile = `${descriptor.name}.json${extension}`;
      const sectionPath = path.join(tmpDir, sectionFile);
      await writeCompressedJson(sectionPath, selectExactCasSection(output, descriptor.name), { spaces: 0 });
      const stat = await fs.stat(sectionPath);
      descriptor.file = sectionFile;
      descriptor.bytes = stat.size;
      descriptor.sha256 = await checksumFile(sectionPath);
      sectionMetrics.push({ name: descriptor.name, duration_ms: Date.now() - startedAt, bytes: stat.size });
    })));
    if (recursiveProjection) {
      const seen = new Set<string>([recursiveProjection.root_id]);
      const stack = projectedChildren.slice().reverse();
      let childOrdinal = 0;
      while (stack.length > 0) {
        const child = stack.pop()!;
        const childId = child.id || child.analysis_id;
        if (seen.has(childId)) throw new Error(`Recursive CAS tree projection contains duplicate id ${childId}`);
        seen.add(childId);
        const nestedChildren = child.children || [];
        const { children: _children, ...childBody } = child;
        const childManifest = createCasSectionManifest(childBody as CASOutput);
        const childFields = Object.entries(childBody).filter(([, value]) => value !== undefined).map(([field]) => field);
        const descriptors: CasTreeNodeDescriptor['sections'] = childManifest.sections;
        for (const descriptor of descriptors) {
          const childStartedAt = Date.now();
          const temporaryFile = `tree.tmp.${childOrdinal}.${descriptor.name}.json${extension}`;
          const temporaryPath = path.join(tmpDir, temporaryFile);
          await writeCompressedJson(temporaryPath, selectExactCasSection(childBody as CASOutput, descriptor.name), { spaces: 0 });
          const stat = await fs.stat(temporaryPath);
          const sha256 = await checksumFile(temporaryPath);
          const childFile = `tree.${sha256}.json${extension}`;
          const childPath = path.join(tmpDir, childFile);
          if (await fs.pathExists(childPath)) await fs.remove(temporaryPath);
          else await rename(temporaryPath, childPath);
          descriptor.file = childFile;
          descriptor.bytes = stat.size;
          descriptor.sha256 = sha256;
          sectionMetrics.push({ name: `tree.child.${childOrdinal}.${descriptor.name}`, duration_ms: Date.now() - childStartedAt, bytes: stat.size });
        }
        recursiveProjection.nodes.push({
          id: childId,
          parent_id: child.parent_id ?? null,
          child_ids: nestedChildren.map(nested => nested.id || nested.analysis_id),
          logical_fields: [...new Set([...childFields, ...(nestedChildren.length > 0 ? ['children'] : [])])].sort(),
          sections: descriptors,
        });
        for (let index = nestedChildren.length - 1; index >= 0; index -= 1) stack.push(nestedChildren[index]);
        childOrdinal += 1;
      }
      validateCasTreeProjection(recursiveProjection);
    }
    process.stderr.write(`${JSON.stringify({ event: 'segmented_cas_sections_written', sections: sectionMetrics.sort((left, right) => left.name.localeCompare(right.name)) })}\n`);
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
    }
    const postingArtifacts = await buildCompactCASPostingArtifacts(output, compactGraph, tmpDir);
    Object.assign(searchColumns, postingArtifacts.columns);
    manifest.compact_search = {
      format: 'klauro-compact-cas-search',
      version: 3,
      node_count: compactGraph.nodeCount,
      description_chunk_nodes: COMPACT_CAS_SEARCH_CHUNK_NODES,
      shard_count: postingArtifacts.shardCount,
      nonempty_shards: Object.keys(postingArtifacts.columns).map(name => Number(name.slice(name.lastIndexOf('.') + 1))).sort((left, right) => left - right),
      posting_records: postingArtifacts.recordCount,
      posting_runs: postingArtifacts.runCount,
      columns: searchColumns,
    };
    const recordStore = process.env.KLAURO_CAS_RECORD_STORE === '0' ? { skipped: 'disabled by KLAURO_CAS_RECORD_STORE=0' } : await writeCasRecordStore(tmpDir, output, compactGraph);
    if ('descriptor' in recordStore) manifest.record_store = recordStore.descriptor;
    else process.stderr.write(`${JSON.stringify({ event: 'cas_record_store_skipped', reason: recordStore.skipped })}\n`);
    if ('descriptor' in recordStore) {
      const semanticStore = await writeCasSemanticStore(tmpDir, output, compactGraph);
      if ('descriptor' in semanticStore) manifest.semantic_store = semanticStore.descriptor;
      else process.stderr.write(`${JSON.stringify({ event: 'cas_semantic_store_skipped', reason: semanticStore.skipped })}\n`);
    }
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
    const manifestPath = path.join(tmpDir, 'manifest.json');
    await writeJson(manifestPath, manifest, { spaces: 2 });
    if (!isCurrent()) return;
    await fs.ensureDir(root);
    const manifestHash = crypto.createHash('sha256').update(await fs.readFile(manifestPath)).digest('hex');
    const generation = `gen-${manifestHash}`;
    const generationDir = path.join(root, generation);
    if (await fs.pathExists(generationDir)) await fs.remove(tmpDir);
    else {
      await syncGenerationFiles(tmpDir);
      await syncDirectory(tmpDir);
      await rename(tmpDir, generationDir);
      await syncDirectory(root);
    }
    if (!isCurrent()) {
      return;
    }
    const prior = await fs.readJson(path.join(root, 'current.json')).catch(() => null) as SegmentedAnalysisPointer | null;
    const previous = prior?.manifest_version === 2
      ? prior.current === generation ? prior.previous : prior.current
      : prior?.manifest_version === 1 ? prior.revision : undefined;
    await writeJson(path.join(root, 'current.json'), {
      manifest_version: 2,
      current: generation,
      ...(previous && previous !== generation ? { previous } : {}),
    } satisfies SegmentedAnalysisPointerV2, { spaces: 2 });
    if (!isCurrent()) {
      const currentPath = path.join(root, 'current.json');
      const current = await fs.readJson(currentPath).catch(() => null) as SegmentedAnalysisPointer | null;
      if (current?.manifest_version === 2 && current.current === generation) {
        if (prior) await writeJson(currentPath, prior, { spaces: 2 });
        else await fs.remove(currentPath).catch(() => undefined);
      }
      return;
    }
    const retained = new Set([generation, previous].filter((value): value is string => Boolean(value)));
    const graceMs = generationGraceMs();
    const reclaimBefore = Date.now() - graceMs;
    for (const candidate of await fs.readdir(root).catch(() => [])) {
      if ((!candidate.startsWith('gen-') && !candidate.startsWith('rev-')) || retained.has(candidate)) continue;
      if (await generationHasActiveLease(root, candidate, reclaimBefore)) continue;
      const candidatePath = path.join(root, candidate);
      const stat = await fs.stat(candidatePath).catch(() => null);
      if (stat && stat.mtimeMs < reclaimBefore) {
        await fs.remove(candidatePath).catch(() => undefined);
        await fs.remove(segmentedLegacyExportPath(filePath, candidate)).catch(() => undefined);
      }
    }
  } finally {
    await fs.remove(tmpDir).catch(() => undefined);
  }
}

async function generationHasActiveLease(root: string, generation: string, reclaimBefore: number): Promise<boolean> {
  const directory = path.join(root, '.read-leases', generation);
  let active = false;
  for (const file of await fs.readdir(directory).catch(() => [])) {
    const lease = path.join(directory, file);
    const stat = await fs.stat(lease).catch(() => null);
    if (stat && stat.mtimeMs >= reclaimBefore) active = true;
    else await fs.remove(lease).catch(() => undefined);
  }
  if (!active) await fs.rmdir(directory).catch(() => undefined);
  return active;
}

function encodeUint32LittleEndian(values: Uint32Array): Buffer {
  const bytes = Buffer.allocUnsafe(values.length * 4);
  for (let index = 0; index < values.length; index += 1) bytes.writeUInt32LE(values[index], index * 4);
  return bytes;
}

async function checksumFile(filePath: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function* decodedFile(filePath: string): AsyncGenerator<Buffer> {
  const codec = compressionCodecForPath(filePath);
  if (codec === 'none') {
    for await (const chunk of fs.createReadStream(filePath)) yield chunk as Buffer;
    return;
  }
  if (codec === 'brotli') {
    const stream = fs.createReadStream(filePath).pipe(zlib.createBrotliDecompress());
    for await (const chunk of stream) yield chunk as Buffer;
    return;
  }
  const child = spawn('zstd', ['-q', '-d', '-c', filePath], { stdio: ['ignore', 'pipe', 'pipe'] });
  const stderr: Buffer[] = [];
  let stderrBytes = 0;
  child.stderr.on('data', chunk => {
    if (stderrBytes >= 1024 * 1024) return;
    const bytes = chunk as Buffer;
    stderr.push(bytes);
    stderrBytes += bytes.length;
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  let completed = false;
  try {
    for await (const chunk of child.stdout) yield chunk as Buffer;
    const result = await exited;
    completed = true;
    if (result.code !== 0) throw new Error(`zstd decode failed ${result.signal ? `with ${result.signal}` : `with code ${result.code}`}: ${Buffer.concat(stderr).toString('utf8')}`);
  } finally {
    if (!completed) {
      child.kill('SIGTERM');
      await exited.catch(() => undefined);
    }
  }
}

async function validateArtifact(
  directory: string,
  descriptor: { file: string; bytes?: number; sha256?: string },
  label: string,
): Promise<string> {
  if (path.basename(descriptor.file) !== descriptor.file) throw new Error(`${label} has an invalid path`);
  const filePath = path.join(directory, descriptor.file);
  const stat = await fs.stat(filePath);
  if (descriptor.bytes !== undefined && stat.size !== descriptor.bytes) throw new Error(`${label} byte length mismatch`);
  if (descriptor.sha256 && await checksumFile(filePath) !== descriptor.sha256) throw new Error(`${label} checksum mismatch`);
  return filePath;
}

async function* jsonObjectInterior(filePath: string): AsyncGenerator<Buffer> {
  let carry: Buffer = Buffer.alloc(0);
  let opened = false;
  for await (const chunk of decodedFile(filePath)) {
    let bytes = carry.length > 0 ? Buffer.concat([carry, chunk]) : chunk;
    if (!opened) {
      let offset = 0;
      while (offset < bytes.length && /\s/.test(String.fromCharCode(bytes[offset]))) offset += 1;
      if (offset === bytes.length) {
        carry = bytes;
        continue;
      }
      if (bytes[offset] !== 0x7b) throw new Error(`Segmented JSON object ${filePath} does not start with '{'`);
      bytes = bytes.subarray(offset + 1);
      opened = true;
    }
    if (bytes.length <= 64) {
      carry = Buffer.from(bytes);
      continue;
    }
    yield bytes.subarray(0, bytes.length - 64);
    carry = Buffer.from(bytes.subarray(bytes.length - 64));
  }
  if (!opened) throw new Error(`Segmented JSON object ${filePath} is empty`);
  let end = carry.length;
  while (end > 0 && /\s/.test(String.fromCharCode(carry[end - 1]))) end -= 1;
  if (end === 0 || carry[end - 1] !== 0x7d) throw new Error(`Segmented JSON object ${filePath} does not end with '}'`);
  if (end > 1) yield carry.subarray(0, end - 1);
}

export function segmentedLegacyExportPath(filePath: string, generation: string): string {
  const suffix = filePath.endsWith('.json.zst') ? '.json.zst' : filePath.endsWith('.json.br') ? '.json.br' : '.json';
  return `${filePath.slice(0, -suffix.length)}.export-${generation}${suffix}`;
}

export async function writeSegmentedLegacyExport(
  filePath: string,
  targetPath: string,
  pinned?: ResolvedSegmentedAnalysis,
): Promise<void> {
  const lease = pinned ? null : await acquireSegmentedAnalysisLease(filePath);
  const segmented = pinned || lease?.segmented;
  if (!segmented) throw new Error('Canonical segmented analysis is unavailable for legacy export');
  try {
    const chunks = (async function* (): AsyncGenerator<Buffer | string> {
      const projection = segmented.manifest.tree_projection;
      const emitFields = async function* (descriptors: CasTreeNodeDescriptor['sections']): AsyncGenerator<Buffer | string, boolean> {
        let first = true;
        for (const descriptor of descriptors) {
          if (!descriptor.file) throw new Error(`Segmented CAS section '${descriptor.name}' has no artifact`);
          const sectionPath = await validateArtifact(
            segmented.directory,
            { ...descriptor, file: descriptor.file },
            `Segmented CAS section '${descriptor.name}'`,
          );
          const interior = jsonObjectInterior(sectionPath)[Symbol.asyncIterator]();
          const head = await interior.next();
          if (head.done) continue;
          if (!first) yield ',';
          yield head.value;
          while (true) {
            const next = await interior.next();
            if (next.done) break;
            yield next.value;
          }
          first = false;
        }
        return !first;
      };

      if (projection?.format === 'recursive-cas-section-references' && projection.version === 2) {
        validateCasTreeProjection(projection);
        const byId = new Map(projection.nodes.map(node => [node.id, node]));
        const stack: Array<{ node: CasTreeNodeDescriptor; state: 'start' | 'children'; nextChild: number; hasFields: boolean }> = [{
          node: byId.get(projection.root_id)!,
          state: 'start',
          nextChild: 0,
          hasFields: false,
        }];
        while (stack.length > 0) {
          const frame = stack[stack.length - 1];
          if (frame.state === 'start') {
            yield '{';
            const fields = emitFields(frame.node.sections);
            while (true) {
              const next = await fields.next();
              if (next.done) {
                frame.hasFields = next.value;
                break;
              }
              yield next.value;
            }
            if (frame.node.child_ids.length === 0) {
              yield '}';
              stack.pop();
              continue;
            }
            if (frame.hasFields) yield ',';
            yield '"children":[';
            frame.state = 'children';
            continue;
          }
          if (frame.nextChild >= frame.node.child_ids.length) {
            yield ']}';
            stack.pop();
            continue;
          }
          if (frame.nextChild > 0) yield ',';
          const childId = frame.node.child_ids[frame.nextChild++];
          stack.push({ node: byId.get(childId)!, state: 'start', nextChild: 0, hasFields: false });
        }
        yield '\n';
        return;
      }

      yield '{';
      const rootFields = emitFields(segmented.manifest.sections);
      let first = true;
      while (true) {
        const next = await rootFields.next();
        if (next.done) {
          first = !next.value;
          break;
        }
        yield next.value;
      }
      if (projection && (projection.format !== 'derived-deployable-references' || projection.version !== 1)) {
        throw new Error('CAS tree projection format or version is unsupported');
      }
      const children = projection?.children || [];
      if (children.length > 0) {
        if (!first) yield ',';
        yield '"children":[';
        for (let index = 0; index < children.length; index += 1) {
          const child = children[index];
          const childPath = await validateArtifact(segmented.directory, child, `Deployable child '${child.id}'`);
          if (index > 0) yield ',';
          yield* decodedFile(childPath);
        }
        yield ']';
      }
      yield '}\n';
    })();
    await writeCompressedChunksAtomic(targetPath, chunks);
  } finally {
    await lease?.release();
  }
}

async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
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

export async function loadCompactCASGraph(
  filePath: string,
  pinned?: ResolvedSegmentedAnalysis,
): Promise<CompactCASGraph | null> {
  const segmented = pinned || await resolveSegmentedAnalysis(filePath);
  return segmented ? loadCompactCASGraphFromGeneration(segmented) : null;
}

async function loadCompactCASGraphFromGeneration(
  segmented: { directory: string; manifest: CasSectionManifest },
): Promise<CompactCASGraph | null> {
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

export interface ResolvedSegmentedAnalysis {
  directory: string;
  manifest: CasSectionManifest;
}

export async function loadCompactCASSearch(
  filePath: string,
  pinned?: ResolvedSegmentedAnalysis,
): Promise<LoadedCompactCASSearch | null> {
  const segmented = pinned || await resolveSegmentedAnalysis(filePath);
  const descriptor = segmented?.manifest.compact_search;
  if (!segmented || !descriptor) return null;
  if (descriptor.format !== 'klauro-compact-cas-search' || ![2, 3].includes(descriptor.version)) {
    throw new Error('Compact CAS search format or version is unsupported');
  }
  const graph = await loadCompactCASGraphFromGeneration(segmented);
  if (!graph) throw new Error('Compact CAS search exists without its compact graph');
  if (descriptor.node_count !== graph.nodeCount) throw new Error('Compact CAS search cardinality does not match its graph');
  if (!Number.isSafeInteger(descriptor.description_chunk_nodes) || descriptor.description_chunk_nodes < 1) {
    throw new Error('Compact CAS search description chunk size is invalid');
  }
  const loaded = new Map<string, Uint8Array | Uint32Array>();
  for (const name of ['description.offsets']) {
    const column = descriptor.columns[name];
    if (!column) throw new Error(`Compact CAS search column '${name}' is missing from the manifest`);
    loaded.set(name, await readRawColumn(segmented.directory, name, column, 'search'));
  }
  const u32 = (name: string): Uint32Array => requiredColumn(loaded, name, Uint32Array);
  const index: CompactCASSearchHotIndex = {
    textChunkNodes: descriptor.description_chunk_nodes,
    descriptionOffsets: u32('description.offsets'),
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
    for (const [prefix, offsets] of [['description', index.descriptionOffsets]] as const) {
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
  const descriptions = new Map<number, { description: string }>();
  const decoder = new TextDecoder();
  for (const [chunk, ordinals] of byChunk) {
    const firstDenseId = chunk * descriptor.description_chunk_nodes;
    const loadChunk = async (): Promise<{ bytes: Uint8Array; offsets: Uint32Array }> => {
      const prefix = 'description';
      const name = `${prefix}.chunks.${chunk}`;
      const column = descriptor.columns[name];
      if (!column) throw new Error(`Compact CAS search column '${name}' is missing from the manifest`);
      const bytes = await readRawColumn(directory, name, column, 'search');
      if (!(bytes instanceof Uint8Array) || bytes instanceof Uint32Array) {
        throw new Error(`Compact CAS search column '${name}' has the wrong encoding`);
      }
      return { bytes, offsets: index.descriptionOffsets };
    };
    const descriptionChunk = await loadChunk();
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
): Promise<ResolvedSegmentedAnalysis | null> {
  const root = segmentedAnalysisRoot(filePath);
  let pointer: SegmentedAnalysisPointer;
  try {
    pointer = await fs.readJson(path.join(root, 'current.json')) as SegmentedAnalysisPointer;
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code || '')) return null;
    throw new Error(`Segmented analysis pointer is unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
  const generations = pointer.manifest_version === 2
    ? [pointer.current, pointer.previous].filter((value): value is string => Boolean(value))
    : pointer.manifest_version === 1 && pointer.revision ? [pointer.revision] : [];
  let lastError: unknown;
  for (const generation of generations) {
    try {
      if (path.basename(generation) !== generation) throw new Error('generation name is invalid');
      if (pointer.manifest_version === 2 && !/^gen-[a-f0-9]{64}$/.test(generation)) {
        throw new Error('content-addressed generation name is invalid');
      }
      const directory = path.join(root, generation);
      const manifestBytes = await fs.readFile(path.join(directory, 'manifest.json'));
      if (pointer.manifest_version === 2) {
        const expected = generation.slice(4);
        const actual = crypto.createHash('sha256').update(manifestBytes).digest('hex');
        if (actual !== expected) throw new Error('generation manifest checksum mismatch');
      }
      const manifest = JSON.parse(manifestBytes.toString('utf8')) as CasSectionManifest;
      if (manifest.manifest_version !== 1) throw new Error('generation manifest version is unsupported');
      if (manifest.tree_projection?.format === 'recursive-cas-section-references') {
        if (manifest.tree_projection.version !== 2) throw new Error('recursive CAS tree projection version is unsupported');
        validateCasTreeProjection(manifest.tree_projection);
      }
      return { directory, manifest };
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`Segmented analysis pointer has no checksum-valid generation${lastError instanceof Error ? `: ${lastError.message}` : ''}`);
}

export async function acquireSegmentedAnalysisLease(
  filePath: string,
): Promise<{ segmented: ResolvedSegmentedAnalysis; release: () => Promise<void> } | null> {
  const root = segmentedAnalysisRoot(filePath);
  const releaseWriterLock = await acquireSegmentedWriteLock(root);
  try {
    const segmented = await resolveSegmentedAnalysis(filePath);
    if (!segmented) return null;
    const generation = path.basename(segmented.directory);
    const leaseDirectory = path.join(root, '.read-leases', generation);
    const leasePath = path.join(leaseDirectory, `${process.pid}-${Date.now()}-${crypto.randomBytes(8).toString('hex')}`);
    await fs.ensureDir(leaseDirectory);
    await fs.writeFile(leasePath, '');
    const heartbeat = setInterval(() => {
      const now = new Date();
      void fs.utimes(leasePath, now, now).catch(() => undefined);
    }, Math.max(1_000, Math.min(30_000, Math.floor(generationGraceMs() / 3))));
    heartbeat.unref();
    return {
      segmented,
      release: async () => {
        clearInterval(heartbeat);
        await fs.remove(leasePath).catch(() => undefined);
        await fs.rmdir(leaseDirectory).catch(() => undefined);
      },
    };
  } finally {
    await releaseWriterLock();
  }
}
