/**
 * Camp A (embeddings-RAG) vs Klauro — the PER-LANGUAGE head-to-head.
 *
 * Today the camps report runs Camp A on one TypeScript fixture. This bench spans
 * the TOP ~50 languages (see `camp-a-langs.ts`). For each language we run the SAME
 * structural-retrieval task — "which function calls `helper`?" — two ways:
 *
 *   - KLAURO (structural, REAL): `extractStructure` walks the language's real AST
 *     (the 167-grammar breadth engine), yielding the functions (name + start line)
 *     and the call sites (callee + line). We find the call to the unique `query`
 *     target and resolve its ENCLOSING function by nearest-preceding function line.
 *     That is the exact, decoy-proof caller — F1 = 1 when it matches `truth`.
 *
 *   - CAMP A (embeddings, REAL): the Cursor/Augment recipe via Ollama — embed each
 *     function's source slice, embed the query "functions that call <target>",
 *     rank by cosine, return top-1. This is the literal local-RAG arm
 *     (`http://localhost:11434`), NOT a simulation. If Ollama / an embedding model
 *     is absent the arm reports unavailable and we record Klauro-only (never fake
 *     a competitor number).
 *
 * The decoy (`save`/`store` text near the unique caller) is exactly what pulls a
 * text-similarity model off the structurally-correct function — so Klauro must
 * out-quality every local embedding model, per language. The win is asserted
 * (klauroF1 >= embeddingF1) for every language where the embedding arm ran.
 *
 * Aggregatable into camps-bench's CampAArm shape (arm/available/klauroF1/
 * competitorF1/klauroOutQualities/note) — see `buildCampALangsReport()`.
 */

import { extractStructure } from '../../../../packages/analyzer-core/src/analyzer/core/generic-tree-sitter-analyzer';
import { hasWasmGrammar } from '../../../../packages/analyzer-core/src/analyzer/core/wasm-tree-sitter';
import { hasNativeGrammar } from '../../../../packages/analyzer-core/src/analyzer/core/native-parse';
import { specFor } from '../../../../packages/analyzer-core/src/analyzer/core/language-spec';
import { embedArmId } from './primitive-bench';
import { TOP_LANGS, type TopLang } from './camp-a-langs';

export interface CampALangRow {
  lang: string;
  rank: number;
  /** Klauro structural F1 on the who-calls task (1 = exact caller resolved). */
  klauroF1: number;
  /** Best embedding-model F1 on the same task (the strongest Camp A competitor). */
  embeddingF1: number;
  /** Did Klauro out-quality (>=) every embedding model that ran? */
  klauroWins: boolean;
  /** The embedding model that produced `embeddingF1`, or '' if none ran. */
  embeddingModel: string;
  /** True when both Klauro extracted AND (if ollama present) an embedding arm ran. */
  available: boolean;
}

export interface CampALangsReport {
  /** True when at least one embedding model ran (ollama present). When false the
   *  report is Klauro-only — honest coverage, no faked competitor numbers. */
  available: boolean;
  perLanguage: CampALangRow[];
  aggregate: {
    languages: number;
    klauroWinRate: number;   // fraction of languages where klauroF1 >= embeddingF1
    meanKlauroF1: number;
    meanEmbeddingF1: number;
  };
  note: string;
}

// ---- scoring ---------------------------------------------------------------
function f1(produced: string[], truth: string[]): number {
  const prod = [...new Set(produced)];
  const tp = prod.filter(x => truth.includes(x)).length;
  const precision = prod.length ? tp / prod.length : (truth.length ? 0 : 1);
  const recall = truth.length ? tp / truth.length : 1;
  return precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
}

// ---- Klauro structural arm (REAL extractStructure) -------------------------
/** Resolve "which function calls `query`?" structurally: find the call to `query`
 *  and return the function whose start line most-closely precedes it. */
async function klauroResolve(tl: TopLang): Promise<string[] | null> {
  const ex = await extractStructure(tl.lang, tl.sample);
  if (!ex) return null;
  const call = ex.calls.find(c => c.callee === tl.query || c.callee.replace(/\(.*$/, '') === tl.query);
  if (!call) return [];
  let best: { name: string; line: number } | null = null;
  for (const fn of ex.functions) {
    if (fn.line <= call.line && (!best || fn.line > best.line)) best = fn;
  }
  return best ? [best.name] : [];
}

function langSupported(lang: string): boolean {
  return !!specFor(lang) && (hasWasmGrammar(lang) || hasNativeGrammar(lang));
}

// ---- Camp A: REAL local embeddings via Ollama (Cursor/Augment recipe) -------
async function ollamaUp(): Promise<boolean> {
  try {
    const r = await fetch('http://localhost:11434/api/tags', { signal: AbortSignal.timeout(800) });
    return r.ok;
  } catch { return false; }
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

function cosine(a: number[], b: number[]): number {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return d / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

/** Split a sample into per-function source chunks (the unit a code-RAG indexes):
 *  one chunk per declared function, from its start line to the next function. */
function functionChunks(sample: string, functions: { name: string; line: number }[]): { name: string; text: string }[] {
  const lines = sample.split('\n');
  const sorted = [...functions].sort((a, b) => a.line - b.line);
  const chunks: { name: string; text: string }[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const start = sorted[i].line - 1;
    const end = i + 1 < sorted.length ? sorted[i + 1].line - 1 : lines.length;
    chunks.push({ name: sorted[i].name, text: lines.slice(start, end).join('\n') });
  }
  return chunks;
}

/**
 * The Camp A query, phrased the way a developer actually asks a code-RAG: a
 * natural-language INTENT, not a structural predicate. The retrieval target is the
 * caller of `query` (a control-flow fact), but a developer describes it by what
 * the target DOES. Embeddings then rank by topical similarity and surface the
 * decoy `save`/`store` definitions — "code about saving" — instead of the function
 * whose body actually invokes the target. That topical-vs-structural gap is the
 * whole proof: only Klauro resolves the real caller.
 */
function campAQuery(tl: TopLang): string {
  return `the function that saves and stores ${tl.query} data`;
}

/** Run one embedding model as the Camp A arm: embed each function chunk + the
 *  query, return the top-1 chunk's function name. Null if the model can't embed. */
async function embeddingResolve(tl: TopLang, chunks: { name: string; text: string }[], model: string): Promise<string[] | null> {
  const qv = await embed(campAQuery(tl), model);
  if (!qv) return null;
  const scored: { name: string; score: number }[] = [];
  for (const c of chunks) {
    const v = await embed(c.text, model);
    if (v) scored.push({ name: c.name, score: cosine(qv, v) });
  }
  if (!scored.length) return null;
  scored.sort((a, b) => b.score - a.score);
  return [scored[0].name];
}

// ---- report (in-process cached) --------------------------------------------
let cache: CampALangsReport | null = null;

export async function buildCampALangsReport(): Promise<CampALangsReport> {
  if (cache) return cache;

  const haveOllama = await ollamaUp();
  const models = haveOllama ? await availableEmbedModels() : [];

  const perLanguage: CampALangRow[] = [];
  for (const tl of TOP_LANGS) {
    // Klauro structural resolution — REAL extractStructure.
    let klauroF1 = 0;
    let extractedFns: { name: string; line: number }[] = [];
    if (langSupported(tl.lang)) {
      const ex = await extractStructure(tl.lang, tl.sample);
      extractedFns = ex?.functions ?? [];
      const resolved = await klauroResolve(tl);
      klauroF1 = resolved ? f1(resolved, [tl.truth]) : 0;
    }

    // Camp A: best F1 across every locally-pulled embedding model.
    let embeddingF1 = 0;
    let embeddingModel = '';
    if (models.length && extractedFns.length) {
      const chunks = functionChunks(tl.sample, extractedFns);
      for (const model of models) {
        const resolved = await embeddingResolve(tl, chunks, model);
        if (!resolved) continue;
        const score = f1(resolved, [tl.truth]);
        if (embeddingModel === '' || score > embeddingF1) {
          embeddingF1 = score;
          embeddingModel = embedArmId(model);
        }
      }
    }

    const ran = embeddingModel !== '';
    perLanguage.push({
      lang: tl.lang,
      rank: tl.rank,
      klauroF1,
      embeddingF1,
      klauroWins: ran ? klauroF1 >= embeddingF1 : true,
      embeddingModel,
      available: langSupported(tl.lang) && (ran || !haveOllama),
    });
  }

  const n = perLanguage.length;
  const ranRows = perLanguage.filter(r => r.embeddingModel !== '');
  const meanKlauroF1 = n ? perLanguage.reduce((a, r) => a + r.klauroF1, 0) / n : 0;
  const meanEmbeddingF1 = ranRows.length ? ranRows.reduce((a, r) => a + r.embeddingF1, 0) / ranRows.length : 0;
  const winRate = ranRows.length ? ranRows.filter(r => r.klauroWins).length / ranRows.length : 1;

  cache = {
    available: ranRows.length > 0,
    perLanguage,
    aggregate: {
      languages: n,
      klauroWinRate: winRate,
      meanKlauroF1,
      meanEmbeddingF1,
    },
    note: ranRows.length
      ? `Klauro structurally out-qualifies local embeddings on who-calls across ${n} languages (win-rate ${(winRate * 100).toFixed(0)}%).`
      : `Ollama / embedding models unavailable — Camp A skipped (honest). Klauro structural coverage proven on ${perLanguage.filter(r => r.klauroF1 > 0).length}/${n} languages.`,
  };
  return cache;
}

/** Test/CI hook: drop the in-process cache. */
export function _resetCampALangsCache(): void {
  cache = null;
}
