import type {
  CASOutput,
  CASExitPoint,
  CASExternalService,
  CASConfiguration,
  CASEntityLineage,
} from '../../types/cas.types';
import type { CommunicationSeam } from './communication-seams';

/**
 * CONSISTENCY-MODEL — the CAP / staleness characterization pass, plus the BROAD
 * PASSIVE-SEAM extension that sits alongside seam-modality's base shared-state
 * classifier (communication-seams.ts).
 *
 * TWO additive contributions, both derived from facts Klauro already extracts
 * (external services, exit points, configuration env vars, data lineage). Pure,
 * non-AI, evidence-carrying — mirrors conventions-applier.ts /
 * infra-topology-linker.ts / communication-seams.ts (additive, non-blocking,
 * never mutating existing facts, every verdict records the driving evidence).
 *
 * (A) BROADEN PASSIVE COMMUNICATION. seam-modality's base pass models PASSIVE as
 *     two components touching the same DB entity / cache key (shared table).
 *     Passive is bigger than that: data LANDS in the receiver without the
 *     receiver ever calling the producer. We add:
 *
 *       - READ-REPLICAS / reader endpoints. A writer feeds a primary; a reader
 *         reads a physically-replicated secondary. writer -> replica -> reader is
 *         a passive seam (the reader never calls the writer; the DB engine ships
 *         the bytes). Detected from DATABASE_REPLICA_URL / READ_REPLICA /
 *         readerEndpoint / replicaSet-secondary / Aurora-RDS reader endpoints /
 *         Rails `replica:`/`reading` roles / TypeORM `slaves` / Prisma read
 *         replicas in config env vars, external-service config, and exit points.
 *
 *       - STREAMING SINKS / CDC. Kafka Connect *sink* connectors, Debezium / CDC
 *         source->topic->sink, Kafka Streams / ksqlDB materialized stores,
 *         Spark/Flink sinks, dbt/Airflow warehouse loads, materialized views.
 *         The producer drops data into a downstream store passively; a consumer
 *         reads the sink without ever calling the producer.
 *
 * (B) CAP / CONSISTENCY CHARACTERIZATION. Tag data-store egress AND passive seams
 *     with a `consistency` posture (strong | eventual | tunable, staleness_risk,
 *     CP/AP/CA lean, evidence) so engineering leaders can see where staleness /
 *     eventual consistency lives. Evidence-gated: derived from store type +
 *     declared config only, NEVER a guessed consistency we cannot infer. A
 *     strongly-consistent primary read is deliberately NOT flagged stale.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ConsistencyModel = 'strong' | 'eventual' | 'tunable';
export type CapLean = 'CP' | 'AP' | 'CA' | null;

/** The consistency posture attached to a data-store egress or a passive seam. */
export interface ConsistencyPosture {
  model: ConsistencyModel;
  /** True when a reader can observe stale / lagged data (replicas, sinks,
   *  eventual stores, secondary reads). A strong primary read is false. */
  staleness_risk: boolean;
  /** CP-vs-AP lean derived from store family + config. null when unknowable. */
  cap_lean: CapLean;
  /** The concrete fact(s) that drove the posture — verifiable, not a guess. */
  evidence: string;
}

/** How data passively lands in the receiver. */
export type PassiveChannelKind =
  | 'read_replica' // physical secondary / reader endpoint
  | 'streaming_sink' // Kafka Connect sink, Spark/Flink sink
  | 'cdc' // Debezium / change-data-capture
  | 'materialized' // materialized view / ksqlDB / Kafka Streams store
  | 'etl_load'; // dbt/Airflow warehouse load

/** A broadened passive communication seam (replica / streaming / CDC). Shares
 *  the shape of communication-seams' CommunicationSeam so the seam inventory can
 *  consume it directly, plus a passive-channel classification and consistency. */
export interface PassiveDataSeam {
  id: string;
  /** Always 'passive' — this is the broadened passive dimension. */
  modality: 'passive';
  confidence: number;
  /** How the data lands: replica / sink / cdc / materialized / etl. */
  channel: PassiveChannelKind;
  /** Producer / writer side (feeds the primary or source topic). */
  source: string;
  /** Consumer / reader side (reads the replica or sink). */
  target: string;
  /** The store / stream both sides share. */
  shared_resource: string;
  /** The concrete fact that drove detection. */
  evidence: string;
  summary: string;
  /** Consistency posture of the landed data — always eventual for these. */
  consistency: ConsistencyPosture;
  metadata?: Record<string, unknown>;
}

/** A data-store egress tagged with its consistency posture. */
export interface StoreConsistency {
  /** exit-point / external-service id this posture describes. */
  ref_id: string;
  /** Store family we recognised (postgres, dynamodb, cassandra, …). */
  store: string;
  /** The component owning the access, when resolvable. */
  component?: string;
  consistency: ConsistencyPosture;
}

export interface ConsistencyModelResult {
  /** Broadened passive seams (replica / streaming / cdc / materialized / etl). */
  passive_seams: PassiveDataSeam[];
  /** Consistency posture per data-store egress (strong primary reads included,
   *  flagged staleness_risk=false — the "NOT flagged stale" case). */
  store_consistency: StoreConsistency[];
  counts: {
    passive_replica: number;
    passive_streaming: number; // sink + cdc + materialized + etl
    strong_stores: number;
    eventual_stores: number;
    tunable_stores: number;
  };
}

/** Bridge: convert broadened passive seams into base CommunicationSeam records so
 *  seam-modality's inventory can fold them in without knowing our extra shape. */
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

// ---------------------------------------------------------------------------
// Detection vocabulary (evidence-gated — every match records what matched)
// ---------------------------------------------------------------------------

/** Env-var / config-key signals that a READ-REPLICA / reader endpoint exists.
 *  Matched case-insensitively against env-var names and config keys/values. */
const REPLICA_SIGNALS: RegExp[] = [
  /READ[_-]?REPLICA/i,
  /REPLICA[_-]?URL/i,
  /DATABASE[_-]?REPLICA/i,
  /\bREPLICA[_-]?SET\b/i,
  /READER[_-]?ENDPOINT/i,
  /READONLY[_-]?(URL|ENDPOINT|HOST|CONN)/i,
  /READ[_-]?ONLY[_-]?(URL|ENDPOINT|HOST|REPLICA)/i,
  /(^|[^A-Za-z])SLAVES?([^A-Za-z]|$)/i, // TypeORM `slaves` (incl. TYPEORM_SLAVES)
  /\.reader\./i, // Aurora/RDS `cluster.reader.<region>.rds.amazonaws.com`
  /rds\.amazonaws\.com/i,
];

/** Stronger config-value signals (Aurora/RDS reader endpoints inside a URL). */
const REPLICA_VALUE_SIGNALS: RegExp[] = [
  /\.reader\..*rds\.amazonaws\.com/i,
  /cluster-ro-/i, // Aurora read-only cluster endpoint prefix
];

/** Rails / ORM read-role config keys. */
const REPLICA_ROLE_SIGNALS: RegExp[] = [
  /\breplica\s*:/i, // Rails database.yml `replica:`
  /\breading\b/i, // Rails `connects_to ... reading:`
  /read[_-]?preference.*secondary/i, // Mongo readPreference secondary
  /readPreference/i,
];

/** Kafka Connect / streaming SINK signals — data lands in a downstream store. */
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

/** CDC / Debezium signals — change-data-capture streaming. */
const CDC_SIGNALS: RegExp[] = [
  /debezium/i,
  /\bCDC\b/i,
  /change[_-]?data[_-]?capture/i,
  /io\.debezium/i,
  /DebeziumConnector/i,
  /wal2json|pgoutput|logical[_-]?replication/i,
];

/** Materialized store / stream-processing store signals. */
const MATERIALIZED_SIGNALS: RegExp[] = [
  /ksqldb|ksql/i,
  /kafka[_-]?streams/i,
  /materialized[_-]?view/i,
  /CREATE\s+MATERIALIZED\s+VIEW/i,
  /StreamsBuilder|KTable|GlobalKTable/i,
];

/** ETL / warehouse-load signals. */
const ETL_SIGNALS: RegExp[] = [
  /\bdbt\b/i,
  /airflow/i,
  /COPY\s+INTO/i, // Snowflake / warehouse load
  /\bmerge\s+into\b.*(warehouse|dwh|snowflake|redshift|bigquery)/i,
];

function anyMatch(text: string | undefined, patterns: RegExp[]): RegExp | null {
  if (!text) return null;
  for (const p of patterns) if (p.test(text)) return p;
  return null;
}

// ---------------------------------------------------------------------------
// CAP / consistency derivation from store family
// ---------------------------------------------------------------------------

/** Recognise the store family from a free-text hint (type, name, endpoint,
 *  sdk, resource). Returns a normalized family key or null. */
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

/**
 * Consistency posture for a store family under a PRIMARY (default) access.
 * This is the "source of truth" posture — the replica/secondary/sink cases are
 * handled by the passive-seam derivation which always yields eventual+stale.
 *
 * Evidence-gated: only families we can characterise get a posture; unknown
 * families return null (never a guessed consistency).
 */
export function primaryConsistency(store: string, configHint?: string): ConsistencyPosture | null {
  const cfg = (configHint || '').toLowerCase();
  switch (store) {
    case 'postgres':
    case 'mysql':
    case 'aurora':
      // Primary read of a relational store: strong within the primary. CP-leaning
      // (favours consistency, single-primary). Not stale on the primary.
      return {
        model: 'strong',
        staleness_risk: false,
        cap_lean: 'CP',
        evidence: `${store} primary read (single-primary relational, strong)`,
      };
    case 'cockroachdb':
    case 'spanner':
      // Distributed-SQL with serializable/external consistency: strong, CP.
      return {
        model: 'strong',
        staleness_risk: false,
        cap_lean: 'CP',
        evidence: `${store} serializable distributed SQL (strong, CP)`,
      };
    case 'dynamodb':
      // Eventual by default; strongly-consistent read is opt-in.
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
      // Tunable via consistency level. QUORUM/ALL => strong-ish; ONE/LOCAL_ONE => AP.
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
      // readConcern majority / linearizable => strong; secondary readPreference => eventual.
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
      // Cache: eventual vs a source-of-truth store; staleness by nature.
      return {
        model: 'eventual',
        staleness_risk: true,
        cap_lean: 'AP',
        evidence: 'redis cache (derived copy, eventual vs source of truth)',
      };
    case 'kafka':
      // Ordered per-partition, at-least-once. Not a point-read store; treat as
      // eventual/at-least-once ordered.
      return {
        model: 'eventual',
        staleness_risk: true,
        cap_lean: 'AP',
        evidence: 'kafka ordered-per-partition, at-least-once (log, eventual)',
      };
    case 'elasticsearch':
      // Near-real-time index: refresh-interval driven staleness.
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

/** The consistency posture of PASSIVELY-LANDED data (replica/sink/cdc/etc.) —
 *  always eventual with staleness risk, because there is replication lag between
 *  the producer's write and the reader's read. AP-leaning (the reader tolerates
 *  staleness for availability). */
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

// ---------------------------------------------------------------------------
// Main pass
// ---------------------------------------------------------------------------

let seq = 0;
function nextId(prefix: string): string {
  seq += 1;
  return `consistency_${prefix}_${seq}`;
}

/**
 * Reader components for the data store an env/service touches, if resolvable from
 * lineage. When we cannot resolve a distinct reader component we still emit the
 * seam with a generic reader so the passive channel is not lost — the evidence
 * carries the store name.
 */
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

/**
 * Classify consistency + broadened passive seams from already-extracted facts.
 * Pure, additive, evidence-carrying. Never throws on shape gaps (defensive).
 */
export function deriveConsistencyModel(
  output: Pick<
    CASOutput,
    'exit_points' | 'external_services' | 'configuration' | 'data_lineage' | 'data_entities'
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

  // (1) READ-REPLICAS from CONFIGURATION env vars. A replica env var implies a
  //     writer -> primary -> replica -> reader passive seam.
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
    // Reader components: env `used_by` (the code that reads via the replica), else generic.
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

  // (2) READ-REPLICAS + STREAMING from EXTERNAL SERVICES (config blobs, endpoints).
  for (const svc of services) {
    const cfgText = JSON.stringify(svc.configuration || {});
    const hay = `${svc.name} ${svc.type} ${svc.endpoint ?? ''} ${svc.provider ?? ''} ${cfgText}`;
    const store = detectStoreFamily(svc.name, svc.type, svc.endpoint, svc.provider) || svc.type || 'service';
    const component = (svc.connected_nodes && svc.connected_nodes[0]) || svc.name;

    // Replica endpoint on a service?
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

    // Streaming sink / CDC / materialized / ETL on a service?
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

  // (3) STREAMING / CDC / replica from EXIT POINTS (sdk/message/database egress
  //     whose name or target names a connector / replica).
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

  // (4) CONSISTENCY POSTURE per data-store egress (the CAP characterization).
  //     Every database/sdk exit that resolves to a known store family gets a
  //     posture. A STRONG PRIMARY READ is emitted with staleness_risk=false —
  //     this is the "NOT flagged stale" verification case.
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
