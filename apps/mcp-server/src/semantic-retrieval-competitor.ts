import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { CASOutput, CASNode } from '../../../packages/analyzer-core/src/types/cas.types';
import type { EmbeddingProvider } from '../../../packages/analyzer-core/src/analyzer/embedding/types';


















export function cosineSim(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom ? dot / denom : 0;
}


async function nodeRawCode(
  node: CASNode,
  repoPath: string,
  fileCache: Map<string, string[]>,
): Promise<string> {
  const raw = node.source?.raw;
  if (raw && raw.trim()) return raw.slice(0, 2000);
  const file = node.source?.file;
  if (!file) return '';
  let lines = fileCache.get(file);
  if (!lines) {
    try {
      lines = (await fs.readFile(path.join(repoPath, file), 'utf8')).split('\n');
    } catch {
      lines = [];
    }
    fileCache.set(file, lines);
  }
  if (lines.length === 0) return '';
  const start = Math.max(0, (node.source?.line ?? 1) - 1);
  const end = node.source?.end_line ?? start + 1;
  return lines.slice(start, Math.max(end, start + 1)).join('\n').slice(0, 2000);
}

export interface CompetitorRankingOptions {
  topK?: number;

  nodeFilter?: (n: CASNode) => boolean;
}



export type NodeTextSelector = (
  node: CASNode,
  repoPath: string,
  fileCache: Map<string, string[]>,
) => Promise<string> | string;


export const descriptionText: NodeTextSelector = node =>
  [node.name, node.qualified_name, node.description].filter(Boolean).join(' — ');








export async function rankNodesByText(
  cas: CASOutput,
  repoPath: string,
  query: string,
  provider: EmbeddingProvider,
  textOf: NodeTextSelector,
  options: CompetitorRankingOptions = {},
): Promise<string[]> {
  const topK = options.topK && options.topK > 0 ? options.topK : 10;
  const filter =
    options.nodeFilter ??
    ((n: CASNode) => /function|method/.test(String(n.type)) && !!n.source?.file);
  const nodes = (cas.nodes || []).filter(filter);

  const fileCache = new Map<string, string[]>();
  const docs: Array<{ id: string; text: string }> = [];
  for (const n of nodes) {
    const text = (await textOf(n, repoPath, fileCache)) || '';
    if (text.trim()) docs.push({ id: n.id, text });
  }
  if (docs.length === 0) return [];

  const [queryVec] = await provider.embed([query]);
  const docVecs = await provider.embed(docs.map(d => d.text));
  const scored = docs.map((d, i) => ({ id: d.id, score: cosineSim(queryVec, docVecs[i]) }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK).map(s => s.id);
}






export async function rawCodeCompetitorRanking(
  cas: CASOutput,
  repoPath: string,
  query: string,
  provider: EmbeddingProvider,
  options: CompetitorRankingOptions = {},
): Promise<string[]> {
  return rankNodesByText(cas, repoPath, query, provider, nodeRawCode, options);
}
