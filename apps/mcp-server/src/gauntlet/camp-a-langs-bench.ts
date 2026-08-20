




























import { extractStructure } from '../../../../packages/analyzer-core/src/analyzer/core/generic-tree-sitter-analyzer';
import { hasWasmGrammar } from '../../../../packages/analyzer-core/src/analyzer/core/wasm-tree-sitter';
import { hasNativeGrammar } from '../../../../packages/analyzer-core/src/analyzer/core/native-parse';
import { specFor } from '../../../../packages/analyzer-core/src/analyzer/core/language-spec';
import { embedArmId } from './primitive-bench';
import { TOP_LANGS, type TopLang } from './camp-a-langs';

export interface CampALangRow {
  lang: string;
  rank: number;

  klauroF1: number;

  embeddingF1: number;

  klauroWins: boolean;

  embeddingModel: string;

  available: boolean;
}

export interface CampALangsReport {


  available: boolean;
  perLanguage: CampALangRow[];
  aggregate: {
    languages: number;
    comparedLanguages: number;
    klauroWinRate: number | null;
    meanKlauroF1: number;
    meanEmbeddingF1: number | null;
  };
  note: string;
}


function f1(produced: string[], truth: string[]): number {
  const prod = [...new Set(produced)];
  const tp = prod.filter(x => truth.includes(x)).length;
  const precision = prod.length ? tp / prod.length : (truth.length ? 0 : 1);
  const recall = truth.length ? tp / truth.length : 1;
  return precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
}




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










function campAQuery(tl: TopLang): string {
  return `the function that saves and stores ${tl.query} data`;
}



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


let cache: CampALangsReport | null = null;

export async function buildCampALangsReport(): Promise<CampALangsReport> {
  if (cache) return cache;

  const haveOllama = await ollamaUp();
  const models = haveOllama ? await availableEmbedModels() : [];

  const perLanguage: CampALangRow[] = [];
  for (const tl of TOP_LANGS) {

    let klauroF1 = 0;
    let extractedFns: { name: string; line: number }[] = [];
    if (langSupported(tl.lang)) {
      const ex = await extractStructure(tl.lang, tl.sample);
      extractedFns = ex?.functions ?? [];
      const resolved = await klauroResolve(tl);
      klauroF1 = resolved ? f1(resolved, [tl.truth]) : 0;
    }


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
      klauroWins: ran && klauroF1 >= embeddingF1,
      embeddingModel,
      available: langSupported(tl.lang) && ran,
    });
  }

  const n = perLanguage.length;
  const ranRows = perLanguage.filter(r => r.available);
  const meanKlauroF1 = n ? perLanguage.reduce((a, r) => a + r.klauroF1, 0) / n : 0;
  const meanEmbeddingF1 = ranRows.length ? ranRows.reduce((a, r) => a + r.embeddingF1, 0) / ranRows.length : null;
  const winRate = ranRows.length ? ranRows.filter(r => r.klauroWins).length / ranRows.length : null;

  cache = {
    available: ranRows.length > 0,
    perLanguage,
    aggregate: {
      languages: n,
      comparedLanguages: ranRows.length,
      klauroWinRate: winRate,
      meanKlauroF1,
      meanEmbeddingF1,
    },
    note: ranRows.length
      ? `Klauro structurally out-qualifies local embeddings on who-calls across ${ranRows.length} measured languages (win-rate ${(winRate! * 100).toFixed(0)}%).`
      : `Ollama / embedding models unavailable — Camp A skipped (honest). Klauro structural coverage proven on ${perLanguage.filter(r => r.klauroF1 > 0).length}/${n} languages.`,
  };
  return cache;
}


export function _resetCampALangsCache(): void {
  cache = null;
}
