

















import * as fs from 'fs-extra';
import * as path from 'path';
import { analyzeForBench } from './product-analysis';
import { correlateRuntimeEvent, buildOperationalPriorities } from '../product';
import { validateWin } from './win-validator';
import type { ArmResult } from './report-schema';

interface TelemetryEventCase {
  event: any;
  expect?: 'unmatched';
  expect_method?: string;
  expect_path?: string;
  expect_function?: string;

  expect_exit?: string;
}
interface TelemetryTruth {
  task: 'telemetry-correlation' | 'telemetry-hotpath';
  events: TelemetryEventCase[];

  expected_top?: string;
}

export interface TelemetryBenchResult {
  fixture: string;
  arms: ArmResult[];
  verdict: ReturnType<typeof validateWin>;
  detail: Array<{ arm: string; correct: number; total: number; f1: number; bytes: number; can_answer: boolean }>;
}

function toTokens(bytes: number): number {
  return Math.max(1, Math.round(bytes / 4));
}

async function sourceBytes(dir: string): Promise<number> {
  let total = 0;
  for (const f of await fs.readdir(dir)) {
    if (f === 'truth.json') continue;
    try {
      const st = await fs.stat(path.join(dir, f));
      if (st.isFile()) total += st.size;
    } catch {   }
  }
  return total;
}

function normPath(p: string): string {
  return (p || '').replace(/\{([^}:]+)\}/g, ':$1').replace(/<(?:[^>:]+:)?([^>]+)>/g, ':$1');
}


async function klauroCorrelate(dir: string, truth: TelemetryTruth): Promise<{ correct: number; total: number; bytes: number; time_ms: number }> {
  const t0 = Date.now();
  const cas: any = await analyzeForBench(dir);
  let correct = 0;
  const answerLines: string[] = [];
  for (const tc of truth.events) {
    const r = correlateRuntimeEvent(cas, tc.event);
    if (tc.expect === 'unmatched') {
      if (r.status === 'unmatched') correct++;
      answerLines.push(`${tc.event.type} -> ${r.status}`);
      continue;
    }

    if (tc.expect_function) {


      const labels = [r.best_match, ...(r.matches || [])]
        .map((m: any) => String(m?.label || ''))
        .filter(Boolean);
      const ok = r.status !== 'unmatched' && labels.some(l => l.split(':').pop() === tc.expect_function);
      if (ok) correct++;
      answerLines.push(`error -> ${labels.join(',') || 'none'}`);
      continue;
    }



    if (tc.expect_exit) {
      const labels = [r.best_match, ...(r.matches || [])]
        .filter((m: any) => m?.type === 'exit_point')
        .map((m: any) => String(m?.label || ''));
      const want = normPath(tc.expect_exit);
      const ok = r.status !== 'unmatched' && labels.some(l => normPath(l).includes(want));
      if (ok) correct++;
      answerLines.push(`exit ${tc.event.endpoint || tc.event.target} -> ${labels.join(',') || 'none'}`);
      continue;
    }


    const bm: any = r.best_match;
    const route: any = (cas.route_table || []).find((rt: any) =>
      bm && (rt.source_node === bm.id || `${rt.method} ${rt.path}` === bm.name || normPath(rt.path) === normPath(tc.expect_path || '')));
    const method = (route?.method || bm?.trigger?.method || '').toUpperCase();
    const rpath = normPath(route?.path || bm?.trigger?.path || '');
    const ok = r.status !== 'unmatched' && method === (tc.expect_method || '').toUpperCase() && rpath === normPath(tc.expect_path || '');
    if (ok) correct++;
    answerLines.push(`${tc.event.method} ${tc.event.path} -> ${method} ${rpath}`);
  }
  return { correct, total: truth.events.length, bytes: Buffer.byteLength(answerLines.join('\n'), 'utf8'), time_ms: Date.now() - t0 };
}







async function klauroHotpath(dir: string, truth: TelemetryTruth): Promise<{ correct: number; total: number; bytes: number; time_ms: number }> {
  const t0 = Date.now();
  const cas: any = await analyzeForBench(dir);
  const observations = truth.events.map((tc, i) => ({
    id: `obs_${i}`,
    project_path: dir,
    recorded_at: '1970-01-01T00:00:00.000Z',
    event: { ...tc.event, timestamp: '1970-01-01T00:00:00.000Z' },
    correlation: correlateRuntimeEvent(cas, tc.event),
  }));
  const result: any = buildOperationalPriorities(cas, observations, { limit: 3 });
  const top: any = (result.priorities || [])[0];
  const topLabel = String(top?.static_target?.label || '');
  const correct = topLabel === (truth.expected_top || '') ? 1 : 0;
  const line = `top: ${topLabel || 'none'} (score=${top?.priority_score}, sev=${top?.severity}, errs=${top?.runtime?.errors})`;
  return { correct, total: 1, bytes: Buffer.byteLength(line, 'utf8'), time_ms: Date.now() - t0 };
}

export async function runTelemetryCorrelationBench(fixtureDir: string): Promise<TelemetryBenchResult> {
  const truth: TelemetryTruth = await fs.readJson(path.join(fixtureDir, 'truth.json'));
  const kl = truth.task === 'telemetry-hotpath'
    ? await klauroHotpath(fixtureDir, truth)
    : await klauroCorrelate(fixtureDir, truth);
  const srcBytes = await sourceBytes(fixtureDir);
  const klF1 = kl.total ? kl.correct / kl.total : 0;

  const arms: ArmResult[] = [
    {
      arm_id: 'klauro',
      mode: 'engine',
      attempted: true,
      metrics: { quality: Math.round(klF1 * 100), time_ms: kl.time_ms, tokens: toTokens(kl.bytes) },
      source: 'telemetry-bench:correlation',
    },
  ];
  const detail: TelemetryBenchResult['detail'] = [
    { arm: 'klauro', correct: kl.correct, total: kl.total, f1: klF1, bytes: kl.bytes, can_answer: true },
  ];




  for (const armId of ['codebase-memory', 'scip-typescript', 'stack-graphs', 'embeddings-nomic']) {
    arms.push({
      arm_id: armId,
      mode: 'engine',
      attempted: false,
      metrics: { quality: 0, time_ms: 1, tokens: toTokens(srcBytes) },
      source: `telemetry-bench:correlation:${armId}`,
    });
    detail.push({ arm: armId, correct: 0, total: kl.total, f1: 0, bytes: srcBytes, can_answer: false });
  }

  const verdict = validateWin(
    arms,
    'correlateRuntimeEvent fuses a live request/error/span to the exact static route or function it exercised; static indexers (embeddings, scip, stack-graphs, codebase-memory) have no runtime input and cannot correlate "how it is running" to the code at all.',
  );

  return { fixture: path.basename(fixtureDir), arms, verdict, detail };
}
