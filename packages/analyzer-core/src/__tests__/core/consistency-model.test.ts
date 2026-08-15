import {
  deriveConsistencyModel,
  toCommunicationSeams,
  detectStoreFamily,
  primaryConsistency,
} from '../../analyzer/core/consistency-model';
import type {
  CASOutput,
  CASExitPoint,
  CASExternalService,
  CASConfiguration,
} from '../../types/cas.types';

function exit(overrides: Partial<CASExitPoint> & { id: string; type: CASExitPoint['type'] }): CASExitPoint {
  return { source_node: 'n1', name: overrides.id, ...overrides } as CASExitPoint;
}
function service(overrides: Partial<CASExternalService> & { id: string; name: string }): CASExternalService {
  return { type: 'database', ...overrides } as CASExternalService;
}
function out(partial: Partial<CASOutput>): Parameters<typeof deriveConsistencyModel>[0] {
  return {
    exit_points: [],
    external_services: [],
    configuration: undefined,
    data_lineage: [],
    entities: [],
    ...partial,
  } as any;
}

describe('consistency-model — broadened passive seams + CAP characterization', () => {
  // -------------------------------------------------------------------------
  // (a) primary + read-replica URL -> passive seam tagged eventual/staleness
  // -------------------------------------------------------------------------
  describe('read-replica detection (passive, eventual, staleness)', () => {
    it('emits a passive read_replica seam from a DATABASE_REPLICA_URL env var', () => {
      const config: CASConfiguration = {
        environment_variables: [
          { name: 'DATABASE_URL', used_by: ['apps/api/db.ts'] },
          { name: 'DATABASE_REPLICA_URL', used_by: ['apps/reports/read.ts'] },
        ],
      };
      const res = deriveConsistencyModel(out({ configuration: config }));
      const replicas = res.passive_seams.filter(s => s.channel === 'read_replica');
      expect(replicas.length).toBeGreaterThanOrEqual(1);
      const seam = replicas[0];
      expect(seam.modality).toBe('passive');
      expect(seam.consistency.model).toBe('eventual');
      expect(seam.consistency.staleness_risk).toBe(true);
      expect(seam.consistency.cap_lean).toBe('AP');
      expect(seam.evidence).toContain('DATABASE_REPLICA_URL');
      expect(seam.target).toBe('apps/reports'); // reader component from used_by
      expect(res.counts.passive_replica).toBeGreaterThanOrEqual(1);
    });

    it('detects an Aurora RDS reader endpoint in an external service', () => {
      const svc = service({
        id: 'svc_reports_db',
        name: 'reports-db',
        type: 'postgres',
        endpoint: 'mycluster.cluster-ro-abc123.us-east-1.rds.amazonaws.com',
        connected_nodes: ['apps/reports'],
      });
      const res = deriveConsistencyModel(out({ external_services: [svc] }));
      const replicas = res.passive_seams.filter(s => s.channel === 'read_replica');
      expect(replicas.length).toBe(1);
      expect(replicas[0].consistency.staleness_risk).toBe(true);
      expect(replicas[0].shared_resource).toBe('postgres');
    });

    it('detects a Rails replica/reading role and TypeORM slaves', () => {
      const config: CASConfiguration = {
        environment_variables: [
          { name: 'DB_ROLE_CONFIG', default: 'replica: reading', used_by: ['apps/web/model.rb'] },
          { name: 'TYPEORM_SLAVES', used_by: ['apps/svc/data.ts'] },
        ],
      };
      const res = deriveConsistencyModel(out({ configuration: config }));
      expect(res.counts.passive_replica).toBeGreaterThanOrEqual(2);
      for (const s of res.passive_seams) {
        expect(s.consistency.model).toBe('eventual');
        expect(s.consistency.staleness_risk).toBe(true);
      }
    });
  });

  // -------------------------------------------------------------------------
  // (b) Kafka sink / CDC connector -> passive streaming seam
  // -------------------------------------------------------------------------
  describe('streaming-sink / CDC detection (passive, eventual)', () => {
    it('classifies a Kafka Connect sink connector as a streaming_sink passive seam', () => {
      const svc = service({
        id: 'svc_sink',
        name: 'orders-jdbc-sink',
        type: 'kafka-connect',
        configuration: { 'connector.class': 'io.confluent.connect.jdbc.JdbcSinkConnector', topics: 'orders' },
        connected_nodes: ['warehouse'],
      });
      const res = deriveConsistencyModel(out({ external_services: [svc] }));
      const sinks = res.passive_seams.filter(s => s.channel === 'streaming_sink');
      expect(sinks.length).toBe(1);
      expect(sinks[0].modality).toBe('passive');
      expect(sinks[0].consistency.model).toBe('eventual');
      expect(sinks[0].consistency.staleness_risk).toBe(true);
      expect(res.counts.passive_streaming).toBeGreaterThanOrEqual(1);
    });

    it('classifies a Debezium CDC connector as a cdc passive seam', () => {
      const svc = service({
        id: 'svc_cdc',
        name: 'pg-debezium-source',
        type: 'kafka-connect',
        configuration: { 'connector.class': 'io.debezium.connector.postgresql.PostgresConnector' },
        connected_nodes: ['search-indexer'],
      });
      const res = deriveConsistencyModel(out({ external_services: [svc] }));
      const cdc = res.passive_seams.filter(s => s.channel === 'cdc');
      expect(cdc.length).toBe(1);
      expect(cdc[0].consistency.model).toBe('eventual');
      expect(cdc[0].evidence.toLowerCase()).toContain('debezium');
    });

    it('classifies a CDC exit point (message egress named debezium)', () => {
      const e = exit({
        id: 'exit_cdc_1',
        type: 'message',
        name: 'debezium change stream',
        target: { resource: 'orders_cdc_topic' },
        metadata: { file: 'apps/cdc/stream.ts' },
      });
      const res = deriveConsistencyModel(out({ exit_points: [e] }));
      expect(res.passive_seams.some(s => s.channel === 'cdc')).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // (c) strong primary read -> NOT flagged stale
  // -------------------------------------------------------------------------
  describe('strong primary read is NOT flagged stale', () => {
    it('tags a postgres primary read as strong / CP / staleness_risk=false', () => {
      const e = exit({
        id: 'exit_pg_read',
        type: 'database',
        name: 'select from users',
        target: { resource: 'postgres', sdk: 'pg' },
        metadata: { file: 'apps/api/users.ts' },
      });
      const res = deriveConsistencyModel(out({ exit_points: [e] }));
      const store = res.store_consistency.find(s => s.ref_id === 'exit_pg_read');
      expect(store).toBeDefined();
      expect(store!.consistency.model).toBe('strong');
      expect(store!.consistency.staleness_risk).toBe(false);
      expect(store!.consistency.cap_lean).toBe('CP');
      expect(res.counts.strong_stores).toBeGreaterThanOrEqual(1);
      // And it produced NO passive/eventual seam.
      expect(res.passive_seams.length).toBe(0);
    });

    it('does NOT tag a store family it cannot infer (evidence-gated)', () => {
      const e = exit({ id: 'exit_unknown', type: 'database', name: 'query somewhere', metadata: { file: 'a/b.ts' } });
      const res = deriveConsistencyModel(out({ exit_points: [e] }));
      expect(res.store_consistency.length).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // CAP derivation unit coverage
  // -------------------------------------------------------------------------
  describe('primaryConsistency CAP derivation', () => {
    it('dynamodb default = eventual/AP, ConsistentRead=true = strong/CP', () => {
      expect(primaryConsistency('dynamodb')!.model).toBe('eventual');
      expect(primaryConsistency('dynamodb')!.cap_lean).toBe('AP');
      const strong = primaryConsistency('dynamodb', 'ConsistentRead: true')!;
      expect(strong.model).toBe('strong');
      expect(strong.staleness_risk).toBe(false);
    });
    it('cassandra quorum = CP tunable no-stale; default = AP tunable stale', () => {
      expect(primaryConsistency('cassandra', 'consistencyLevel QUORUM')!.staleness_risk).toBe(false);
      expect(primaryConsistency('cassandra')!.cap_lean).toBe('AP');
    });
    it('mongodb secondary read = eventual, majority readConcern = strong', () => {
      expect(primaryConsistency('mongodb', 'readPreference: secondary')!.model).toBe('eventual');
      expect(primaryConsistency('mongodb', 'readConcern: majority')!.model).toBe('strong');
    });
    it('redis cache = eventual/AP with staleness', () => {
      const r = primaryConsistency('redis')!;
      expect(r.model).toBe('eventual');
      expect(r.staleness_risk).toBe(true);
    });
    it('returns null for unknown families (never guesses)', () => {
      expect(primaryConsistency('unknown-store')).toBeNull();
    });
  });

  describe('detectStoreFamily', () => {
    it('recognises common families', () => {
      expect(detectStoreFamily('DATABASE_URL postgres://...')).toBe('postgres');
      expect(detectStoreFamily('dynamodb table')).toBe('dynamodb');
      expect(detectStoreFamily('aws elasticache redis')).toBe('redis');
      expect(detectStoreFamily('kafka broker')).toBe('kafka');
      expect(detectStoreFamily('nothing recognisable')).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Bridge into the communication-seams inventory
  // -------------------------------------------------------------------------
  describe('toCommunicationSeams bridge', () => {
    it('maps passive seams to CommunicationSeam records carrying consistency + channel', () => {
      const config: CASConfiguration = {
        environment_variables: [{ name: 'READ_REPLICA_URL', used_by: ['apps/reports/x.ts'] }],
      };
      const res = deriveConsistencyModel(out({ configuration: config }));
      const bridged = toCommunicationSeams(res.passive_seams);
      expect(bridged.length).toBe(res.passive_seams.length);
      const s = bridged[0];
      expect(s.modality).toBe('passive');
      expect(s.kind).toBe('passive_state');
      expect((s.metadata as any).passive_channel).toBe('read_replica');
      expect((s.metadata as any).consistency.model).toBe('eventual');
    });
  });

  // -------------------------------------------------------------------------
  // Zero behavior change when no such stores exist
  // -------------------------------------------------------------------------
  it('emits nothing when no replica/streaming/known-store facts exist', () => {
    const res = deriveConsistencyModel(out({}));
    expect(res.passive_seams).toEqual([]);
    expect(res.store_consistency).toEqual([]);
    expect(res.counts.passive_replica).toBe(0);
    expect(res.counts.passive_streaming).toBe(0);
  });
});
