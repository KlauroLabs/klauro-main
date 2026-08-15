

































import * as fs from 'fs-extra';
import * as path from 'path';
import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import { correlateRuntimeEvent, type RuntimeCorrelationResult, type RuntimeEventInput } from './product';
import { getProjectStorageDir } from './storage';


export interface TelemetrySpan {
  service: string;
  endpoint: string;
  duration_ms?: number;
  error?: boolean;
  count?: number;
  stack?: string;

  method?: string;

  window?: string;
}

export type RuntimeFactKind = 'hot' | 'slow' | 'error';


export interface RuntimeFact {
  node_id: string;
  kind: RuntimeFactKind;
  metric: number;
  window: string;
  count: number;

  service: string;
  endpoint: string;
  matched_id: string;
  matched_label: string;
  confidence: number;
}

export interface UnmatchedSpan {
  service: string;
  endpoint: string;
  reason: string;
}

export interface FuseTelemetryResult {
  facts: RuntimeFact[];
  unmatched: UnmatchedSpan[];
}

const DEFAULT_WINDOW = '1h';


const SLOW_DURATION_MS = 1000;












function spanToRuntimeEvents(span: TelemetrySpan): RuntimeEventInput[] {
  const base = {
    service_name: span.service,
    method: span.method,
    duration_ms: span.duration_ms,
    attributes: { count: span.count },
  };
  const exitEvent: RuntimeEventInput = {
    ...base,
    type: 'exit',
    endpoint: span.endpoint,
    target: span.endpoint,
  };
  if (span.error) {
    const errorEvent: RuntimeEventInput = {
      ...base,
      type: 'error',
      error_message: `error in ${span.endpoint}`,
      stack: span.stack,
      path: span.endpoint,
      route: span.endpoint,
    };
    return [exitEvent, errorEvent];
  }
  const requestEvent: RuntimeEventInput = {
    ...base,
    type: 'request',
    path: span.endpoint,
    route: span.endpoint,
    status_code: 200,
  };
  return [exitEvent, requestEvent];
}








function bestCorrelation(cas: CASOutput, span: TelemetrySpan): RuntimeCorrelationResult | undefined {
  let best: RuntimeCorrelationResult | undefined;
  for (const event of spanToRuntimeEvents(span)) {
    const result = correlateRuntimeEvent(cas, event);
    if (result.status === 'unmatched') continue;
    if (!best || result.status === 'matched') return result;
    best = result;
  }
  return best;
}


function deriveFactKind(span: TelemetrySpan): RuntimeFactKind {
  if (span.error) return 'error';
  if (Number(span.duration_ms || 0) >= SLOW_DURATION_MS) return 'slow';
  return 'hot';
}

function factMetric(kind: RuntimeFactKind, span: TelemetrySpan): number {
  if (kind === 'slow') return Number(span.duration_ms || 0);
  if (kind === 'error') return Number(span.count || 1);
  return Number(span.count || 0);
}






function resolveNodeId(cas: CASOutput, matchId: string): string | undefined {
  const node = cas.nodes.find(candidate => candidate.id === matchId);
  if (node) return node.id;

  const entryPoint = (cas.entry_points || []).find(candidate => candidate.id === matchId);
  if (entryPoint) return entryPoint.source_node || entryPoint.handler?.node_id || entryPoint.id;

  const exitPoint = (cas.exit_points || []).find(candidate => candidate.id === matchId);
  if (exitPoint) return exitPoint.source_node || exitPoint.id;

  return undefined;
}










export function fuseTelemetry(cas: CASOutput, spans: TelemetrySpan[], options: { window?: string } = {}): FuseTelemetryResult {
  const window = options.window || DEFAULT_WINDOW;
  const facts: RuntimeFact[] = [];
  const unmatched: UnmatchedSpan[] = [];

  for (const span of spans) {
    const correlation = bestCorrelation(cas, span);

    if (!correlation || correlation.status === 'unmatched' || !correlation.best_match) {
      unmatched.push({
        service: span.service,
        endpoint: span.endpoint,
        reason: 'no matching CAS entry point, exit point, node, or stack frame',
      });
      continue;
    }

    const nodeId = resolveNodeId(cas, correlation.best_match.id);
    if (!nodeId) {
      unmatched.push({
        service: span.service,
        endpoint: span.endpoint,
        reason: `matched evidence ${correlation.best_match.id} did not resolve to a CAS node`,
      });
      continue;
    }

    const kind = deriveFactKind(span);
    facts.push({
      node_id: nodeId,
      kind,
      metric: factMetric(kind, span),
      window,
      count: Number(span.count || 1),
      service: span.service,
      endpoint: span.endpoint,
      matched_id: correlation.best_match.id,
      matched_label: correlation.best_match.label,
      confidence: correlation.best_match.confidence ?? 0.9,
    });
  }

  return { facts, unmatched };
}





const RUNTIME_FACTS_FILE = 'runtime-facts.json';

export interface PersistedRuntimeFacts {
  workspace: string;
  updated_at: string;
  facts: RuntimeFact[];
}

function runtimeFactsPath(dataDir: string, workspace: string): string {


  const projectDir = getProjectStorageDir(workspace);



  return dataDir
    ? path.join(dataDir, path.basename(projectDir), RUNTIME_FACTS_FILE)
    : path.join(projectDir, RUNTIME_FACTS_FILE);
}







export async function ingestAndPersist(
  dataDir: string,
  workspace: string,
  cas: CASOutput,
  spans: TelemetrySpan[],
  options: { window?: string } = {},
): Promise<FuseTelemetryResult & { persisted_path: string; total_facts: number }> {
  const result = fuseTelemetry(cas, spans, options);
  const filePath = runtimeFactsPath(dataDir, workspace);
  await fs.ensureDir(path.dirname(filePath));

  let existing: RuntimeFact[] = [];
  if (await fs.pathExists(filePath)) {
    try {
      const prior: PersistedRuntimeFacts = await fs.readJson(filePath);
      existing = prior.facts || [];
    } catch {
      existing = [];
    }
  }

  const merged = mergeFacts(existing, result.facts);
  const payload: PersistedRuntimeFacts = {
    workspace,
    updated_at: new Date().toISOString(),
    facts: merged,
  };
  await fs.writeJson(filePath, payload, { spaces: 2 });

  return { ...result, persisted_path: filePath, total_facts: merged.length };
}


export async function loadPersistedRuntimeFacts(dataDir: string, workspace: string): Promise<PersistedRuntimeFacts | null> {
  const filePath = runtimeFactsPath(dataDir, workspace);
  if (!(await fs.pathExists(filePath))) return null;
  try {
    return await fs.readJson(filePath);
  } catch {
    return null;
  }
}

function factKey(fact: RuntimeFact): string {
  return `${fact.node_id}::${fact.kind}::${fact.service}::${fact.endpoint}`;
}

function mergeFacts(existing: RuntimeFact[], incoming: RuntimeFact[]): RuntimeFact[] {
  const byKey = new Map<string, RuntimeFact>();
  for (const fact of existing) byKey.set(factKey(fact), fact);
  for (const fact of incoming) byKey.set(factKey(fact), fact);
  return [...byKey.values()];
}
