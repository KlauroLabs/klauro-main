import type { CompactCASGraph } from '../../../packages/analyzer-core/src/analyzer/core/compact-cas-graph';
import type { CASChangeRisk } from '../../../packages/analyzer-core/src/types/cas.types';
import { CHANGE_RISK_RANK_NO_NODE } from './cas-change-risk-rank';
import { isSupportedCasSemanticStoreDescriptor, type CasRecordStoreReadStats, type CasSemanticStore } from './cas-record-store';
import { openPinnedSemanticStore, type PinnedAnalysisGeneration } from './hosted-query-scoped-graph';

export interface AgentRiskIndexEntry {
  ordinal: number;
  node_id: string;
  rank: number;
}

export interface AgentRiskIndex {
  total: number;
  highOrCritical: number;
  records: readonly AgentRiskIndexEntry[];
}

export interface AgentRiskSource {
  getIndex(): Promise<AgentRiskIndex>;
  read(ordinals: readonly number[]): Promise<ReadonlyMap<number, CASChangeRisk>>;
  stats(): CasRecordStoreReadStats;
}

function riskNodeId(record: unknown, ordinal: number): string {
  const id = (record as { node_id?: unknown } | null)?.node_id;
  if (typeof id !== 'string' || id.length === 0) throw new Error(`CAS change risk record ${ordinal} carries no node_id`);
  return id;
}

export async function createRankedRiskSource(pinned: PinnedAnalysisGeneration, graph: CompactCASGraph): Promise<AgentRiskSource | null> {
  const descriptor = pinned.segmented.manifest.semantic_store;
  if (!isSupportedCasSemanticStoreDescriptor(descriptor) || !descriptor.extras?.change_risk_rank) return null;
  const opening = openPinnedSemanticStore(pinned, graph);
  if (!opening) return null;
  const store: CasSemanticStore = await opening;
  let index: Promise<AgentRiskIndex> | undefined;
  const readRecords = async (ordinals: readonly number[]): Promise<Map<number, CASChangeRisk>> => {
    const wanted = [...new Set(ordinals)].sort((left, right) => left - right);
    const read = await store.readByOrdinals<CASChangeRisk>('change_risks', wanted);
    if (read.records.length !== wanted.length) throw new Error(`CAS change risk read returned ${read.records.length} records for ${wanted.length} ordinals`);
    return new Map(wanted.map((ordinal, position) => [ordinal, read.records[position]]));
  };
  const buildIndex = async (): Promise<AgentRiskIndex> => {
    const ranking = await store.readChangeRiskRanking();
    if (!ranking) throw new Error('CAS change risk ranking is absent from the pinned generation');
    const sentinels: number[] = [];
    for (let position = 0; position < ranking.count; position += 1) if (ranking.denseIds[position] === CHANGE_RISK_RANK_NO_NODE) sentinels.push(ranking.ordinals[position]);
    const sentinelRecords = sentinels.length ? await readRecords(sentinels) : new Map<number, CASChangeRisk>();
    const records: AgentRiskIndexEntry[] = [];
    for (let position = 0; position < ranking.count; position += 1) {
      const ordinal = ranking.ordinals[position];
      const dense = ranking.denseIds[position];
      const node_id = dense === CHANGE_RISK_RANK_NO_NODE ? riskNodeId(sentinelRecords.get(ordinal), ordinal) : graph.nodeAt(dense).id;
      records.push({ ordinal, node_id, rank: ranking.ranks[position] });
    }
    return { total: ranking.count, highOrCritical: ranking.high_or_critical, records };
  };
  return {
    getIndex: () => (index ??= buildIndex()),
    read: readRecords,
    stats: () => store.stats(),
  };
}
