/**
 * WS-A — Telemetry Fusion (L3): fuse OTEL-ish spans onto the live CAS.
 *
 * Reuses the ALREADY-VETTED span->node correlation logic (`correlateRuntimeEvent`
 * in ./product, proven in gauntlet/telemetry-overlay-bench.ts) rather than
 * reinventing correlation. This module's job is narrow: turn a batch of
 * lightweight runtime spans into persisted `RuntimeFact`s keyed to CAS node ids,
 * and provide a thin disk-persistence sibling to storage.ts (a dedicated
 * per-workspace file, not touching the shared storage index).
 *
 * `fuseTelemetry` is pure over a given CAS (no I/O) so it is directly unit- and
 * bench-testable. `ingestAndPersist` is the thin I/O wrapper used by the (not
 * yet wired) `POST /v1/telemetry/ingest` route.
 */

import * as fs from 'fs-extra';
import * as path from 'path';
import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import { correlateRuntimeEvent, type RuntimeCorrelationResult, type RuntimeEventInput } from './product';
import { getProjectStorageDir } from './storage';

/** A single OTEL-ish runtime span as delivered by a collector/SDK. */
export interface TelemetrySpan {
  service: string;
  endpoint: string;
  duration_ms?: number;
  error?: boolean;
  count?: number;
  stack?: string;
  /** Optional explicit method (GET/POST/...) when `endpoint` is an HTTP route. */
  method?: string;
  /** Optional window label for the observation (e.g. "1h", "24h"). Defaults to "1h". */
  window?: string;
}

export type RuntimeFactKind = 'hot' | 'slow' | 'error';

/** A persisted runtime fact bound to a CAS node, ready to inject onto the stored CAS. */
export interface RuntimeFact {
  node_id: string;
  kind: RuntimeFactKind;
  metric: number;
  window: string;
  count: number;
  /** Provenance: the span's service+endpoint and the CAS evidence id it matched. */
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

/** Slow if the span's own duration crosses this threshold, mirroring telemetry-overlay-bench's deriveFact. */
const SLOW_DURATION_MS = 1000;
/** Hot if observed call volume in the window crosses this threshold. */
const HOT_COUNT = 100;

/**
 * Map a fusion-batch span to the RuntimeEventInput shape(s) correlateRuntimeEvent
 * expects. A span's endpoint may be an inbound route (matched via entry points,
 * any event `type`) or an outbound call (matched via exit points, which
 * `correlateRuntimeEvent`'s matchRuntimeExit only attempts for `type: 'exit'`).
 * We don't know which side of the fence a span's endpoint sits on ahead of
 * time, so we build both candidate events and let correlation itself decide —
 * mirroring how telemetry-overlay-bench's spanToEvent branches on span.kind,
 * except here spans don't carry an explicit kind.
 */
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

/**
 * Correlate a span against the CAS by trying its candidate RuntimeEventInput
 * shapes (outbound-exit first, then inbound-request/error) and keeping the
 * best (first matched, non-unmatched) result. Reusing `correlateRuntimeEvent`
 * as-is per candidate avoids duplicating or reimplementing its evidence
 * ranking/dedup logic.
 */
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

/** Derive the operational fact kind from a span, same thresholds as telemetry-overlay-bench.deriveFact. */
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

/**
 * Resolve a correlateRuntimeEvent EvidenceRef to the underlying CAS node id.
 * Entry/exit points reference their owning node via `source_node`; a direct
 * node match already IS a node id.
 */
function resolveNodeId(cas: CASOutput, matchId: string): string | undefined {
  const node = cas.nodes.find(candidate => candidate.id === matchId);
  if (node) return node.id;

  const entryPoint = (cas.entry_points || []).find(candidate => candidate.id === matchId);
  if (entryPoint) return entryPoint.source_node || entryPoint.handler?.node_id || entryPoint.id;

  const exitPoint = (cas.exit_points || []).find(candidate => candidate.id === matchId);
  if (exitPoint) return exitPoint.source_node || exitPoint.id;

  return undefined;
}

/**
 * Fuse a batch of runtime spans onto a CAS: correlate each span to a static
 * node via the existing vetted `correlateRuntimeEvent`, then derive a
 * RuntimeFact from the observed hot/slow/error signal. Spans that don't
 * correlate to any CAS node are rejected as unmatched, never force-fit.
 *
 * Pure — no I/O, no persistence, no engine/AI dependency. Safe for both the
 * production ingest path and the blackbox bench.
 */
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

// =============================================================================
// PERSISTENCE — a sibling writer to storage.ts, not an edit to it.
// =============================================================================

const RUNTIME_FACTS_FILE = 'runtime-facts.json';

export interface PersistedRuntimeFacts {
  workspace: string;
  updated_at: string;
  facts: RuntimeFact[];
}

function runtimeFactsPath(dataDir: string, workspace: string): string {
  // Mirror getProjectStorageDir's per-project slugging so facts live alongside
  // the analysis for the same project/workspace key, without touching storage.ts.
  const projectDir = getProjectStorageDir(workspace);
  // getProjectStorageDir is rooted at the global storage path; when a dedicated
  // dataDir is supplied (e.g. by the analyzer server), prefer it as the root so
  // fusion facts co-locate with that server's own storage instance.
  return dataDir
    ? path.join(dataDir, path.basename(projectDir), RUNTIME_FACTS_FILE)
    : path.join(projectDir, RUNTIME_FACTS_FILE);
}

/**
 * Fuse telemetry for a workspace/repo and persist the resulting facts to disk,
 * merging with any previously persisted facts (last-write-wins per node_id+kind
 * +service+endpoint). Mirrors the storage.ts write-json-atomic-ish pattern
 * (ensureDir + writeJson) without editing storage.ts.
 */
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

/** Load previously persisted runtime facts for a workspace, if any. */
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
  for (const fact of incoming) byKey.set(factKey(fact), fact); // incoming wins
  return [...byKey.values()];
}
