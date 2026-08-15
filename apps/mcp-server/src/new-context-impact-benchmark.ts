





























import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs-extra';
import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import { analyzeForBench } from './gauntlet/product-analysis';
import { buildOperationalPriorities } from './product';
import { ingestTelemetryBatch, loadTelemetryObservations, type TelemetryEvent } from './telemetry-ingestion';





const AZURE_ENDPOINT =
  process.env.KLAURO_BENCH_CHAT_URL ||
  'https://soon-ai-resource.openai.azure.com/openai/v1/chat/completions';
const AZURE_MODEL = process.env.KLAURO_BENCH_CHAT_MODEL || 'gpt-5.5';

interface ChatResult {
  text: string;
  total_tokens: number;
}

async function askModel(system: string, user: string): Promise<ChatResult> {
  const apiKey = process.env.AZURE_OPENAI_API_KEY;
  if (!apiKey) throw new Error('AZURE_OPENAI_API_KEY not set — this benchmark is metered and requires it.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 300_000);
  try {
    const res = await fetch(AZURE_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: AZURE_MODEL,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`chat failed (${res.status}): ${body.slice(0, 400)}`);
    }
    const json: any = await res.json();
    const text: string = json?.choices?.[0]?.message?.content ?? '';
    const total: number = Number(json?.usage?.total_tokens ?? 0);
    return { text: String(text), total_tokens: total };
  } finally {
    clearTimeout(timer);
  }
}





const SYSTEM_PROMPT =
  'You are a senior engineer answering a precise question about a codebase. ' +
  'Answer in at most 2 sentences. Be concrete: name the modality/route/dependency/' +
  'consistency posture asked for. Do not hedge or list options — commit to one answer.';

function includesAny(text: string, needles: string[]): boolean {
  const hay = text.toLowerCase();
  return needles.some(n => hay.includes(n.toLowerCase()));
}


const MODALITY_FORMS: Record<string, RegExp> = {
  sync: /\bsync(?:hronous(?:ly)?)?\b/,
  async: /\basync(?:hronous(?:ly)?)?\b/,
  passive: /\bpassive(?:ly)?\b|\bshared[- ]state\b/,
};



function claimsModality(text: string, mod: string): boolean {
  const stripped = text.toLowerCase().replace(/\b(sync|async|passive)\s*[:=]\s*\d+/g, ' ');
  return MODALITY_FORMS[mod].test(stripped);
}

function refuses(text: string): boolean {
  return /cannot (?:determine|be determined)|can'?t (?:determine|be determined)|not determinable|(?:is|are) unknown|not (?:enough|present|available|determinable)|requires? (?:production|apm|telemetry|log)|no (?:telemetry|apm|data)|insufficient|unable to|not derivable/i.test(text);
}

interface Question {
  id: string;
  section: 'communication_seams' | 'node_metrics' | 'runtime_topology' | 'consistency_model';
  prompt: string;

  withContext: string;

  grade: (answer: string) => boolean;

  groundTruth: string;
}

interface ArmResult {
  answer: string;
  tokens: number;
  correct: boolean;
}
interface QuestionResult {
  id: string;
  section: string;
  ground_truth: string;
  with_context: ArmResult;
  baseline: ArmResult;
  note?: string;
}







function baselineSurface(cas: CASOutput): string {
  const routes = (cas.route_table || []).slice(0, 40)
    .map((r: any) => `${r.method || '?'} ${r.path || r.route || '?'} -> ${r.handler || r.handler_node || '?'}`);
  const entries = (cas.entry_points || []).slice(0, 25)
    .map((e: any) => `${e.type}:${e.name}`);
  const exits = (cas.exit_points || []).slice(0, 30)
    .map((x: any) => `${x.type}:${x.target || x.name || x.id}`);
  const files = Array.from(new Set((cas.nodes || [])
    .map((n: any) => n.source?.file).filter(Boolean))).slice(0, 60);
  return [
    'You have grep/read access only. Here is what a quick scan of the repo surfaces:',
    `Routes:\n${routes.join('\n') || '(none)'}`,
    `Entry points:\n${entries.join(', ') || '(none)'}`,
    `Exit points (outbound calls):\n${exits.join('\n') || '(none)'}`,
    `Files (sample):\n${files.join('\n')}`,
  ].join('\n\n');
}






function buildSeamQuestion(cas: any): Question | null {
  const inv = cas.communication_seams?.inventory;
  const comp = inv?.component_seams as any[] | undefined;
  if (!comp?.length) return null;

  const top = [...comp].sort((a, b) => b.total - a.total)[0];
  const dominant: 'sync' | 'async' | 'passive' =
    top.sync >= top.async && top.sync >= top.passive ? 'sync' :
    top.async >= top.passive ? 'async' : 'passive';

  const asyncSeam = cas.communication_seams.seams.find((s: any) => s.modality === 'async');
  const target = String(top.target);
  const source = String(top.source);
  const seamLines = (cas.communication_seams.seams as any[]).slice(0, 30)
    .map(s => `${s.source} --${s.modality}--> ${s.target} (${s.kind})`);
  return {
    id: 'seam-modality',
    section: 'communication_seams',
    prompt: `Does the component "${source}" talk to "${target}", and is that communication synchronous, asynchronous, or passive (shared state)?`,
    withContext: [
      'Klauro communication_seams (each seam tagged sync/async/passive with the driving fact):',
      `Inventory counts: ${JSON.stringify(inv.counts)}`,
      `Busiest component seams:\n${comp.slice(0, 8).map((c: any) => `${c.source} -> ${c.target}: sync=${c.sync} async=${c.async} passive=${c.passive} (total ${c.total})`).join('\n')}`,
      `Individual seams (sample):\n${seamLines.join('\n')}`,
      asyncSeam ? `Note an async seam exists: ${asyncSeam.summary}` : '',
    ].filter(Boolean).join('\n\n'),
    groundTruth: `${source} -> ${target} is dominantly ${dominant} (sync=${top.sync} async=${top.async} passive=${top.passive}).`,


    grade: ans => {
      const namesTarget = includesAny(ans, [target, target.split('/').pop() || target]);
      const saysRight = claimsModality(ans, dominant);
      const wrongMods = (['sync', 'async', 'passive'] as const).filter(m => m !== dominant);
      const saysWrong = wrongMods.some(m => claimsModality(ans, m));
      return namesTarget && saysRight && !saysWrong;
    },
  };
}

function buildConsistencyQuestion(cas: any): Question | null {
  const cons = cas.consistency_model;
  const passive = cons?.passive_seams as any[] | undefined;
  const stores = cons?.store_consistency as any[] | undefined;

  const stale = (passive || []).find((s: any) => s.consistency?.staleness_risk)
    || (stores || []).find((s: any) => s.consistency?.staleness_risk);
  if (!stale) return null;
  const resource = stale.shared_resource || stale.store || stale.target || 'the data store';
  const model = stale.consistency?.model || 'eventual';
  return {
    id: 'consistency-staleness',
    section: 'consistency_model',
    prompt: `A read comes from "${resource}". Is that read strongly consistent, or is it eventually consistent (i.e. carries a staleness risk)?`,
    withContext: [
      'Klauro consistency_model (data-store egress + passive seams tagged with a consistency posture):',
      `counts: ${JSON.stringify(cons.counts)}`,
      `Relevant posture: resource=${resource} model=${model} staleness_risk=${stale.consistency?.staleness_risk} cap_lean=${stale.consistency?.cap_lean} evidence="${stale.consistency?.evidence}"`,
    ].join('\n\n'),
    groundTruth: `${resource} is ${model} with staleness_risk=true (evidence: ${stale.consistency?.evidence}).`,



    grade: ans => {
      const saysEventual = includesAny(ans, ['eventual', 'stale', 'staleness']);
      const strongClaim = /(not|isn't|never|n't)[^.]{0,12}(strongly consistent|strong consistency)/i.test(ans)
        ? false
        : /(strongly consistent|strong consistency)/i.test(ans);
      const assertsFresh = /\bno staleness\b|\bnot stale\b/i.test(ans);
      return saysEventual && !strongClaim && !assertsFresh;
    },
  };
}

function buildTopologyQuestion(cas: any): Question | null {
  const topo = cas.product_map?.runtime_topology || cas.runtime_topology;
  const deployables = topo?.deployables as any[] | undefined;
  const withDeps = (deployables || []).find((d: any) => d.depends_on?.length);
  if (!withDeps) return null;
  const dep = withDeps.name;
  const deps = withDeps.depends_on;
  return {
    id: 'topology-depends-on',
    section: 'runtime_topology',
    prompt: `At runtime, what peer deployable(s) does "${dep}" depend on?`,
    withContext: [
      'Klauro runtime_topology (infra->code edges: DEPLOYS/EXPOSES/RUNTIME_DEPENDS_ON):',
      `Deployable ${dep}: depends_on=${JSON.stringify(deps)} exposes=${JSON.stringify(withDeps.exposes)} databases=${JSON.stringify(withDeps.databases)}`,
    ].join('\n\n'),
    groundTruth: `${dep} depends_on ${JSON.stringify(deps)} at runtime.`,
    grade: ans => includesAny(ans, deps.map((d: string) => d.split(/[:/]/).pop() || d)),
  };
}

async function buildTelemetryQuestion(cas: any, projectPath: string, storageDir: string): Promise<{ q: Question; cleanup: () => void } | null> {



  const routes = (cas.route_table || []) as any[];
  const entries = (cas.entry_points || []) as any[];
  const httpEntries = entries.filter(e => e.trigger?.path || e.trigger?.method);
  const pick = (arr: any[], i: number) => arr[i % Math.max(1, arr.length)];
  const sourceRoutes = routes.length >= 2 ? routes : httpEntries;
  if (sourceRoutes.length < 2) return null;
  const hot = pick(sourceRoutes, 0);
  const cool = pick(sourceRoutes, 1);
  const hotMethod = (hot.method || hot.trigger?.method || 'GET').toUpperCase();
  const hotPath = hot.path || hot.trigger?.path || hot.route || '/';
  const hotFile = hot.file || hot.handler_file || hot.source?.file || (cas.nodes?.[0]?.source?.file) || 'src/index.ts';
  const coolMethod = (cool.method || cool.trigger?.method || 'GET').toUpperCase();
  const coolPath = cool.path || cool.trigger?.path || cool.route || '/other';
  const coolFile = cool.file || cool.handler_file || cool.source?.file || hotFile;
  const now = Date.now();
  const events: TelemetryEvent[] = [];

  for (let i = 0; i < 10; i++) {
    events.push({
      kind: 'error', timestamp: new Date(now - i * 12_000).toISOString(),
      method: hotMethod, route: hotPath, status: 500, duration_ms: 1400 + i * 30,
      trace_id: `t-hot-${i}`, span_id: `s-hot-${i}`, file_hint: hotFile, volume: 200,
      error: { type: 'HotRouteError', message: 'hot route failing', stack_top_frames: [{ file: hotFile, line: 1 }] as any },
    });
  }

  for (let i = 0; i < 3; i++) {
    events.push({
      kind: 'request', timestamp: new Date(now - i * 20_000).toISOString(),
      method: coolMethod, route: coolPath, status: 200, duration_ms: 40 + i * 5,
      trace_id: `t-cool-${i}`, span_id: `s-cool-${i}`, file_hint: coolFile, volume: 10,
    });
  }
  const prevStorage = process.env.KLAURO_STORAGE_PATH;
  process.env.KLAURO_STORAGE_PATH = storageDir;
  await ingestTelemetryBatch(cas, projectPath, events, { persist: true });
  const stored = await loadTelemetryObservations(projectPath, { source: 'ingested', limit: 5000 });
  const priorities = buildOperationalPriorities(cas, stored.observations, { limit: 5 });
  const top = priorities.priorities[0];
  const cleanup = () => {
    if (prevStorage === undefined) delete process.env.KLAURO_STORAGE_PATH;
    else process.env.KLAURO_STORAGE_PATH = prevStorage;
  };
  if (!top) { cleanup(); return null; }
  const topLatency = top.runtime.latency?.p95_ms;
  const topLabel = top.static_target?.file || top.title;
  const q: Question = {
    id: 'telemetry-hotspot',
    section: 'node_metrics',
    prompt: `Given production telemetry, which route is the busiest / most error-prone hotspot, and roughly what is its p95 latency? (${hotMethod} ${hotPath} vs ${coolMethod} ${coolPath})`,
    withContext: [
      'Klauro node_metrics / operational_priorities (telemetry correlated to CAS nodes):',
      `Top priority: ${top.title} | severity=${top.severity} | errors=${top.runtime.errors} | est_volume=${top.runtime.estimated_volume} | p95=${topLatency ?? 'n/a'}ms | file=${top.static_target?.file || 'n/a'}`,
      `Runner-up priorities: ${priorities.priorities.slice(1, 3).map(p => `${p.title} (errors=${p.runtime.errors})`).join('; ') || '(none)'}`,
    ].join('\n\n'),
    groundTruth: `Hotspot = ${topLabel} (${hotMethod} ${hotPath}), errors=${top.runtime.errors}, p95=${topLatency ?? 'n/a'}ms.`,




    grade: ans => !refuses(ans) &&
      includesAny(ans, [hotPath, hotPath.split('/').filter(Boolean).pop() || hotPath, hotMethod]) &&
      includesAny(ans, ['error', 'busiest', 'hotspot', 'most', '500', 'p95']),
  };
  return { q, cleanup };
}





async function runArm(section: string, prompt: string, contextBlock: string): Promise<ArmResult> {
  const user = `${contextBlock}\n\nQuestion: ${prompt}`;


  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await askModel(SYSTEM_PROMPT, user);
      return { answer: res.text.trim(), tokens: res.total_tokens, correct: false };
    } catch (err) {
      if (attempt === 1) {
        return { answer: `[model call failed: ${err instanceof Error ? err.message : String(err)}]`, tokens: 0, correct: false };
      }
    }
  }
  return { answer: '[model call failed]', tokens: 0, correct: false };
}

export interface NewContextImpactReport {
  generated_at: string;
  model: string;
  sample_note: string;
  repos: Array<{
    repo: string;
    questions: QuestionResult[];
  }>;
  totals: {
    questions: number;
    with_context_tokens: number;
    baseline_tokens: number;
    with_context_correct: number;
    baseline_correct: number;
  };
  section_rollup: Record<string, { n: number; wc_tokens: number; bl_tokens: number; wc_correct: number; bl_correct: number }>;
}

export async function runNewContextImpactBenchmark(repoPaths: string[]): Promise<NewContextImpactReport> {
  const report: NewContextImpactReport = {
    generated_at: new Date().toISOString(),
    model: AZURE_MODEL,
    sample_note: 'Directional metered sample. Small N (a few grounded questions per repo). Reusable like the token-grid; re-run to grow N.',
    repos: [],
    totals: { questions: 0, with_context_tokens: 0, baseline_tokens: 0, with_context_correct: 0, baseline_correct: 0 },
    section_rollup: {},
  };

  for (const repoPath of repoPaths) {
    const cas: any = await analyzeForBench(repoPath);
    const baseCtx = baselineSurface(cas);
    const questions: Question[] = [];
    const cleanups: Array<() => void> = [];

    const seam = buildSeamQuestion(cas);
    if (seam) questions.push(seam);
    const cons = buildConsistencyQuestion(cas);
    if (cons) questions.push(cons);
    const topo = buildTopologyQuestion(cas);
    if (topo) questions.push(topo);

    const storageDir = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-nci-storage-'));
    const tel = await buildTelemetryQuestion(cas, repoPath, storageDir);
    if (tel) { questions.push(tel.q); cleanups.push(tel.cleanup); }
    cleanups.push(() => fs.remove(storageDir).catch(() => {}));

    const repoResults: QuestionResult[] = [];
    for (const q of questions) {
      const wc = await runArm(q.section, q.prompt, q.withContext);
      wc.correct = q.grade(wc.answer);
      const bl = await runArm(q.section, q.prompt, baseCtx);
      bl.correct = q.grade(bl.answer);

      repoResults.push({
        id: q.id,
        section: q.section,
        ground_truth: q.groundTruth,
        with_context: wc,
        baseline: bl,
      });

      report.totals.questions += 1;
      report.totals.with_context_tokens += wc.tokens;
      report.totals.baseline_tokens += bl.tokens;
      report.totals.with_context_correct += wc.correct ? 1 : 0;
      report.totals.baseline_correct += bl.correct ? 1 : 0;
      const roll = report.section_rollup[q.section] || { n: 0, wc_tokens: 0, bl_tokens: 0, wc_correct: 0, bl_correct: 0 };
      roll.n += 1; roll.wc_tokens += wc.tokens; roll.bl_tokens += bl.tokens;
      roll.wc_correct += wc.correct ? 1 : 0; roll.bl_correct += bl.correct ? 1 : 0;
      report.section_rollup[q.section] = roll;
    }


    const present = new Set(questions.map(q => q.section));
    const missing = (['communication_seams', 'node_metrics', 'runtime_topology', 'consistency_model'] as const)
      .filter(s => !present.has(s));
    if (missing.length) {
      repoResults.push({
        id: 'skipped-sections', section: missing.join(','),
        ground_truth: `No facts on this repo for: ${missing.join(', ')} — not measurable here (honest skip).`,
        with_context: { answer: '', tokens: 0, correct: false },
        baseline: { answer: '', tokens: 0, correct: false },
        note: 'section produced no facts on this repo',
      });
    }

    report.repos.push({ repo: path.basename(repoPath), questions: repoResults });
    for (const c of cleanups) c();
  }
  return report;
}

function renderTable(report: NewContextImpactReport): string {
  const lines: string[] = [];
  lines.push('# New-Context Impact Benchmark (metered, directional)');
  lines.push('');
  lines.push(`Model: ${report.model}  |  Generated: ${report.generated_at}`);
  lines.push(`Note: ${report.sample_note}`);
  lines.push('');
  for (const repo of report.repos) {
    lines.push(`## ${repo.repo}`);
    lines.push('');
    lines.push('| Question | Section | WC tok | BL tok | Δtok | WC ✓ | BL ✓ |');
    lines.push('|---|---|--:|--:|--:|:--:|:--:|');
    for (const q of repo.questions) {
      if (q.note) { lines.push(`| _${q.id}_ | ${q.section} | — | — | — | — | — |`); continue; }
      const dt = q.with_context.tokens - q.baseline.tokens;
      lines.push(`| ${q.id} | ${q.section} | ${q.with_context.tokens} | ${q.baseline.tokens} | ${dt >= 0 ? '+' : ''}${dt} | ${q.with_context.correct ? '✓' : '✗'} | ${q.baseline.correct ? '✓' : '✗'} |`);
    }
    lines.push('');
    for (const q of repo.questions) {
      lines.push(`- **${q.id}** (${q.section}) — ground truth: ${q.ground_truth}`);
      if (!q.note) {
        lines.push(`  - with-context (${q.with_context.tokens} tok, ${q.with_context.correct ? 'CORRECT' : 'WRONG'}): ${q.with_context.answer.replace(/\s+/g, ' ').slice(0, 240)}`);
        lines.push(`  - baseline (${q.baseline.tokens} tok, ${q.baseline.correct ? 'CORRECT' : 'WRONG'}): ${q.baseline.answer.replace(/\s+/g, ' ').slice(0, 240)}`);
      }
    }
    lines.push('');
  }
  lines.push('## Section rollup');
  lines.push('');
  lines.push('| Section | N | WC tok | BL tok | tok saved | WC correct | BL correct |');
  lines.push('|---|--:|--:|--:|--:|--:|--:|');
  for (const [sec, r] of Object.entries(report.section_rollup)) {
    lines.push(`| ${sec} | ${r.n} | ${r.wc_tokens} | ${r.bl_tokens} | ${r.bl_tokens - r.wc_tokens} | ${r.wc_correct}/${r.n} | ${r.bl_correct}/${r.n} |`);
  }
  lines.push('');
  const t = report.totals;
  lines.push('## Totals');
  lines.push('');
  lines.push(`- Questions: ${t.questions}`);
  lines.push(`- Tokens: with-context ${t.with_context_tokens} vs baseline ${t.baseline_tokens} (Δ ${t.with_context_tokens - t.baseline_tokens}, ${t.baseline_tokens ? Math.round(((t.baseline_tokens - t.with_context_tokens) / t.baseline_tokens) * 100) : 0}% ${t.with_context_tokens <= t.baseline_tokens ? 'saved' : 'MORE'} with context)`);
  lines.push(`- Correctness: with-context ${t.with_context_correct}/${t.questions} vs baseline ${t.baseline_correct}/${t.questions}`);
  return lines.join('\n');
}

if (require.main === module) {


  const argv = process.argv.slice(2);
  const flagsWithValue = new Set(['--json']);
  const repoArgs: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { if (flagsWithValue.has(a)) i++; continue; }
    repoArgs.push(a);
  }
  const repos = repoArgs.length ? repoArgs : ['/Users/michaelshattuck/dev/zerac/zerac-api'];
  runNewContextImpactBenchmark(repos)
    .then(report => {
      const table = renderTable(report);
      process.stdout.write(`\n${table}\n\n`);
      const out = process.argv.includes('--json') ? process.argv[process.argv.indexOf('--json') + 1] : '';
      if (out) fs.outputJsonSync(out, report, { spaces: 2 });
    })
    .catch(err => { process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`); process.exitCode = 1; });
}
