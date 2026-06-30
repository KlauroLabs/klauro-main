/**
 * Primitive head-to-head — Klauro vs the REAL structural tools on Camp-B's own
 * turf: "who calls X" (the complete caller set).
 *
 * This is the out-primitive proof. The task is a STRUCTURAL COMPLETENESS query:
 * find every caller of a target method. We run Klauro's call graph against the
 * actual installed tools (ripgrep, ast-grep) — not proxies — and score each by:
 *   - quality: F1 of the file set it surfaces vs the hand-curated true caller
 *     files (precision punishes false positives, recall punishes misses);
 *   - tokens:  the bytes the arm makes the agent READ to produce/verify the
 *     answer. Klauro returns the exact caller set (cheap); a grep/AST matcher
 *     returns candidate files the agent must open and read (expensive).
 *
 * Klauro wins by construction ONLY if its call graph is genuinely more correct:
 * it must type-resolve receivers (exclude same-name methods on other classes)
 * and follow aliased imports. Where it doesn't, the win-validator surfaces the
 * loss — that is the signal to deepen the analyzer, never to weaken a competitor.
 *
 * A truth fixture is a dir with .ts sources + truth.json:
 *   { "task": "callers", "target": "Account.save",
 *     "true_callers": ["persist","archive"], "true_files": ["service.ts","aliased.ts"] }
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { createOrchestrator } from '../analyzer';
import { analyzeWithInstalledKlauro } from '../installed-klauro';
import { validateWin } from './win-validator';
import { scipCallers, ctagsCallers, stackGraphsCallers } from './real-camp-arms';
import type { ArmResult, WinVerdict } from './report-schema';

/**
 * Produce the Klauro CAS for a fixture. By default this runs the in-process
 * engine. When KLAURO_BENCH_ANALYZER_URL is set, it instead runs the INSTALLED
 * CLI in remote mode against that hosted service — the literal customer product
 * (deep analysis on the server). The fixture is copied to a throwaway git repo
 * so the remote source-snapshot builder is satisfied and the checked-in fixture
 * is never mutated. The returned CAS has the same shape either way, so every
 * downstream metric is identical — only the analysis SOURCE changes.
 */
async function analyzeForBench(dir: string): Promise<any> {
  const url = process.env.KLAURO_BENCH_ANALYZER_URL;
  if (!url) return createOrchestrator().orchestrateAnalysis(dir);
  const tmp = path.join(os.tmpdir(), `klauro-bench-product-${process.pid}-${Math.random().toString(36).slice(2)}`);
  await fs.copy(dir, tmp, { filter: src => !/(^|\/)\.git(\/|$)/.test(src) });
  try {
    execFileSync('git', ['init', '-q'], { cwd: tmp });
    execFileSync('git', ['add', '-A'], { cwd: tmp });
    execFileSync('git', ['-c', 'user.email=bench@klauro', '-c', 'user.name=bench', 'commit', '-qm', 'bench fixture'], { cwd: tmp });
    const res = await analyzeWithInstalledKlauro(tmp, { mode: 'remote', serverUrl: url, timeoutMs: 8 * 60 * 1000 });
    return res.output;
  } finally {
    await fs.remove(tmp).catch(() => undefined);
  }
}

/** True when the Klauro arm is exercising the hosted product, not the in-process engine. */
export function benchProductMode(): boolean {
  return Boolean(process.env.KLAURO_BENCH_ANALYZER_URL);
}

interface CallersTruth {
  task: 'callers';
  /** ast-grep language id (ts, tsx, python, java, go, rust, c, cpp, csharp,
   *  kotlin, swift, ...). Defaults to 'ts'. The win must hold for EVERY one. */
  lang?: string;
  target: string;          // "ClassName.method"
  true_callers: string[];
  true_files: string[];
}

export interface PrimitiveBenchResult {
  fixture: string;
  target: string;
  arms: ArmResult[];
  verdict: WinVerdict;
  /** Per-arm detail for the UI / debugging. */
  detail: Array<{ arm: string; files: string[]; precision: number; recall: number; f1: number; bytes: number }>;
}

function score(produced: string[], truth: string[]): { precision: number; recall: number; f1: number } {
  const prod = [...new Set(produced)];
  const tp = prod.filter(f => truth.includes(f)).length;
  const precision = prod.length ? tp / prod.length : (truth.length ? 0 : 1);
  const recall = truth.length ? tp / truth.length : 1;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  return { precision, recall, f1 };
}

/** ~4 chars per token is the standard rough proxy. */
function toTokens(bytes: number): number {
  return Math.max(1, Math.round(bytes / 4));
}

async function sourceFiles(dir: string): Promise<string[]> {
  return (await fs.readdir(dir)).filter(f => f !== 'truth.json' && /\.[A-Za-z0-9]+$/.test(f));
}

/** Klauro: the call graph yields the EXACT caller set; the agent reads only that
 *  answer, not the files. */
async function klauroArm(dir: string, truth: CallersTruth): Promise<{ result: ArmResult; files: string[]; bytes: number }> {
  const [className, methodName] = truth.target.split('.');
  const t0 = Date.now();
  const cas: any = await analyzeForBench(dir);
  const time_ms = Date.now() - t0;
  const nodes: any[] = cas.nodes || [];
  const edges: any[] = cas.edges || [];

  // Find the exact target node: a method/function named `methodName` whose parent
  // is `className` — the class for OO languages, the MODULE for Elixir/functional
  // languages (where `Account.save` is a module function, node type `function`).
  const target = nodes.find(n => /method|function/.test(String(n.type)) && n.name === methodName && (() => {
    const parent = n.parent ? nodes.find(p => p.id === n.parent) : undefined;
    return parent?.name === className;
  })());

  const callerNodes = target
    ? edges.filter(e => /call|invoke/.test(String(e.type || '')) && (e.target || e.to) === target.id)
        .map(e => nodes.find(n => n.id === (e.source || e.from)))
        .filter(Boolean)
    : [];

  const files = [...new Set(callerNodes.map(n => path.basename(String(n.source?.file || ''))))];
  // The answer the agent consumes: "callerName  file:line" per caller — tiny.
  const answer = callerNodes.map(n => `${n.name} ${path.basename(String(n.source?.file || ''))}`).join('\n');
  const bytes = Buffer.byteLength(answer, 'utf8');

  const s = score(files, truth.true_files);
  return {
    files,
    bytes,
    result: {
      arm_id: 'klauro',
      mode: benchProductMode() ? 'product' : 'engine',
      attempted: true,
      metrics: { quality: Math.round(s.f1 * 100), tokens: toTokens(bytes), time_ms },
      source: benchProductMode() ? 'primitive-bench:callers:product' : 'primitive-bench:callers',
    },
  };
}

/** A real-tool retrieval arm: it surfaces candidate files; the agent must read
 *  them to find/verify callers, so its token cost is the bytes of those files. */
function toolArm(armId: string, dir: string, matchedFiles: string[], truth: CallersTruth, time_ms: number): { result: ArmResult; files: string[]; bytes: number } {
  const files = [...new Set(matchedFiles)];
  const bytes = files.reduce((a, f) => {
    try { return a + fs.statSync(path.join(dir, f)).size; } catch { return a; }
  }, 0);
  const s = score(files, truth.true_files);
  return {
    files,
    bytes,
    result: {
      arm_id: armId,
      mode: 'engine',
      // A retrieval tool that surfaced ZERO candidates did not perform the task
      // (e.g. ast-grep has no grammar for the language). Mark it un-attempted so
      // the win-validator doesn't count its trivial 0-byte cost as an efficiency
      // win — that absence is a Klauro COVERAGE win, mirroring scip-on-non-TS.
      attempted: files.length > 0,
      metrics: { quality: Math.round(s.f1 * 100), tokens: toTokens(bytes), time_ms },
      source: `primitive-bench:callers:${armId}`,
    },
  };
}

// --- Camp A: real semantic embeddings (nomic-embed-text via Ollama) ---------
// Models the Cursor/Augment/Roo recipe: embed code chunks, embed the query,
// rank by cosine, return top-k files. Reveals the structural-vs-semantic gap:
// embeddings retrieve "code about save", not "callers of save".
async function ollamaUp(): Promise<boolean> {
  try {
    const r = await fetch('http://localhost:11434/api/tags', { signal: AbortSignal.timeout(800) });
    return r.ok;
  } catch { return false; }
}

async function embed(text: string, model: string): Promise<number[] | null> {
  try {
    const r = await fetch('http://localhost:11434/api/embeddings', {
      method: 'POST',
      body: JSON.stringify({ model, prompt: text }),
      signal: AbortSignal.timeout(20000),
    });
    const j: any = await r.json();
    return Array.isArray(j?.embedding) ? j.embedding : null;
  } catch { return null; }
}

/** Every locally-pulled embedding model is a distinct Camp A competitor — the
 *  win must hold against ALL of them, not one. Returns model tags (nomic first). */
async function availableEmbedModels(): Promise<string[]> {
  try {
    const r = await fetch('http://localhost:11434/api/tags', { signal: AbortSignal.timeout(1500) });
    const j: any = await r.json();
    const names: string[] = (j?.models || [])
      .map((m: any) => String(m?.name || ''))
      .filter((n: string) => /embed|minilm/i.test(n));
    return names.sort((a, b) => (a.includes('nomic') ? -1 : 0) - (b.includes('nomic') ? -1 : 0));
  } catch { return []; }
}

/** Short, stable arm id for a model tag, e.g. 'nomic-embed-text:latest' -> 'embeddings-nomic'. */
export function embedArmId(model: string): string {
  const base = model.split(':')[0];
  if (base.includes('nomic')) return 'embeddings-nomic';
  return `embeddings-${base}`;
}

function cosine(a: number[], b: number[]): number {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return d / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

async function embedCallers(dir: string, files: string[], target: string, k: number, model: string): Promise<{ files: string[]; ms: number } | null> {
  const t0 = Date.now();
  const qv = await embed(`functions that call ${target}`, model);
  if (!qv) return null;
  const scored: Array<{ file: string; score: number }> = [];
  for (const f of files) {
    let content = '';
    try { content = await fs.readFile(path.join(dir, f), 'utf8'); } catch { continue; }
    const v = await embed(content, model);
    if (v) scored.push({ file: f, score: cosine(qv, v) });
  }
  scored.sort((a, b) => b.score - a.score);
  return { files: scored.slice(0, k).map(s => s.file), ms: Date.now() - t0 };
}

function ripgrepCallers(dir: string, methodName: string): { files: string[]; ms: number } {
  const t0 = Date.now();
  let out = '';
  try {
    // Exclude non-code metadata (e.g. the fixture's own truth.json) so the
    // competitor is judged on real source matches, not the test scaffold.
    // Match both `.method(` and `->method(` so PHP/others aren't shortchanged.
    out = execFileSync('rg', ['-l', '-g', '!*.json', `(\\.|->)\\s*${methodName}\\s*\\(`, dir], { encoding: 'utf8' });
  } catch { /* rg exits non-zero on no match */ }
  const files = out.split('\n').filter(Boolean).map(f => path.basename(f));
  return { files, ms: Date.now() - t0 };
}

function astGrepCallers(dir: string, methodName: string, lang: string): { files: string[]; ms: number } {
  const t0 = Date.now();
  const files = new Set<string>();
  // Run ast-grep at full strength: arg-form varies by language (Go's zero-arg
  // `a.Save()` needs `()` not `$$$`), so union both so the competitor isn't
  // handicapped by a pattern mismatch.
  // `.` for most langs, `->` only for languages where that operator is valid.
  // Keeping invalid syntax out of the competitor path avoids parser diagnostics
  // while still giving ast-grep every sensible access form for the fixture.
  const patterns = [`$X.${methodName}($$$)`, `$X.${methodName}()`];
  if (['php', 'cpp', 'c'].includes(lang)) {
    patterns.push(`$X->${methodName}($$$)`, `$X->${methodName}()`);
  }
  for (const pat of patterns) {
    try {
      const out = execFileSync('ast-grep', ['run', '-p', pat, '-l', lang, dir], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      for (const l of out.split('\n')) {
        if (/\.[A-Za-z0-9]+:\d+/.test(l)) files.add(path.basename(l.split(':')[0]));
      }
    } catch { /* no match for this pattern */ }
  }
  return { files: [...files], ms: Date.now() - t0 };
}

export interface RunCallersBenchOptions {
  /**
   * Include the heavy, really-installed Camp-B arms (scip-typescript — compiler-
   * accurate; ctags — name-based). Off by default so the unit suite stays fast;
   * the dedicated camp-comparison proof opts in. scip ties Klauro at the quality
   * ceiling on TS who-calls (you cannot out-correct a compiler), so the win there
   * is carried by tokens — exactly the validator's tie-at-ceiling path.
   */
  heavyArms?: boolean;
}

/** Run the callers head-to-head on one truth fixture. */
export async function runCallersBench(
  fixtureDir: string,
  options: RunCallersBenchOptions = {},
): Promise<PrimitiveBenchResult> {
  const truth: CallersTruth = await fs.readJson(path.join(fixtureDir, 'truth.json'));
  const methodName = truth.target.split('.').pop()!;
  const className = truth.target.split('.')[0];
  const lang = truth.lang || 'ts';
  await sourceFiles(fixtureDir);

  const klauro = await klauroArm(fixtureDir, truth);
  const rg = ripgrepCallers(fixtureDir, methodName);
  const sg = astGrepCallers(fixtureDir, methodName, lang);
  const ripgrep = toolArm('ripgrep', fixtureDir, rg.files, truth, rg.ms);
  const astgrep = toolArm('ast-grep', fixtureDir, sg.files, truth, sg.ms);

  const arms = [klauro.result, ripgrep.result, astgrep.result];
  const detail = [
    { arm: 'klauro', files: klauro.files, ...score(klauro.files, truth.true_files), bytes: klauro.bytes },
    { arm: 'ripgrep', files: ripgrep.files, ...score(ripgrep.files, truth.true_files), bytes: ripgrep.bytes },
    { arm: 'ast-grep', files: astgrep.files, ...score(astgrep.files, truth.true_files), bytes: astgrep.bytes },
  ];

  // Camp A: every locally-pulled embedding model is its own competitor, judged at
  // strength (top-k = answer cardinality). The win must hold against ALL of them
  // — nomic, all-minilm, mxbai, etc. — not a single model.
  if (await ollamaUp()) {
    const srcFiles = await sourceFiles(fixtureDir);
    const k = Math.max(2, truth.true_files.length);
    const seen = new Set<string>();
    // Default suite: just the primary model (fast). Heavy bench: the full panel.
    const allModels = await availableEmbedModels();
    const models = options.heavyArms ? allModels : allModels.slice(0, 1);
    for (const model of models) {
      const armId = embedArmId(model);
      if (seen.has(armId)) continue;
      seen.add(armId);
      const em = await embedCallers(fixtureDir, srcFiles, truth.target, k, model);
      if (!em) continue;
      const emb = toolArm(armId, fixtureDir, em.files, truth, em.ms);
      arms.push(emb.result);
      detail.push({ arm: armId, files: emb.files, ...score(emb.files, truth.true_files), bytes: emb.bytes });
    }
  }

  // Heavy, really-installed Camp-B arms. scip-typescript only indexes TS/JS, so
  // on every other language it returns null — that absence IS the decisive,
  // honest coverage win (Klauro answers; the compiler-accurate tool cannot run).
  if (options.heavyArms) {
    const scip = scipCallers(fixtureDir, className, methodName);
    if (scip) {
      const a = toolArm('scip-typescript', fixtureDir, scip.files, truth, scip.ms);
      arms.push(a.result);
      detail.push({ arm: 'scip-typescript', files: a.files, ...score(a.files, truth.true_files), bytes: a.bytes });
    }
    const ct = ctagsCallers(fixtureDir, methodName);
    if (ct) {
      const a = toolArm('ctags', fixtureDir, ct.files, truth, ct.ms);
      arms.push(a.result);
      detail.push({ arm: 'ctags', files: a.files, ...score(a.files, truth.true_files), bytes: a.bytes });
    }
    const sg = stackGraphsCallers(fixtureDir, className, methodName);
    if (sg) {
      const a = toolArm('stack-graphs', fixtureDir, sg.files, truth, sg.ms);
      arms.push(a.result);
      detail.push({ arm: 'stack-graphs', files: a.files, ...score(a.files, truth.true_files), bytes: a.bytes });
    }
  }

  const verdict = validateWin(
    arms,
    'get_callers type-resolves the exact caller set (alias-aware, decoy-excluding); grep/AST match by name, scip is compiler-accurate (ties at the ceiling but costs tokens), and embeddings retrieve "code about X" not "callers of X".'
  );

  return { fixture: path.basename(fixtureDir), target: truth.target, arms, verdict, detail };
}
