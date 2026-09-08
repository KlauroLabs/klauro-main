import * as crypto from 'node:crypto';
import * as path from 'node:path';
import * as fs from 'fs-extra';
import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import type { CasRawColumnDescriptor, CasSectionManifest } from './cas-sections';
import { encodeCompactCASGraph, validateCompactCASParity } from '../../../packages/analyzer-core/src/analyzer/core/compact-cas-graph';
import { COMPACT_CAS_SEARCH_CHUNK_NODES, encodeCompactCASSearchText } from '../../../packages/analyzer-core/src/analyzer/core/compact-cas-search';
import { buildCompactCASPostingArtifacts } from './compact-cas-search-storage';
import { writeCasRecordStore, writeCasSemanticStore } from './cas-record-store';

export function encodeUint32LittleEndian(values: Uint32Array): Buffer {
  const bytes = Buffer.allocUnsafe(values.length * 4);
  for (let index = 0; index < values.length; index += 1) bytes.writeUInt32LE(values[index], index * 4);
  return bytes;
}

export async function buildSegmentedSidecar(tmpDir: string, output: CASOutput, manifest: CasSectionManifest): Promise<void> {
  const compactStartedAt = Date.now();
  const stages: Record<string, number> = {};
  let stageStartedAt = compactStartedAt;
  const mark = (name: string): void => { const now = Date.now(); stages[name] = now - stageStartedAt; stageStartedAt = now; };
  const compactGraph = encodeCompactCASGraph(output);
  const parity = validateCompactCASParity(compactGraph, output);
  if (!parity.ok) throw new Error(`Compact CAS graph parity failed: ${parity.errors.join('; ')}`);
  mark('encode_parity_ms');
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
  mark('graph_columns_ms');
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
  mark('search_text_ms');
  const postingArtifacts = await buildCompactCASPostingArtifacts(output, compactGraph, tmpDir);
  mark('postings_ms');
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
  mark('record_store_ms');
  if ('descriptor' in recordStore) manifest.record_store = recordStore.descriptor;
  else process.stderr.write(`${JSON.stringify({ event: 'cas_record_store_skipped', reason: recordStore.skipped })}\n`);
  if ('descriptor' in recordStore) {
    const semanticStore = await writeCasSemanticStore(tmpDir, output, compactGraph, manifest.collection_bytes ?? {});
    if ('descriptor' in semanticStore) manifest.semantic_store = semanticStore.descriptor;
    else process.stderr.write(`${JSON.stringify({ event: 'cas_semantic_store_skipped', reason: semanticStore.skipped })}\n`);
  }
  mark('semantic_store_ms');
  const compactDurationMs = Date.now() - compactStartedAt;
  if (compactDurationMs >= 1_000) {
    process.stderr.write(`${JSON.stringify({
      event: 'compact_cas_sidecar_built',
      duration_ms: compactDurationMs,
      stages,
      graph_bytes: Object.values(compactColumns).reduce((sum, column) => sum + column.bytes, 0),
      search_bytes: Object.values(searchColumns).reduce((sum, column) => sum + column.bytes, 0),
      posting_records: postingArtifacts.recordCount,
      posting_runs: postingArtifacts.runCount,
      rss_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      max_rss_mb: Math.round(process.resourceUsage().maxRSS / 1024),
    })}\n`);
  }
}
