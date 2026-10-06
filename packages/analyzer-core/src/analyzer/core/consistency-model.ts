export type ConsistencyModel = 'strong' | 'eventual' | 'tunable';
export type CapLean = 'CP' | 'AP' | 'CA' | null;
export interface ConsistencyPosture {
  model: ConsistencyModel;
  staleness_risk: boolean;
  cap_lean: CapLean;
  evidence: string;
}
export type PassiveChannelKind =
  | 'read_replica'
  | 'streaming_sink'
  | 'cdc'
  | 'materialized'
  | 'etl_load';
export interface PassiveDataSeam {
  id: string;
  modality: 'passive';
  confidence: number;
  channel: PassiveChannelKind;
  source: string;
  target: string;
  shared_resource: string;
  evidence: string;
  summary: string;
  consistency: ConsistencyPosture;
  metadata?: Record<string, unknown>;
}
export interface StoreConsistency {
  ref_id: string;
  store: string;
  component?: string;
  consistency: ConsistencyPosture;
}
export interface ConsistencyModelResult {
  passive_seams: PassiveDataSeam[];
  store_consistency: StoreConsistency[];
  counts: {
    passive_replica: number;
    passive_streaming: number;
    strong_stores: number;
    eventual_stores: number;
    tunable_stores: number;
  };
}
