import type {
  CASOutput,
  CASExitPoint,
  CASExternalService,
  CASConfiguration,
  CASEntityLineage,
} from '../../types/cas.types';
import type { CommunicationSeam } from './communication-seams';











































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



export function toCommunicationSeams(seams: PassiveDataSeam[]): CommunicationSeam[] {
  return seams.map(s => ({
    id: s.id,
    modality: 'passive' as const,
    confidence: s.confidence,
    kind: 'passive_state' as const,
    source: s.source,
    target: s.target,
    evidence: s.evidence,
    summary: s.summary,
    shared_resource: s.shared_resource,
    metadata: {
      ...s.metadata,
      passive_channel: s.channel,
      consistency: s.consistency,
    },
  }));
}







const REPLICA_SIGNALS: RegExp[] = [
  /READ[_-]?REPLICA/i,
  /REPLICA[_-]?URL/i,
  /DATABASE[_-]?REPLICA/i,
  /\bREPLICA[_-]?SET\b/i,
  /READER[_-]?ENDPOINT/i,
  /READONLY[_-]?(URL|ENDPOINT|HOST|CONN)/i,
  /READ[_-]?ONLY[_-]?(URL|ENDPOINT|HOST|REPLICA)/i,
  /(^|[^A-Za-z])SLAVES?([^A-Za-z]|$)/i,
  /\.reader\./i,
  /rds\.amazonaws\.com/i,
];


const REPLICA_VALUE_SIGNALS: RegExp[] = [
  /\.reader\..*rds\.amazonaws\.com/i,
  /cluster-ro-/i,
];


const REPLICA_ROLE_SIGNALS: RegExp[] = [
  /\breplica\s*:/i,
  /\breading\b/i,
  /read[_-]?preference.*secondary/i,
  /readPreference/i,
];


const SINK_SIGNALS: RegExp[] = [
  /kafka[_-]?connect/i,
  /connector\.class.*sink/i,
  /[A-Za-z]*SinkConnector/i,
  /\bsink\b.*connector/i,
  /connector.*\bsink\b/i,
  /flink.*sink/i,
  /spark.*(write|sink)/i,
  /\bJdbcSinkConnector\b/i,
  /S3SinkConnector/i,
  /ElasticsearchSinkConnector/i,
];


const CDC_SIGNALS: RegExp[] = [
  /debezium/i,
  /\bCDC\b/i,
  /change[_-]?data[_-]?capture/i,
  /io\.debezium/i,
  /DebeziumConnector/i,
  /wal2json|pgoutput|logical[_-]?replication/i,
];


const MATERIALIZED_SIGNALS: RegExp[] = [
  /ksqldb|ksql/i,
  /kafka[_-]?streams/i,
  /materialized[_-]?view/i,
  /CREATE\s+MATERIALIZED\s+VIEW/i,
  /StreamsBuilder|KTable|GlobalKTable/i,
];


const ETL_SIGNALS: RegExp[] = [
  /\bdbt\b/i,
  /airflow/i,
  /COPY\s+INTO/i,
  /\bmerge\s+into\b.*(warehouse|dwh|snowflake|redshift|bigquery)/i,
];

function anyMatch(text: string | undefined, patterns: RegExp[]): RegExp | null {
  if (!text) return null;
  for (const p of patterns) if (p.test(text)) return p;
  return null;
}







export function detectStoreFamily(...hints: Array<string | undefined>): string | null {
  const text = hints.filter(Boolean).join(' ').toLowerCase();
  if (!text) return null;
  if (/dynamodb|dynamo\b/.test(text)) return 'dynamodb';
  if (/scylla/.test(text)) return 'scylla';
  if (/cassandra/.test(text)) return 'cassandra';
  if (/mongo/.test(text)) return 'mongodb';
  if (/redis|memcached|elasticache/.test(text)) return 'redis';
  if (/kafka/.test(text)) return 'kafka';
  if (/aurora/.test(text)) return 'aurora';
  if (/postgres|postgresql|\bpg\b|rds.*postgres/.test(text)) return 'postgres';
  if (/mysql|mariadb|rds.*mysql/.test(text)) return 'mysql';
  if (/cockroach/.test(text)) return 'cockroachdb';
  if (/spanner/.test(text)) return 'spanner';
  if (/elasticsearch|opensearch/.test(text)) return 'elasticsearch';
  return null;
}









export function primaryConsistency(store: string, configHint?: string): ConsistencyPosture | null {
  const cfg = (configHint || '').toLowerCase();
  switch (store) {
    case 'postgres':
    case 'mysql':
    case 'aurora':


      return {
        model: 'strong',
        staleness_risk: false,
        cap_lean: 'CP',
        evidence: `${store} primary read (single-primary relational, strong)`,
      };
    case 'cockroachdb':
    case 'spanner':

      return {
        model: 'strong',
        staleness_risk: false,
        cap_lean: 'CP',
        evidence: `${store} serializable distributed SQL (strong, CP)`,
      };
    case 'dynamodb':

      if (/consistentread\s*[:=]\s*true|strongly[_-]?consistent/i.test(cfg)) {
        return {
          model: 'strong',
          staleness_risk: false,
          cap_lean: 'CP',
          evidence: 'dynamodb ConsistentRead=true (strong read opt-in)',
        };
      }
      return {
        model: 'eventual',
        staleness_risk: true,
        cap_lean: 'AP',
        evidence: 'dynamodb default eventual read (ConsistentRead not set)',
      };
    case 'cassandra':
    case 'scylla':

      if (/\b(quorum|all|local_quorum|each_quorum)\b/i.test(cfg)) {
        return {
          model: 'tunable',
          staleness_risk: false,
          cap_lean: 'CP',
          evidence: `${store} quorum consistency level (tunable, CP-leaning)`,
        };
      }
      return {
        model: 'tunable',
        staleness_risk: true,
        cap_lean: 'AP',
        evidence: `${store} tunable consistency (default/ONE => AP, staleness possible)`,
      };
    case 'mongodb': {

      const secondary = /readpreference.*(secondary|nearest)/i.test(cfg);
      const strongRC = /readconcern.*(majority|linearizable)/i.test(cfg);
      if (secondary) {
        return {
          model: 'eventual',
          staleness_risk: true,
          cap_lean: 'AP',
          evidence: 'mongodb readPreference=secondary (reads a replica, eventual)',
        };
      }
      if (strongRC) {
        return {
          model: 'strong',
          staleness_risk: false,
          cap_lean: 'CP',
          evidence: 'mongodb readConcern majority/linearizable (strong)',
        };
      }
      return {
        model: 'tunable',
        staleness_risk: false,
        cap_lean: 'CP',
        evidence: 'mongodb primary read (default readPreference=primary, CP)',
      };
    }
    case 'redis':

      return {
        model: 'eventual',
        staleness_risk: true,
        cap_lean: 'AP',
        evidence: 'redis cache (derived copy, eventual vs source of truth)',
      };
    case 'kafka':


      return {
        model: 'eventual',
        staleness_risk: true,
        cap_lean: 'AP',
        evidence: 'kafka ordered-per-partition, at-least-once (log, eventual)',
      };
    case 'elasticsearch':

      return {
        model: 'eventual',
        staleness_risk: true,
        cap_lean: 'AP',
        evidence: 'elasticsearch near-real-time index (refresh lag, eventual)',
      };
    default:
      return null;
  }
}





function passiveConsistency(channel: PassiveChannelKind, store: string, detail: string): ConsistencyPosture {
  const label: Record<PassiveChannelKind, string> = {
    read_replica: 'read-replica secondary (replication lag)',
    streaming_sink: 'streaming sink (async pipeline lag)',
    cdc: 'change-data-capture stream (log-based replication lag)',
    materialized: 'materialized/stream store (recompute lag)',
    etl_load: 'ETL/warehouse load (batch lag)',
  };
  return {
    model: 'eventual',
    staleness_risk: true,
    cap_lean: 'AP',
    evidence: `${label[channel]}${store ? ` on ${store}` : ''}${detail ? ` (${detail})` : ''}`,
  };
}





let seq = 0;
function nextId(prefix: string): string {
  seq += 1;
  return `consistency_${prefix}_${seq}`;
}







function readersForStore(
  storeName: string,
  lineage: CASEntityLineage[],
): string[] {
  const readers = new Set<string>();
  const target = storeName.toLowerCase();
  for (const entity of lineage) {
    const en = (entity.entity_name || '').toLowerCase();
    if (!en) continue;
    if (target.includes(en) || en.includes(target)) {
      for (const r of entity.readers || []) {
        const f = r.file;
        if (f) readers.add(f.split('/').slice(0, 2).join('/'));
      }
    }
  }
  return Array.from(readers);
}





export function deriveConsistencyModel(
  output: Pick<
    CASOutput,
    'exit_points' | 'external_services' | 'configuration' | 'data_lineage' | 'entities'
  >,
): ConsistencyModelResult {
  seq = 0;
  const passive_seams: PassiveDataSeam[] = [];
  const store_consistency: StoreConsistency[] = [];

  const exits: CASExitPoint[] = output.exit_points || [];
  const services: CASExternalService[] = output.external_services || [];
  const config: CASConfiguration | undefined = output.configuration;
  const lineage: CASEntityLineage[] = output.data_lineage || [];

  const seenPassive = new Set<string>();
  const emitPassive = (seam: Omit<PassiveDataSeam, 'id'>) => {
    const key = `${seam.channel}|${seam.source}|${seam.target}|${seam.shared_resource}`;
    if (seenPassive.has(key)) return;
    seenPassive.add(key);
    passive_seams.push({ id: nextId(seam.channel), ...seam });
  };



  const envVars = config?.environment_variables || [];
  for (const ev of envVars) {
    const name = ev.name || '';
    const hay = `${name} ${String(ev.default ?? '')} ${ev.description ?? ''}`;
    const nameHit = anyMatch(name, REPLICA_SIGNALS);
    const valHit = anyMatch(String(ev.default ?? ''), REPLICA_VALUE_SIGNALS);
    const roleHit = anyMatch(hay, REPLICA_ROLE_SIGNALS);
    const hit = nameHit || valHit || roleHit;
    if (!hit) continue;
    const store = detectStoreFamily(name, String(ev.default ?? ''), ev.description) || 'database';

    const readers = (ev.used_by && ev.used_by.length
      ? ev.used_by.map(u => u.split('/').slice(0, 2).join('/'))
      : readersForStore(store, lineage));
    const readerList = readers.length ? Array.from(new Set(readers)) : ['reader'];
    for (const reader of readerList) {
      emitPassive({
        modality: 'passive',
        confidence: nameHit ? 0.85 : valHit ? 0.8 : 0.7,
        channel: 'read_replica',
        source: 'primary',
        target: reader,
        shared_resource: store,
        evidence: `config:${name} matched=${hit.source}`,
        summary: `primary --passive(replica:${store})--> ${reader} (read-replica, eventual)`,
        consistency: passiveConsistency('read_replica', store, `env ${name}`),
        metadata: { config_var: name, detector: 'config_env' },
      });
    }
  }


  for (const svc of services) {
    const cfgText = JSON.stringify(svc.configuration || {});
    const hay = `${svc.name} ${svc.type} ${svc.endpoint ?? ''} ${svc.provider ?? ''} ${cfgText}`;
    const store = detectStoreFamily(svc.name, svc.type, svc.endpoint, svc.provider) || svc.type || 'service';
    const component = (svc.connected_nodes && svc.connected_nodes[0]) || svc.name;


    const replicaHit = anyMatch(hay, REPLICA_SIGNALS) || anyMatch(svc.endpoint, REPLICA_VALUE_SIGNALS);
    if (replicaHit) {
      emitPassive({
        modality: 'passive',
        confidence: 0.8,
        channel: 'read_replica',
        source: 'primary',
        target: component,
        shared_resource: store,
        evidence: `service:${svc.id} matched=${replicaHit.source}`,
        summary: `primary --passive(replica:${store})--> ${component} (reader endpoint, eventual)`,
        consistency: passiveConsistency('read_replica', store, svc.name),
        metadata: { service_id: svc.id, detector: 'external_service' },
      });
    }


    const cdcHit = anyMatch(hay, CDC_SIGNALS);
    const sinkHit = anyMatch(hay, SINK_SIGNALS);
    const matHit = anyMatch(hay, MATERIALIZED_SIGNALS);
    const etlHit = anyMatch(hay, ETL_SIGNALS);
    const channel: PassiveChannelKind | null = cdcHit
      ? 'cdc'
      : sinkHit
      ? 'streaming_sink'
      : matHit
      ? 'materialized'
      : etlHit
      ? 'etl_load'
      : null;
    if (channel) {
      const drove = (cdcHit || sinkHit || matHit || etlHit)!;
      const streamStore = detectStoreFamily(hay) || store;
      emitPassive({
        modality: 'passive',
        confidence: channel === 'cdc' ? 0.85 : 0.8,
        channel,
        source: svc.name || 'producer',
        target: component,
        shared_resource: streamStore,
        evidence: `service:${svc.id} matched=${drove.source}`,
        summary: `${svc.name || 'producer'} --passive(${channel}:${streamStore})--> ${component} (streaming sink, eventual)`,
        consistency: passiveConsistency(channel, streamStore, svc.name),
        metadata: { service_id: svc.id, detector: 'external_service' },
      });
    }
  }



  for (const exit of exits) {
    const targetText = [
      exit.name,
      exit.description,
      exit.target?.service_id,
      exit.target?.resource,
      exit.target?.sdk,
      exit.target?.endpoint,
      JSON.stringify(exit.metadata || {}),
    ]
      .filter(Boolean)
      .join(' ');
    const file = (exit.metadata as any)?.file || '';
    const component = file ? String(file).split('/').slice(0, 2).join('/') : exit.name || 'component';

    const cdcHit = anyMatch(targetText, CDC_SIGNALS);
    const sinkHit = anyMatch(targetText, SINK_SIGNALS);
    const matHit = anyMatch(targetText, MATERIALIZED_SIGNALS);
    const etlHit = anyMatch(targetText, ETL_SIGNALS);
    const replicaHit = anyMatch(targetText, REPLICA_SIGNALS) || anyMatch(targetText, REPLICA_ROLE_SIGNALS);

    const channel: PassiveChannelKind | null = cdcHit
      ? 'cdc'
      : sinkHit
      ? 'streaming_sink'
      : matHit
      ? 'materialized'
      : etlHit
      ? 'etl_load'
      : replicaHit
      ? 'read_replica'
      : null;
    if (!channel) continue;
    const drove = (cdcHit || sinkHit || matHit || etlHit || replicaHit)!;
    const store = detectStoreFamily(targetText) || exit.target?.resource || 'store';
    emitPassive({
      modality: 'passive',
      confidence: 0.75,
      channel,
      source: channel === 'read_replica' ? 'primary' : component,
      target: channel === 'read_replica' ? component : (exit.target?.resource || store),
      shared_resource: String(store),
      evidence: `exit:${exit.id} matched=${drove.source}`,
      summary: `${component} --passive(${channel}:${store})--> reader (eventual)`,
      consistency: passiveConsistency(channel, String(store), exit.name),
      metadata: { exit_point: exit.id, detector: 'exit_point' },
    });
  }





  for (const exit of exits) {
    if (exit.type !== 'database' && exit.type !== 'sdk' && exit.type !== 'cache') continue;
    const hint = [exit.name, exit.target?.resource, exit.target?.sdk, exit.target?.endpoint, exit.description]
      .filter(Boolean)
      .join(' ');
    const store = detectStoreFamily(hint);
    if (!store) continue;
    const cfgHint = JSON.stringify(exit.metadata || {}) + ' ' + hint;
    const posture = primaryConsistency(store, cfgHint);
    if (!posture) continue;
    const file = (exit.metadata as any)?.file || '';
    store_consistency.push({
      ref_id: exit.id,
      store,
      component: file ? String(file).split('/').slice(0, 2).join('/') : undefined,
      consistency: posture,
    });
  }
  for (const svc of services) {
    const store = detectStoreFamily(svc.name, svc.type, svc.endpoint, svc.provider);
    if (!store) continue;
    const cfgHint = JSON.stringify(svc.configuration || {});
    const posture = primaryConsistency(store, cfgHint);
    if (!posture) continue;
    store_consistency.push({
      ref_id: svc.id,
      store,
      component: (svc.connected_nodes && svc.connected_nodes[0]) || undefined,
      consistency: posture,
    });
  }

  const counts = {
    passive_replica: passive_seams.filter(s => s.channel === 'read_replica').length,
    passive_streaming: passive_seams.filter(s => s.channel !== 'read_replica').length,
    strong_stores: store_consistency.filter(s => s.consistency.model === 'strong').length,
    eventual_stores: store_consistency.filter(s => s.consistency.model === 'eventual').length,
    tunable_stores: store_consistency.filter(s => s.consistency.model === 'tunable').length,
  };

  return { passive_seams, store_consistency, counts };
}
