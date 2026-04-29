import type { CASOutput, CASRuntimeStaticLink } from '../../backend/src/types/cas.types';

export type RuntimeEventType = 'request' | 'error' | 'exit' | 'log' | 'custom';

export interface RuntimeEventContractField {
  name: string;
  type: string;
  required: boolean;
  description: string;
}

export interface RuntimeLinkEventContract {
  runtime_link_id: string;
  kind: CASRuntimeStaticLink['kind'];
  static_id: string;
  runtime_signal: string;
  telemetry_status: CASRuntimeStaticLink['telemetry_status'];
  confidence: number;
  emit_when: string;
  minimum_event: Record<string, unknown>;
  recommended_event: Record<string, unknown>;
  instrumentation_points: string[];
  correlation_keys: string[];
}

export function getRuntimeEventContract(cas: CASOutput, opts: { limit?: number } = {}) {
  const limit = opts.limit || 100;
  const links = cas.runtime_static_links || [];
  const contracts = links.slice(0, limit).map(link => runtimeLinkContract(cas, link));

  return {
    version: '1.0.0',
    generated_at: new Date().toISOString(),
    system: {
      name: cas.system.name,
      root_path: cas.system.root_path,
      cas_version: cas.cas_version,
      analysis_id: cas.analysis_id,
    },
    transport: {
      ingest_path: '/api/telemetry/runtime-events/:projectId',
      batch_key: 'events',
      content_type: 'application/json',
    },
    event_types: ['request', 'error', 'exit', 'log', 'custom'] as RuntimeEventType[],
    fields: runtimeEventFields(),
    correlation_order: ['static_id', 'entry_point_id', 'exit_point_id', 'call_chain_id', 'node_id', 'signal', 'route', 'path', 'stack'],
    contracts,
    totals: {
      runtime_static_links: links.length,
      included: contracts.length,
      observed: links.filter(link => link.telemetry_status === 'observed').length,
      instrumentable: links.filter(link => link.telemetry_status === 'instrumentable').length,
      not_instrumented: links.filter(link => link.telemetry_status === 'not-instrumented').length,
    },
    sdk_contract: {
      method: 'recordCasEvent',
      flush_method: 'flush',
      required_config: ['projectId', 'apiKey'],
      optional_config: ['endpoint', 'environment', 'serviceName', 'batchSize', 'flushInterval'],
    },
    gaps: [
      ...(links.length === 0 ? ['No runtime_static_links in CAS'] : []),
      ...links.filter(link => link.instrumentation_points.length === 0).slice(0, 10).map(link => `${link.id}: no instrumentation points`),
    ],
  };
}

function runtimeEventFields(): RuntimeEventContractField[] {
  return [
    { name: 'type', type: 'request | error | exit | log | custom', required: true, description: 'Runtime event category.' },
    { name: 'timestamp', type: 'ISO-8601 string', required: true, description: 'Event time.' },
    { name: 'schema_version', type: 'string', required: false, description: 'Runtime event contract version.' },
    { name: 'service_name', type: 'string', required: false, description: 'Service or process emitting the event.' },
    { name: 'environment', type: 'string', required: false, description: 'Deployment environment.' },
    { name: 'signal', type: 'string', required: false, description: 'CAS runtime_static_links.runtime_signal.' },
    { name: 'static_id', type: 'string', required: false, description: 'CAS static object id for direct correlation.' },
    { name: 'node_id', type: 'string', required: false, description: 'CAS node id.' },
    { name: 'entry_point_id', type: 'string', required: false, description: 'CAS entry point id.' },
    { name: 'exit_point_id', type: 'string', required: false, description: 'CAS exit point id.' },
    { name: 'call_chain_id', type: 'string', required: false, description: 'CAS call chain id.' },
    { name: 'trace_id', type: 'string', required: false, description: 'Runtime trace id.' },
    { name: 'span_id', type: 'string', required: false, description: 'Runtime span id.' },
    { name: 'parent_span_id', type: 'string', required: false, description: 'Parent runtime span id.' },
    { name: 'method', type: 'string', required: false, description: 'HTTP or operation method.' },
    { name: 'route', type: 'string', required: false, description: 'Normalized route pattern.' },
    { name: 'path', type: 'string', required: false, description: 'Observed path or external target.' },
    { name: 'status_code', type: 'number', required: false, description: 'HTTP status code.' },
    { name: 'duration_ms', type: 'number', required: false, description: 'Elapsed duration in milliseconds.' },
    { name: 'error_message', type: 'string', required: false, description: 'Error summary.' },
    { name: 'stack', type: 'string', required: false, description: 'Stack trace for source correlation.' },
    { name: 'attributes', type: 'object', required: false, description: 'Additional low-cardinality fields.' },
  ];
}

function runtimeLinkContract(cas: CASOutput, link: CASRuntimeStaticLink): RuntimeLinkEventContract {
  const staticRefs = staticReference(cas, link.static_id);
  const minimumEvent = {
    type: eventTypeForLink(link),
    timestamp: '<ISO timestamp>',
    static_id: link.static_id,
    signal: link.runtime_signal,
  };
  const recommendedEvent = {
    ...minimumEvent,
    schema_version: '1.0.0',
    ...staticRefs.event_fields,
    attributes: {
      runtime_link_id: link.id,
      kind: link.kind,
    },
  };

  return {
    runtime_link_id: link.id,
    kind: link.kind,
    static_id: link.static_id,
    runtime_signal: link.runtime_signal,
    telemetry_status: link.telemetry_status,
    confidence: link.confidence,
    emit_when: emitRule(link),
    minimum_event: minimumEvent,
    recommended_event: recommendedEvent,
    instrumentation_points: link.instrumentation_points,
    correlation_keys: ['static_id', ...staticRefs.keys, 'signal'],
  };
}

function staticReference(cas: CASOutput, staticId: string): { keys: string[]; event_fields: Record<string, unknown> } {
  const entry = (cas.entry_points || []).find(candidate => candidate.id === staticId);
  if (entry) {
    return {
      keys: ['entry_point_id', 'route', 'method'],
      event_fields: {
        entry_point_id: entry.id,
        method: entry.trigger?.method,
        route: entry.trigger?.path,
      },
    };
  }

  const exitPoint = (cas.exit_points || []).find(candidate => candidate.id === staticId);
  if (exitPoint) {
    return {
      keys: ['exit_point_id', 'path'],
      event_fields: {
        exit_point_id: exitPoint.id,
        path: exitPoint.target?.endpoint || exitPoint.target?.resource || exitPoint.target?.sdk,
      },
    };
  }

  const chain = (cas.call_chains || []).find(candidate => candidate.id === staticId);
  if (chain) {
    return {
      keys: ['call_chain_id', 'entry_point_id'],
      event_fields: {
        call_chain_id: chain.id,
        entry_point_id: chain.entry_point.entry_point_id,
      },
    };
  }

  const node = cas.nodes.find(candidate => candidate.id === staticId);
  if (node) {
    return {
      keys: ['node_id'],
      event_fields: {
        node_id: node.id,
      },
    };
  }

  return { keys: [], event_fields: {} };
}

function eventTypeForLink(link: CASRuntimeStaticLink): RuntimeEventType {
  if (link.kind === 'exit-point' || link.kind === 'external-service') return 'exit';
  if (link.kind === 'telemetry-hook') return 'custom';
  return 'request';
}

function emitRule(link: CASRuntimeStaticLink): string {
  if (link.kind === 'entry-point') return 'Emit at request, route, job, message, CLI, page, or lifecycle entry.';
  if (link.kind === 'exit-point') return 'Emit around external IO, database, API, message, file, cache, SDK, or client-side boundary calls.';
  if (link.kind === 'call-chain') return 'Emit at the root operation and include trace or span ids for nested steps.';
  if (link.kind === 'external-service') return 'Emit when calling or receiving from the named external service.';
  return 'Emit from the telemetry hook named by runtime_signal.';
}
