






















import { execFileSync } from 'child_process';
import * as fs from 'fs-extra';
import * as path from 'path';
import { validateWin } from './win-validator';
import { scipCallers, ctagsCallers, stackGraphsCallers } from './real-camp-arms';
import { analyzeForBench, benchProductMode } from './product-analysis';
import type { ArmResult, WinVerdict } from './report-schema';

export { benchProductMode };

interface CallersTruth {
  task: 'callers';


  lang?: string;
  target: string;
  true_callers: string[];
  true_files: string[];
}

export interface PrimitiveBenchResult {
  fixture: string;
  target: string;
  arms: ArmResult[];
  verdict: WinVerdict;

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


function toTokens(bytes: number): number {
  return Math.max(1, Math.round(bytes / 4));
}

async function sourceFiles(dir: string): Promise<string[]> {
  return (await fs.readdir(dir)).filter(f => f !== 'truth.json' && /\.[A-Za-z0-9]+$/.test(f));
}



async function klauroArm(dir: string, truth: CallersTruth): Promise<{ result: ArmResult; files: string[]; bytes: number }> {
  const [className, methodName] = truth.target.split('.');
  const t0 = Date.now();
  const cas: any = await analyzeForBench(dir);
  const time_ms = Date.now() - t0;
  const nodes: any[] = cas.nodes || [];
  const edges: any[] = cas.edges || [];




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




      attempted: files.length > 0,
      metrics: { quality: Math.round(s.f1 * 100), tokens: toTokens(bytes), time_ms },
      source: `primitive-bench:callers:${armId}`,
    },
  };
}





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



    out = execFileSync('rg', ['-l', '-g', '!*.json', `(\\.|->)\\s*${methodName}\\s*\\(`, dir], { encoding: 'utf8' });
  } catch {   }
  const files = out.split('\n').filter(Boolean).map(f => path.basename(f));
  return { files, ms: Date.now() - t0 };
}

function astGrepCallers(dir: string, methodName: string, lang: string): { files: string[]; ms: number } {
  const t0 = Date.now();
  const files = new Set<string>();






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
    } catch {   }
  }
  return { files: [...files], ms: Date.now() - t0 };
}

export interface RunCallersBenchOptions {







  heavyArms?: boolean;
}


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




  if (await ollamaUp()) {
    const srcFiles = await sourceFiles(fixtureDir);
    const k = Math.max(2, truth.true_files.length);
    const seen = new Set<string>();

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
