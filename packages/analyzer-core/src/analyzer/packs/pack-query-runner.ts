








import { queryWasm, hasWasmGrammar, WasmCapture } from '../core/wasm-tree-sitter';


const PACK_LANGUAGE_GRAMMAR: Record<string, string> = {
  typescript: 'typescript',
  javascript: 'javascript',
  'typescript-javascript': 'typescript',
};

export function grammarForPackLanguage(language: string): string {
  return PACK_LANGUAGE_GRAMMAR[language] || language;
}

export function packLanguageHasGrammar(language: string): boolean {
  return hasWasmGrammar(grammarForPackLanguage(language));
}

export interface QueryMatch {

  captures: Record<string, WasmCapture>;

  line: number;
}

export class PackQueryError extends Error {
  constructor(public readonly ruleName: string, public readonly query: string, message: string) {
    super(message);
    this.name = 'PackQueryError';
  }
}

















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
