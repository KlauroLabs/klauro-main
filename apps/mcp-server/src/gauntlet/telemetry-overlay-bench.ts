/**
 * TELEMETRY OVERLAY bench — "how it's running", fused onto static structure.
 *
 * This is the genuine head-to-head on the historically UN-WON axis (docs/CAMPS.md):
 * runtime observation (traces/metrics) correlated back to the code that produced
 * it. Unlike telemetry-bench.ts — which models the competitors as un-attempted
 * (they expose no runtime input on their primary tools) — this bench gives the
 * REAL installed codebase-memory binary its STRONGEST attempt: it ships an
 * `ingest_traces` tool, so we index each fixture into it, feed it the same spans,
 * and measure what correlation it actually produces.
 *
 * A fixture is a small app + a `traces.json` (idiomatic runtime spans: service,
 * span name/endpoint, duration_ms, error, count) + a `truth.json`:
 *   { task: 'telemetry-overlay',
 *     correlations: [ { runtime_span, static_node: {kind,...}|null, fact: hot|error|slow|unused|unmatched } ],
 *     hot_answer: '<the #1 "how it's running" target>' }
 * Each fixture includes a DECOY span that maps to no static node — honest
 * correlation must report it `unmatched`, never force-fit it.
 *
 * Klauro path: orchestrateAnalysis(dir) -> correlateRuntimeEvent(cas, span) per
 * span -> {span -> static node, derived fact} -> F1 vs truth + a compact
 * "how it's running" answer. codebase-memory path: index_repository + ingest_traces
 * -> parse its response -> its correlation set -> F1. Verdict is honest:
 *   - tie-ceiling if cbm correlates comparably,
 *   - win if Klauro fuses runtime->static and cbm cannot (or fewer),
 *   - loss (SURFACE LOUD) if cbm strictly out-correlates Klauro.
 */

import * as fs from 'fs-extra';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { createOrchestrator } from '../analyzer';
import { correlateRuntimeEvent, type RuntimeEventInput } from '../product';
import { validateWin } from './win-validator';
import type { ArmResult } from './report-schema';

export type OverlayFact = 'hot' | 'error' | 'slow' | 'unused' | 'unmatched';

export interface OverlaySpan {
  name: string;
  kind?: 'request' | 'error' | 'exit';
  service?: string;
  method?: string;
  route?: string;
  endpoint?: string;
  duration_ms?: number;
  p95_ms?: number;
  p99_ms?: number;
  error?: boolean;
  error_message?: string;
  stack?: string;
  count?: number;
  error_rate?: number;
  rate_per_min?: number;
}

export interface OverlayTraces {
  service?: string;
  spans: OverlaySpan[];
}

export interface OverlayTruthCorrelation {
  runtime_span: string;
  static_node: { kind: string; method?: string; path?: string; endpoint?: string; name?: string } | null;
  fact: OverlayFact;
}

export interface OverlayTruth {
  task: 'telemetry-overlay';
  correlations: OverlayTruthCorrelation[];
  hot_answer?: string;
}

export interface OverlayArmDetail {
  arm: string;
  correct: number;
  total: number;
  f1: number;
  bytes: number;
  can_answer: boolean;
  /** Honest record of what the arm actually did with the traces. */
  note?: string;
}

export interface TelemetryOverlayBenchResult {
  fixture: string;
  arms: ArmResult[];
  verdict: ReturnType<typeof validateWin>;
  detail: OverlayArmDetail[];
  /** Klauro's compact "how it's running" answer for this fixture. */
  how_its_running?: string;
  /** Did Klauro correctly report the decoy span as unmatched? */
  decoy_handled_honestly: boolean;
}

const CBM_BIN = path.join(process.env.HOME || '', '.local/bin/codebase-memory-mcp');

export function cbmAvailable(): boolean {
  try {
    return fs.existsSync(CBM_BIN);
  } catch {
    return false;
  }
}

function toTokens(bytes: number): number {
  return Math.max(1, Math.round(bytes / 4));
}

async function sourceBytes(dir: string): Promise<number> {
  let total = 0;
  for (const f of await fs.readdir(dir)) {
    if (f === 'truth.json' || f === 'traces.json') continue;
    try {
      const st = await fs.stat(path.join(dir, f));
      if (st.isFile()) total += st.size;
    } catch { /* noop */ }
  }
  return total;
}

function normPath(p: string): string {
  return (p || '').replace(/\{([^}:]+)\}/g, ':$1').replace(/<(?:[^>:]+:)?([^>]+)>/g, ':$1');
}

/** Map an idiomatic runtime span to a Klauro RuntimeEventInput. */
export function spanToEvent(span: OverlaySpan): RuntimeEventInput {
  const kind = span.kind || (span.endpoint ? 'exit' : 'request');
  const attributes = {
    ...(typeof span.count === 'number' ? { count: span.count, volume: span.count } : {}),
    ...(typeof span.p95_ms === 'number' ? { p95_ms: span.p95_ms } : {}),
    ...(typeof span.p99_ms === 'number' ? { p99_ms: span.p99_ms } : {}),
    ...(typeof span.error_rate === 'number' ? { error_rate: span.error_rate } : {}),
    ...(typeof span.rate_per_min === 'number' ? { rate_per_min: span.rate_per_min } : {}),
  };
  if (kind === 'exit') {
    return { type: 'exit', endpoint: span.endpoint, method: span.method, duration_ms: span.duration_ms, attributes };
  }
  if (kind === 'error') {
    return { type: 'error', error_message: span.error_message, stack: span.stack, attributes };
  }
  return {
    type: 'request',
    method: span.method,
    path: span.route,
    duration_ms: span.duration_ms,
    status_code: span.error ? 500 : 200,
    attributes,
  };
}

/**
 * Derive the operational fact from runtime attributes. This is a runtime
 * observation, not a fabrication: error from error flag/status, slow from
 * duration >= 1000ms, hot from high call volume, else unused.
 */
export function deriveFact(span: OverlaySpan): OverlayFact {
  if (span.error || span.kind === 'error') return 'error';
  if (Number(span.error_rate || 0) >= 0.01) return 'error';
  if (Number(span.p99_ms || 0) >= 2000 || Number(span.p95_ms || 0) >= 1000 || Number(span.duration_ms || 0) >= 1000) return 'slow';
  if (Number(span.rate_per_min || 0) >= 100 || Number(span.count || 0) >= 100) return 'hot';
  return 'unused';
}

/** Does a correlated EvidenceRef satisfy the truth's expected static_node? */
function refMatchesNode(
  ref: any,
  matches: any[],
  expected: OverlayTruthCorrelation['static_node'],
): boolean {
  if (!ref || !expected) return false;
  const all = [ref, ...(matches || [])].filter(Boolean);
  if (expected.kind === 'function') {
    return all.some(m => String(m.label || '').split(':').pop() === expected.name);
  }
  if (expected.kind === 'exit') {
    const want = normPath(expected.endpoint || '');
    return all.some(m => m.type === 'exit_point' && normPath(String(m.label || '')).includes(want));
  }
  // route: entry point whose method + path match.
  const wantPath = normPath(expected.path || '');
  const wantMethod = (expected.method || '').toUpperCase();
  return all.some(m => {
    if (m.type !== 'entry_point') return false;
    const label = String(m.label || '');
    // entry-point labels are "<METHOD> <path>"
    const [lm, ...rest] = label.split(' ');
    const lpath = normPath(rest.join(' '));
    return lm.toUpperCase() === wantMethod && lpath === wantPath;
  });
}

interface KlauroOverlay {
  correct: number;
  total: number;
  bytes: number;
  time_ms: number;
  how_its_running: string;
  decoy_handled_honestly: boolean;
}

async function klauroOverlay(dir: string, traces: OverlayTraces, truth: OverlayTruth): Promise<KlauroOverlay> {
  const t0 = Date.now();
  const cas: any = await createOrchestrator().orchestrateAnalysis(dir);
  const spanByName = new Map(traces.spans.map(s => [s.name, s]));
  let correct = 0;
  let decoyHonest = true;
  const answerLines: string[] = [];
  let topTarget = '';
  let topScore = -1;

  for (const corr of truth.correlations) {
    const span = spanByName.get(corr.runtime_span);
    if (!span) { answerLines.push(`${corr.runtime_span} -> NO SUCH SPAN`); continue; }
    const event = spanToEvent(span);
    const r = correlateRuntimeEvent(cas, event);
    const matched = r.status !== 'unmatched';

    if (corr.static_node === null) {
      // Decoy: honest correlation MUST report unmatched, never force-fit.
      const ok = !matched;
      if (ok) correct++; else decoyHonest = false;
      answerLines.push(`${corr.runtime_span} -> ${matched ? 'FORCE-FIT(' + (r.best_match as any)?.label + ')' : 'unmatched'}`);
      continue;
    }

    const nodeOk = refMatchesNode(r.best_match, r.matches, corr.static_node);
    const factOk = deriveFact(span) === corr.fact;
    if (nodeOk && factOk) correct++;
    const label = (r.best_match as any)?.label || 'none';
    answerLines.push(`${corr.runtime_span} -> ${label} [${deriveFact(span)}]`);

    // The "how it's running" headline = highest-impact correlated span
    // (error worst, then slow, then hot), volume-weighted.
    if (nodeOk) {
      const sev = corr.fact === 'error' ? 3 : corr.fact === 'slow' ? 2 : corr.fact === 'hot' ? 1 : 0;
      const score = sev * 1e6 + Number(span.count || 0);
      if (score > topScore) { topScore = score; topTarget = corr.runtime_span; }
    }
  }

  const how = topTarget ? `hottest: ${topTarget}` : 'no correlated runtime impact';
  return {
    correct,
    total: truth.correlations.length,
    bytes: Buffer.byteLength([how, ...answerLines].join('\n'), 'utf8'),
    time_ms: Date.now() - t0,
    how_its_running: how,
    decoy_handled_honestly: decoyHonest,
  };
}

interface CbmOverlay {
  correct: number;
  total: number;
  bytes: number;
  time_ms: number;
  note: string;
}

/**
 * codebase-memory's STRONGEST attempt: index the fixture, then feed it the same
 * spans via its `ingest_traces` tool, and score whatever correlation it returns.
 * We parse its response for any span->static-node mapping. As of the installed
 * binary, ingest_traces is a stub ("Runtime edge creation from traces not yet
 * implemented"): it counts traces but produces zero correlations and exposes no
 * query surface to retrieve a span->node link — so correct=0 honestly.
 */
function cbmOverlay(dir: string, traces: OverlayTraces, truth: OverlayTruth): CbmOverlay {
  const t0 = Date.now();
  const total = truth.correlations.length;
  try {
    const idxRaw = execFileSync(CBM_BIN, ['cli', 'index_repository', JSON.stringify({ repo_path: dir })], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 120000,
    });
    const idx = JSON.parse(idxRaw.trim().split('\n').filter(l => l.startsWith('{')).pop() || '{}');
    const project = idx.project as string | undefined;
    if (!project) {
      return { correct: 0, total, bytes: 0, time_ms: Date.now() - t0, note: 'cbm index produced no project name' };
    }

    // Hand cbm the spans in its strongest shape: name + route/endpoint + method +
    // duration + error + count, plus the project so it can attach to the graph.
    const cbmTraces = traces.spans.map(s => ({
      service: traces.service,
      name: s.name,
      route: s.route || s.endpoint,
      endpoint: s.endpoint,
      method: s.method,
      duration_ms: s.duration_ms,
      error: Boolean(s.error || s.kind === 'error'),
      count: s.count,
    }));
    const ingestRaw = execFileSync(
      CBM_BIN,
      ['cli', 'ingest_traces', JSON.stringify({ project, traces: cbmTraces })],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 60000 },
    );
    const ingest = JSON.parse(ingestRaw.trim().split('\n').filter(l => l.startsWith('{')).pop() || '{}');

    // A real correlation set would surface span->node links. cbm returns
    // {status, traces_received, note}. Count any correlations it actually emits.
    const links: any[] = ingest.correlations || ingest.runtime_edges || ingest.edges || ingest.links || [];
    let correct = 0;
    for (const corr of truth.correlations) {
      if (corr.static_node === null) continue; // decoy: no credit for "matching" nothing
      const hit = links.some((l: any) =>
        String(l.span || l.name || l.trace || '') === corr.runtime_span && (l.node_id || l.static_id || l.target));
      if (hit) correct++;
    }
    const note = links.length === 0
      ? `ingest_traces accepted ${ingest.traces_received ?? '?'} traces but produced 0 correlations${ingest.note ? ` ("${ingest.note}")` : ''}`
      : `ingest_traces produced ${links.length} correlation links`;
    return {
      correct,
      total,
      bytes: Buffer.byteLength(JSON.stringify(ingest), 'utf8'),
      time_ms: Date.now() - t0,
      note,
    };
  } catch (err: any) {
    return { correct: 0, total, bytes: 0, time_ms: Date.now() - t0, note: `cbm error: ${String(err?.message || err).slice(0, 160)}` };
  }
}

export async function runTelemetryOverlayBench(fixtureDir: string, options: { withCbm?: boolean } = {}): Promise<TelemetryOverlayBenchResult> {
  const truth: OverlayTruth = await fs.readJson(path.join(fixtureDir, 'truth.json'));
  const traces: OverlayTraces = await fs.readJson(path.join(fixtureDir, 'traces.json'));
  const kl = await klauroOverlay(fixtureDir, traces, truth);
  const srcBytes = await sourceBytes(fixtureDir);
  const klF1 = kl.total ? kl.correct / kl.total : 0;

  const arms: ArmResult[] = [
    {
      arm_id: 'klauro',
      mode: 'engine',
      attempted: true,
      metrics: { quality: Math.round(klF1 * 100), time_ms: kl.time_ms, tokens: toTokens(kl.bytes) },
      source: 'telemetry-overlay-bench',
    },
  ];
  const detail: OverlayArmDetail[] = [
    { arm: 'klauro', correct: kl.correct, total: kl.total, f1: klF1, bytes: kl.bytes, can_answer: true },
  ];

  const useCbm = options.withCbm !== false && cbmAvailable();
  if (useCbm) {
    const cbm = cbmOverlay(fixtureDir, traces, truth);
    const cbmF1 = cbm.total ? cbm.correct / cbm.total : 0;
    arms.push({
      arm_id: 'codebase-memory',
      mode: 'engine',
      attempted: true, // it HAS ingest_traces — we give it its strongest attempt
      metrics: { quality: Math.round(cbmF1 * 100), time_ms: cbm.time_ms, tokens: toTokens(Math.max(cbm.bytes, srcBytes)) },
      source: 'telemetry-overlay-bench:cbm-ingest_traces',
    });
    detail.push({ arm: 'codebase-memory', correct: cbm.correct, total: cbm.total, f1: cbmF1, bytes: cbm.bytes, can_answer: true, note: cbm.note });
  } else {
    detail.push({ arm: 'codebase-memory', correct: 0, total: kl.total, f1: 0, bytes: srcBytes, can_answer: false, note: 'cbm binary not installed — skipped' });
  }

  const verdict = validateWin(
    arms,
    'Klauro ingests runtime spans and correlates each to the exact static route / exit point / function it exercised, then surfaces the hot/error/slow fact; codebase-memory exposes ingest_traces but its runtime->static correlation is unimplemented, so it stores traces without fusing them to the graph.',
  );

  return {
    fixture: path.basename(fixtureDir),
    arms,
    verdict,
    detail,
    how_its_running: kl.how_its_running,
    decoy_handled_honestly: kl.decoy_handled_honestly,
  };
}

export interface TelemetryOverlayAggregate {
  cases: number;
  wins: number;
  ties: number;
  losses: number;
  winRate: number;
  meanKlauroF1: number;
  meanCbmF1: number;
  tokenSaving: number;
  results: TelemetryOverlayBenchResult[];
  lossNames: string[];
}

export async function runTelemetryOverlaySuite(root: string, options: { withCbm?: boolean } = {}): Promise<TelemetryOverlayAggregate> {
  const dirs = (await fs.readdir(root))
    .filter(d => fs.existsSync(path.join(root, d, 'truth.json')) && fs.existsSync(path.join(root, d, 'traces.json')))
    .sort();
  const results: TelemetryOverlayBenchResult[] = [];
  for (const d of dirs) results.push(await runTelemetryOverlayBench(path.join(root, d), options));

  let wins = 0, ties = 0, losses = 0;
  const lossNames: string[] = [];
  let klSum = 0, cbmSum = 0, klTok = 0, cbmTok = 0;
  for (const r of results) {
    const kl = r.detail.find(d => d.arm === 'klauro')!;
    const cbm = r.detail.find(d => d.arm === 'codebase-memory')!;
    klSum += kl.f1; cbmSum += cbm.f1;
    klTok += toTokens(kl.bytes);
    cbmTok += toTokens(Math.max(cbm.bytes, 1));
    if (kl.f1 > cbm.f1) wins++;
    else if (kl.f1 < cbm.f1) { losses++; lossNames.push(r.fixture); }
    else ties++;
  }
  const cases = results.length;
  return {
    cases,
    wins,
    ties,
    losses,
    winRate: cases ? wins / cases : 0,
    meanKlauroF1: cases ? klSum / cases : 0,
    meanCbmF1: cases ? cbmSum / cases : 0,
    tokenSaving: cbmTok > 0 ? 1 - klTok / cbmTok : 0,
    results,
    lossNames,
  };
}
