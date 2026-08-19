const INLINE_IMPORT_SUFFIX = /\bimport\s*\(\s*(['"])(?:(?!\1).)*\1\s*\)(?:\s*\.\s*[A-Za-z_$][\w$]*)*\s*(?:\[\s*(?:\]|['"][^'"\]\n]+['"]\s*\])|<)/;

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
