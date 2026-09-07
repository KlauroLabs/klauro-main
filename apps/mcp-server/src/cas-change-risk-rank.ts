import type { CompactCASGraph } from '../../../packages/analyzer-core/src/analyzer/core/compact-cas-graph';
import { rankChangeRisks } from './change-risk-rank';
import type { CasRawColumnDescriptor } from './cas-sections';

export const CHANGE_RISK_RANK_NO_NODE = 0xffff_ffff;
const UINT32_BYTES = 4;
const HIGH_LEVELS = new Set(['critical', 'high']);

export type CasUint32ColumnDescriptor = CasRawColumnDescriptor & { encoding: 'uint32-le'; length: number };
export type CasColumnReader = (name: string, column: CasRawColumnDescriptor | undefined, expectedBytes: number) => Promise<Buffer>;

function uint32ToBuffer(values: Uint32Array): Buffer {
  const buffer = Buffer.alloc(values.length * UINT32_BYTES);
  for (let index = 0; index < values.length; index += 1) buffer.writeUInt32LE(values[index], index * UINT32_BYTES);
  return buffer;
}

export interface CasChangeRiskRankDescriptor {
  count: number;
  high_or_critical: number;
  ordinals: CasUint32ColumnDescriptor;
  dense_ids: CasUint32ColumnDescriptor;
  ranks: CasUint32ColumnDescriptor;
}

export interface CasChangeRiskRanking {
  count: number;
  high_or_critical: number;
  ordinals: Uint32Array;
  denseIds: Uint32Array;
  ranks: Uint32Array;
}

export function buildChangeRiskRankColumns(records: readonly unknown[], graph: Pick<CompactCASGraph, 'nodeById'>): CasChangeRiskRanking {
  const ranked = rankChangeRisks(records);
  const ordinals = new Uint32Array(ranked.length);
  const denseIds = new Uint32Array(ranked.length);
  const ranks = new Uint32Array(ranked.length);
  let highOrCritical = 0;
  ranked.forEach((entry, position) => {
    ordinals[position] = entry.ordinal;
    denseIds[position] = graph.nodeById(entry.node_id)?.denseId ?? CHANGE_RISK_RANK_NO_NODE;
    ranks[position] = entry.rank;
  });
  for (const record of records) {
    if (HIGH_LEVELS.has(String((record as Record<string, unknown> | null)?.risk_level ?? '').toLowerCase())) highOrCritical += 1;
  }
  return { count: ranked.length, high_or_critical: highOrCritical, ordinals, denseIds, ranks };
}

export async function writeChangeRiskRankColumns(
  prefix: string,
  records: readonly unknown[],
  graph: Pick<CompactCASGraph, 'nodeById'>,
  writeRaw: (file: string, bytes: Buffer) => Promise<CasRawColumnDescriptor>,
): Promise<CasChangeRiskRankDescriptor> {
  const ranking = buildChangeRiskRankColumns(records, graph);
  const column = async (name: string, values: Uint32Array): Promise<CasUint32ColumnDescriptor> => ({
    ...(await writeRaw(`${prefix}.rank.${name}.bin`, uint32ToBuffer(values))), encoding: 'uint32-le', length: values.length,
  });
  return {
    count: ranking.count,
    high_or_critical: ranking.high_or_critical,
    ordinals: await column('ordinals', ranking.ordinals),
    dense_ids: await column('dense_ids', ranking.denseIds),
    ranks: await column('ranks', ranking.ranks),
  };
}

export async function readChangeRiskRankColumns(
  readColumn: CasColumnReader,
  prefix: string,
  extra: CasChangeRiskRankDescriptor,
  expected: { tableCount: number; nodeCount: number },
  ledger: { chargeIndex(bytes: number): void },
): Promise<CasChangeRiskRanking> {
  const count = extra.count;
  if (!Number.isInteger(count) || count < 0 || count !== expected.tableCount) throw new Error(`CAS change risk ranking count ${String(count)} does not match the change_risks table ${expected.tableCount}`);
  ledger.chargeIndex(3 * count * UINT32_BYTES);
  const read = async (name: string, column: CasUint32ColumnDescriptor): Promise<Uint32Array> => {
    if (column?.length !== count) throw new Error(`CAS change risk ranking column ${name} declares ${String(column?.length)} entries, expected ${count}`);
    const bytes = await readColumn(`${prefix}.rank.${name}`, column, count * UINT32_BYTES);
    return new Uint32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  };
  const ordinals = await read('ordinals', extra.ordinals);
  const denseIds = await read('dense_ids', extra.dense_ids);
  const ranks = await read('ranks', extra.ranks);
  const seen = new Uint8Array(count);
  for (let position = 0; position < count; position += 1) {
    const ordinal = ordinals[position];
    if (ordinal >= count || seen[ordinal]) throw new Error(`CAS change risk ranking ordinal ${ordinal} at position ${position} is out of range or repeated`);
    seen[ordinal] = 1;
    if (position > 0 && ranks[position] > ranks[position - 1]) throw new Error(`CAS change risk ranking is not descending at position ${position}`);
    if (denseIds[position] !== CHANGE_RISK_RANK_NO_NODE && denseIds[position] >= expected.nodeCount) throw new Error(`CAS change risk ranking dense id at position ${position} is out of range`);
  }
  if (!Number.isInteger(extra.high_or_critical) || extra.high_or_critical < 0 || extra.high_or_critical > count) throw new Error('CAS change risk ranking high_or_critical count is invalid');
  return { count, high_or_critical: extra.high_or_critical, ordinals, denseIds, ranks };
}
