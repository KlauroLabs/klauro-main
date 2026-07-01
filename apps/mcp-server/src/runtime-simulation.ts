import type { CASOutput, CASEntryPoint, CASNode, CASRuntimeStaticLink } from '../../../packages/analyzer-core/src/types/cas.types';
import { buildOperationalPriorities, correlateRuntimeEvent, type RuntimeEventInput, type RuntimeObservation } from './product';
import { loadRuntimeObservations, saveRuntimeObservation } from './storage';

export type RuntimeSimulationScenario = 'balanced' | 'bug-hunt' | 'traffic-spike' | 'slow-dependencies';

export interface RuntimeSimulationOptions {
  scenario?: RuntimeSimulationScenario;
  eventCount?: number;
  seed?: string;
  persist?: boolean;
}

export interface RuntimeSimulationResult {
  simulation_id: string;
  generated_at: string;
  source: 'simulated';
  scenario: RuntimeSimulationScenario;
  persisted: boolean;
  event_count: number;
  correlation_summary: {
    matched: number;
    partial: number;
    unmatched: number;
  };
  mapped_targets: Array<{
    id: string;
    label: string;
    type: string;
    observations: number;
    errors: number;
    slow_events: number;
    estimated_volume: number;
  }>;
  observations: RuntimeObservation[];
  operational_priorities: ReturnType<typeof buildOperationalPriorities>;
  agent_guidance: string[];
}

interface SimulationTarget {
  id: string;
  label: string;
  type: 'entry_point' | 'node' | 'runtime_link';
  entryPoint?: CASEntryPoint;
  node?: CASNode;
  runtimeLink?: CASRuntimeStaticLink;
  riskWeight: number;
}

export async function simulateRuntimeTelemetry(
  cas: CASOutput,
  projectPath: string,
  options: RuntimeSimulationOptions = {},
): Promise<RuntimeSimulationResult> {
  const scenario = options.scenario || 'balanced';
  const eventCount = clamp(Math.floor(options.eventCount || defaultEventCount(scenario)), 1, 500);
  const seed = options.seed || `${cas.analysis_id}:${scenario}:${eventCount}`;
  const persisted = options.persist !== false;
  const random = seededRandom(seed);
  const targets = buildSimulationTargets(cas);
  const observations: RuntimeObservation[] = [];
  const simulationId = `runtime_sim_${stableHash(seed).slice(0, 12)}_${Date.now()}`;
  const now = Date.now();

  for (let index = 0; index < eventCount; index += 1) {
    const target = pickTarget(targets, random);
    const event = buildEvent(cas, target, scenario, random, {
      index,
      timestamp: new Date(now - (eventCount - index) * 1000).toISOString(),
      simulationId,
    });
    const observation: RuntimeObservation = {
      id: `${simulationId}_${index + 1}`,
      project_path: projectPath,
      recorded_at: new Date().toISOString(),
      source: 'simulated',
      event,
      correlation: correlateRuntimeEvent(cas, event),
    };
    observations.push(observation);
    if (persisted) {
      await saveRuntimeObservation(projectPath, observation);
    }
  }

  const historical = persisted ? await loadRuntimeObservations(projectPath, { limit: 5000 }) : observations;
  const operationalPriorities = buildOperationalPriorities(cas, historical, { limit: 20 });

  return {
    simulation_id: simulationId,
    generated_at: new Date().toISOString(),
    source: 'simulated',
    scenario,
    persisted,
    event_count: observations.length,
    correlation_summary: {
      matched: observations.filter(observation => observation.correlation.status === 'matched').length,
      partial: observations.filter(observation => observation.correlation.status === 'partial').length,
      unmatched: observations.filter(observation => observation.correlation.status === 'unmatched').length,
    },
    mapped_targets: summarizeTargets(observations),
    observations: observations.slice(0, 25),
    operational_priorities: operationalPriorities,
    agent_guidance: [
      'Treat simulated telemetry as a product-planning layer, not production truth.',
      'Use get_operational_priorities to see how runtime volume, errors, and latency change the next-work ranking.',
      'Use get_agent_context for a selected static target before editing so fixes still follow CAS idioms, tests, and invariants.',
    ],
  };
}

function buildSimulationTargets(cas: CASOutput): SimulationTarget[] {
  const nodesById = new Map((cas.nodes || []).map(node => [node.id, node]));
  const riskNodes = new Set<string>([
    ...(cas.change_risk_summary?.high_risk_nodes || []),
    ...(cas.change_risk_summary?.untested_critical_paths || []),
    ...((cas.system_health?.risk_areas || []).flatMap(area => area.affected_nodes || [])),
  ]);
  const targets: SimulationTarget[] = [];

  const exitPointsById = new Map((cas.exit_points || []).map(exit => [exit.id, exit]));
  for (const link of cas.runtime_static_links || []) {
    const exitPoint = exitPointsById.get(link.static_id);
    const node = nodesById.get(link.static_id) ||
      (exitPoint?.source_node ? nodesById.get(exitPoint.source_node) : undefined);
    const entryPoint = (cas.entry_points || []).find(entry => entry.id === link.static_id);
    targets.push({
      id: link.static_id,
      label: runtimeLinkLabel(node, entryPoint, link),
      type: 'runtime_link',
      node,
      entryPoint,
      runtimeLink: link,
      riskWeight: riskNodes.has(link.static_id) ? 4 : 1 + Math.max(0, link.confidence || 0),
    });
  }

  for (const entryPoint of cas.entry_points || []) {
    targets.push({
      id: entryPoint.id,
      label: entryPoint.name,
      type: 'entry_point',
      entryPoint,
      node: nodesById.get(entryPoint.source_node),
      riskWeight: riskNodes.has(entryPoint.id) || riskNodes.has(entryPoint.source_node) ? 4 : 1.5,
    });
  }

  for (const node of cas.nodes || []) {
    if (!isRuntimeInterestingNode(node, riskNodes)) continue;
    targets.push({
      id: node.id,
      label: node.name,
      type: 'node',
      node,
      riskWeight: riskNodes.has(node.id) ? 5 : 1,
    });
  }

  if (targets.length > 0) return dedupeTargets(targets);

  const fallbackNodes = (cas.nodes || []).slice(0, 20).map(node => ({
    id: node.id,
    label: node.name,
    type: 'node' as const,
    node,
    riskWeight: 1,
  }));
  return fallbackNodes.length > 0
    ? fallbackNodes
    : [{ id: cas.system.id, label: cas.system.name, type: 'node', riskWeight: 1 }];
}

function runtimeLinkLabel(node: CASNode | undefined, entryPoint: CASEntryPoint | undefined, link: CASRuntimeStaticLink): string {
  const base = link.runtime_signal || node?.name || entryPoint?.name || link.id;
  const file = String(node?.source?.file || entryPoint?.handler?.file || (link as any).evidence?.[0]?.file || '').replace(/\\/g, '/');
  const segments = file
    .split('/')
    .filter(segment => segment && !/^(src|app|apps|lib|libs|packages|node_modules|dist|build)$/i.test(segment))
    .map(segment => segment.replace(/\.[^.]+$/, ''))
    .filter(Boolean);
  const feature = segments.slice(-2).join('/');
  if (feature && feature.toLowerCase() !== String(base).toLowerCase()) {
    return `${base} in ${feature}`;
  }
  return base;
}

function buildEvent(
  cas: CASOutput,
  target: SimulationTarget,
  scenario: RuntimeSimulationScenario,
  random: () => number,
  context: { index: number; timestamp: string; simulationId: string },
): RuntimeEventInput & { timestamp: string } {
  const errorRate = scenario === 'bug-hunt' ? 0.38 : scenario === 'traffic-spike' ? 0.08 : scenario === 'slow-dependencies' ? 0.16 : 0.12;
  const slowRate = scenario === 'slow-dependencies' ? 0.55 : scenario === 'traffic-spike' ? 0.28 : scenario === 'bug-hunt' ? 0.22 : 0.14;
  const isError = random() < errorRate * Math.min(2.5, target.riskWeight);
  const isSlow = random() < slowRate;
  const entryPoint = target.entryPoint;
  const node = target.node;
  const route = entryPoint?.trigger?.path || routeFromTarget(target);
  const method = entryPoint?.trigger?.method || methodFromScenario(scenario, context.index);
  const volume = scenario === 'traffic-spike'
    ? Math.round(75 + random() * 900)
    : Math.round(1 + random() * 75);
  const duration = Math.round((isSlow ? 1200 + random() * 3600 : 60 + random() * 600) * Math.max(1, target.riskWeight / 3));
  const type: RuntimeEventInput['type'] = isError ? 'error' : (target.runtimeLink?.kind === 'exit-point' ? 'exit' : 'request');

  return {
    type,
    timestamp: context.timestamp,
    schema_version: 'simulated-1',
    service_name: cas.system.name,
    environment: 'simulation',
    signal: target.runtimeLink?.runtime_signal || `${type}:${method}:${route}`,
    static_id: target.runtimeLink?.static_id,
    node_id: node?.id,
    entry_point_id: entryPoint?.id,
    exit_point_id: target.runtimeLink?.kind === 'exit-point' ? target.runtimeLink.static_id : undefined,
    call_chain_id: target.runtimeLink?.kind === 'call-chain' ? target.runtimeLink.static_id : undefined,
    trace_id: `${context.simulationId}_trace_${Math.floor(context.index / 3)}`,
    span_id: `${context.simulationId}_span_${context.index}`,
    method,
    route,
    path: route,
    status_code: isError ? statusCodeForScenario(scenario, random) : 200,
    duration_ms: duration,
    error_message: isError ? simulatedErrorMessage(target, scenario) : undefined,
    stack: isError && node?.source?.file ? `Error: ${simulatedErrorMessage(target, scenario)}\n    at ${node.name} (${node.source.file}:${node.source.line || 1}:1)` : undefined,
    attributes: {
      simulated: true,
      simulation_id: context.simulationId,
      scenario,
      volume,
      target_label: target.label,
      target_kind: target.type,
    },
  };
}

function summarizeTargets(observations: RuntimeObservation[]): RuntimeSimulationResult['mapped_targets'] {
  const groups = new Map<string, RuntimeObservation[]>();
  for (const observation of observations) {
    const key = observation.correlation.best_match?.id || observation.event.node_id || observation.event.entry_point_id || observation.event.static_id || 'unmatched';
    groups.set(key, [...(groups.get(key) || []), observation]);
  }

  return [...groups.entries()].map(([id, items]) => {
    const best = items.find(item => item.correlation.best_match)?.correlation.best_match;
    return {
      id,
      label: best?.label || String(items[0]?.event.attributes?.target_label || id),
      type: best?.type || String(items[0]?.event.attributes?.target_kind || 'unknown'),
      observations: items.length,
      errors: items.filter(item => item.event.type === 'error' || Number(item.event.status_code || 0) >= 500).length,
      slow_events: items.filter(item => Number(item.event.duration_ms || 0) >= 1000).length,
      estimated_volume: items.reduce((total, item) => total + Number(item.event.attributes?.volume || 1), 0),
    };
  }).sort((left, right) => right.errors - left.errors || right.estimated_volume - left.estimated_volume);
}

function pickTarget(targets: SimulationTarget[], random: () => number): SimulationTarget {
  const total = targets.reduce((sum, target) => sum + target.riskWeight, 0);
  let cursor = random() * total;
  for (const target of targets) {
    cursor -= target.riskWeight;
    if (cursor <= 0) return target;
  }
  return targets[targets.length - 1];
}

function dedupeTargets(targets: SimulationTarget[]): SimulationTarget[] {
  const byId = new Map<string, SimulationTarget>();
  for (const target of targets) {
    const existing = byId.get(target.id);
    if (!existing || target.riskWeight > existing.riskWeight) byId.set(target.id, target);
  }
  return [...byId.values()];
}

function isRuntimeInterestingNode(node: CASNode, riskNodes: Set<string>): boolean {
  if (riskNodes.has(node.id)) return true;
  const type = `${node.type} ${node.category || ''}`.toLowerCase();
  return /controller|service|handler|repository|resolver|consumer|job|command|route|page/.test(type);
}

function routeFromTarget(target: SimulationTarget): string {
  const file = target.node?.source?.file?.replace(/\.[^.]+$/, '') || target.label;
  const clean = file
    .split(/[\\/]/)
    .filter(Boolean)
    .slice(-3)
    .join('/')
    .replace(/[^a-zA-Z0-9/_-]/g, '-')
    .replace(/-+/g, '-')
    .toLowerCase();
  return clean.startsWith('/') ? clean : `/${clean || 'runtime-target'}`;
}

function methodFromScenario(scenario: RuntimeSimulationScenario, index: number): string {
  if (scenario === 'traffic-spike') return 'GET';
  return ['GET', 'POST', 'PUT', 'DELETE'][index % 4];
}

function statusCodeForScenario(scenario: RuntimeSimulationScenario, random: () => number): number {
  if (scenario === 'bug-hunt') return random() < 0.75 ? 500 : 422;
  if (scenario === 'slow-dependencies') return random() < 0.4 ? 504 : 500;
  return 500;
}

function simulatedErrorMessage(target: SimulationTarget, scenario: RuntimeSimulationScenario): string {
  if (scenario === 'slow-dependencies') return `${target.label} exceeded the simulated latency budget`;
  if (scenario === 'traffic-spike') return `${target.label} showed elevated failure rate under simulated traffic`;
  return `${target.label} failed in simulated runtime exercise`;
}

function defaultEventCount(scenario: RuntimeSimulationScenario): number {
  return scenario === 'traffic-spike' ? 120 : scenario === 'bug-hunt' ? 80 : 60;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function seededRandom(seed: string): () => number {
  let state = parseInt(stableHash(seed).slice(0, 8), 16) || 1;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function stableHash(input: string): string {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
