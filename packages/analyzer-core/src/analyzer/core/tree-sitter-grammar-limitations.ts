const INLINE_IMPORT_SUFFIX = /\bimport\s*\(\s*(['"])(?:(?!\1).)*\1\s*\)(?:\s*\.\s*[A-Za-z_$][\w$]*)*\s*(?:\[\s*(?:\]|['"][^'"\]\n]+['"]\s*\])|<)/;

export function sanitizeTaggedTemplateTypeArguments(source: string): string {
  let sanitized: string[] | undefined;
  for (let start = 0; start < source.length; start++) {
    if (source[start] !== '<') continue;
    let previous = start - 1;
    while (previous >= 0 && /\s/.test(source[previous])) previous--;
    if (previous < 0 || !/[\w$.)\]]/.test(source[previous])) continue;
    let depth = 0;
    let quote = '';
    let escaped = false;
    for (let end = start; end < source.length; end++) {
      const character = source[end];
      if (quote) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === quote) quote = '';
        continue;
      }
      if (character === "'" || character === '"') {
        quote = character;
        continue;
      }
      if (character === '<') depth++;
      else if (character === '>') depth--;
      if (depth !== 0) continue;
      let next = end + 1;
      while (next < source.length && /\s/.test(source[next])) next++;
      if (source[next] !== '`') break;
      sanitized ||= [...source];
      for (let index = start; index <= end; index++) {
        if (sanitized[index] !== '\n' && sanitized[index] !== '\r') sanitized[index] = ' ';
      }
      start = end;
      break;
    }
  }
  return sanitized?.join('') || source;
}

export function classifyKnownTypeScriptGrammarLimitation(
  lineText: string | undefined,
  line: number,
  sourceLines?: string[]
): string | undefined {
  if (!lineText) return undefined;
  if (INLINE_IMPORT_SUFFIX.test(lineText)) {
    return "inline `import('module').Type` used with an array, indexed-access, or generic suffix — tree-sitter-typescript 0.23.2 cannot parse this valid TypeScript construct";
  }
  if (/\busing\b/.test(lineText) && !/\busing\s+[A-Za-z_$][\w$]*\s*=/.test(lineText)) {
    return "the contextual keyword `using` used as an identifier (parameter/variable name) — tree-sitter-typescript 0.23.2 cannot disambiguate it from a `using` resource declaration";
  }
  if (/^\s*[A-Za-z_$][\w$]*\?\s*:/.test(lineText)) {
    const preceding = sourceLines?.slice(Math.max(0, line - 6), line).join('\n') || '';
    if (INLINE_IMPORT_SUFFIX.test(preceding)) {
      return 'parser recovery after an inline import type suffix produced a missing optional-property token';
    }
  }
  return undefined;
}
