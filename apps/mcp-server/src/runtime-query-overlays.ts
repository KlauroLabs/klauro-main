import type { CASCapability, CASOutput, CASRuntimeStaticLink } from '../../../packages/analyzer-core/src/types/cas.types';
import type { RuntimeMetricLike } from '../../../packages/analyzer-core/src/analyzer/core/flow-concepts';

export function observedRuntimeStaticLinks(cas: CASOutput, metrics: RuntimeMetricLike[]): CASRuntimeStaticLink[] {
  const observedIds = new Set(metrics.flatMap(metric => [
    metric.static_id,
    metric.node_id,
    metric.entry_point_id,
  ].filter((id): id is string => Boolean(id))));
  return (cas.runtime_static_links || []).map(link =>
    observedIds.has(link.id) || observedIds.has(link.static_id)
      ? { ...link, telemetry_status: 'observed' }
      : link
  );
}

export function capabilityRuntimeTelemetryById(
  cas: CASOutput,
  capabilities: CASCapability[],
  metrics: RuntimeMetricLike[],
): Map<string, Record<string, unknown>> {
  const runtimeLinkTargetById = new Map((cas.runtime_static_links || []).map(link => [link.id, link.static_id]));
  const metricsById = new Map<string, RuntimeMetricLike>();
  for (const metric of metrics) {
    for (const id of [metric.static_id, runtimeLinkTargetById.get(metric.static_id), metric.node_id, metric.entry_point_id]) {
      if (id && !metricsById.has(id)) metricsById.set(id, metric);
    }
  }
  const result = new Map<string, Record<string, unknown>>();
  for (const capability of capabilities) {
    const matched = [...new Set([...capability.entry_points, ...capability.call_chain_ids]
      .map(id => metricsById.get(id)).filter((metric): metric is RuntimeMetricLike => Boolean(metric)))];
    if (matched.length === 0) continue;
    const requestCount = matched.reduce((total, metric) => total + metric.request_count, 0);
    const weightedErrors = matched.reduce((total, metric) => total + metric.request_count * metric.error_rate, 0);
    result.set(capability.id, {
      observed: true,
      matched_signal_count: matched.length,
      request_count: requestCount,
      error_rate: requestCount > 0 ? weightedErrors / requestCount : 0,
      p95_ms: Math.max(...matched.map(metric => metric.latency?.p95_ms || 0)),
    });
  }
  return result;
}


export function observedRuntimeFlowEvidence(cas: CASOutput): Array<{
  flow_id: string;
  static_ids: string[];
  capability_ids: string[];
}> {
  return (cas.flows || []).map(flow => ({
    flow_id: flow.flow_id,
    static_ids: [...new Set([
      flow.entry_point,
      ...flow.steps.flatMap(step => step.functions.map(fn => fn.function_id)),
      flow.terminus?.node_id,
    ].filter((id): id is string => Boolean(id)))],
    capability_ids: [...new Set([
      flow.capability_id,
      ...(flow.capability_relationships || []).map(relationship => relationship.capability_id),
    ].filter((id): id is string => Boolean(id)))],
  }));
}
