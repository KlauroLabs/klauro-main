/**
 * Runs a pack rule's tree-sitter query against parsed source and groups the
 * raw captures into per-match capture sets (one query can match many places
 * in a file; each match's captures must stay together so `emit` can resolve
 * `@captureName` references to the SAME match, not a cross-match mixup).
 *
 * Uses the SAME vendored tree-sitter WASM path the rest of the analyzer core
 * uses (queryWasm in wasm-tree-sitter.ts) — no separate parsing stack.
 */
import { queryWasm, hasWasmGrammar, WasmCapture } from '../core/wasm-tree-sitter';

/** Grammar id passed to tree-sitter-wasms/web-tree-sitter's Language.load. */
const PACK_LANGUAGE_GRAMMAR: Record<string, string> = {
  typescript: 'typescript',
  javascript: 'javascript',
  'typescript-javascript': 'typescript', // superset grammar covers plain JS too
};

export function grammarForPackLanguage(language: string): string {
  return PACK_LANGUAGE_GRAMMAR[language] || language;
}

export function packLanguageHasGrammar(language: string): boolean {
  return hasWasmGrammar(grammarForPackLanguage(language));
}

export interface QueryMatch {
  /** capture name -> capture, for this single match. */
  captures: Record<string, WasmCapture>;
  /** Convenience: min startLine across the match's captures (1-based). */
  line: number;
}

export class PackQueryError extends Error {
  constructor(public readonly ruleName: string, public readonly query: string, message: string) {
    super(message);
    this.name = 'PackQueryError';
  }
}

/**
 * Run a single tree-sitter query string against source and group captures
 * into matches. Captures sharing the same node's *ancestor match root* are
 * grouped by proximity: tree-sitter's `.captures()` returns a flat list in
 * document order, one entry per (pattern, capture) pair; we group consecutive
 * captures that share a common enclosing top-level match by re-running with
 * `.matches()`-shaped semantics is unavailable in this web-tree-sitter version,
 * so we approximate via line-adjacency clustering: captures within the same
 * rule query naturally interleave per occurrence in source order, and each
 * capture name in a rule normally appears once per logical match. Grouping
 * key = the FIRST capture name's occurrence order (each Nth occurrence of the
 * anchor capture starts a new match); every other capture name's Nth
 * occurrence joins that same match. This is exact when the query has no
 * quantified (`+`/`*`) capture, which covers the two proof packs and the
 * documented rule-authoring guidance (see docs/SPEC-ANALYZER-PACKS.md).
 */
export async function runPackQuery(
  language: string,
  source: string,
  ruleName: string,
  queryString: string,
): Promise<QueryMatch[]> {
  const grammar = grammarForPackLanguage(language);
  let captures: WasmCapture[];
  try {
    captures = await queryWasm(grammar, source, queryString);
  } catch (error) {
    throw new PackQueryError(ruleName, queryString, `tree-sitter query failed to compile/run: ${(error as Error).message}`);
  }

  if (captures.length === 0) return [];

  // Distinct capture names in first-seen order — the first is the "anchor".
  const namesInOrder: string[] = [];
  for (const c of captures) if (!namesInOrder.includes(c.name)) namesInOrder.push(c.name);
  const anchorName = namesInOrder[0];

  const byName = new Map<string, WasmCapture[]>();
  for (const name of namesInOrder) byName.set(name, captures.filter(c => c.name === name));

  const anchorCaptures = byName.get(anchorName) || [];
  const matches: QueryMatch[] = [];
  for (let i = 0; i < anchorCaptures.length; i++) {
    const matchCaptures: Record<string, WasmCapture> = { [anchorName]: anchorCaptures[i] };
    for (const name of namesInOrder) {
      if (name === anchorName) continue;
      const list = byName.get(name) || [];
      if (list[i]) matchCaptures[name] = list[i];
    }
    matches.push({ captures: matchCaptures, line: anchorCaptures[i].startLine });
  }
  return matches;
}
