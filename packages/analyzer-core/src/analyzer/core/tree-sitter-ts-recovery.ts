export interface SyntaxErrorLocation {
  line: number;
  snippet: string;
}

function blank(value: string): string {
  return value.replace(/[^\r\n]/g, ' ');
}

function recoverLine(line: string, snippet: string): string {
  let recovered = line;
  if (snippet.trimStart().startsWith('&')) {
    recovered = recovered.replace(
      /(<([A-Za-z][\w:.-]*)\b[^>]*>)([^<>{}]*(?:&&|\|\|)[^<>{}]*)(<\/\2\s*>)/g,
      (_match: string, open: string, _tag: string, text: string, close: string) =>
        open + text.replace(/&&|\|\|/g, token => blank(token)) + close,
    );
  }
  if (snippet.includes('>()')) {
    recovered = recovered.replace(
      /<\s*typeof\s+import\s*\(\s*(['"])[^'"]+\1\s*\)\s*>(?=\s*\()/g,
      value => blank(value),
    );
  }
  if (snippet.startsWith('`')) {
    recovered = recovered.replace(/`(?:\\.|[^`])*`/g, literal => {
      const interpolations = literal.match(/\$\{[^}]*\}/g) || [];
      if (interpolations.some(value => !/^\$\{[A-Za-z_$][\w$]*\}$/.test(value))) return literal;
      return literal.replace(/<\/?[A-Za-z][^<>{}\n]*>/g, tag =>
        tag.replace(/[<>]/g, (character: string) => blank(character)));
    });
  }
  return recovered;
}

export function recoverRecognizedTypeScriptGrammarArtifacts(
  source: string,
  locations: readonly SyntaxErrorLocation[],
): string {
  if (locations.length === 0) return source;
  const lines = source.split('\n');
  let changed = false;
  for (const location of locations) {
    const index = location.line - 1;
    if (index < 0 || index >= lines.length) continue;
    const recovered = recoverLine(lines[index], location.snippet);
    if (recovered !== lines[index]) {
      lines[index] = recovered;
      changed = true;
    }
  }
  return changed ? lines.join('\n') : source;
}

export interface RecoveredTypeScriptTree {
  tree: any;
  root: any;
  hasSyntaxErrors: boolean;
}

export function recoverTypeScriptTree(
  parser: any,
  tree: any,
  originalSource: string,
  parsedSource: string,
  getRoot: (tree: any) => any,
  hasErrors: (root: any) => boolean,
  collectLocations: (root: any, sourceLines?: string[]) => SyntaxErrorLocation[],
): RecoveredTypeScriptTree {
  let root = getRoot(tree);
  if (!hasErrors(root)) return { tree, root, hasSyntaxErrors: false };
  const locations = collectLocations(root, originalSource.split('\n'));
  const recoveredSource = recoverRecognizedTypeScriptGrammarArtifacts(parsedSource, locations);
  if (recoveredSource === parsedSource) return { tree, root, hasSyntaxErrors: true };
  const recoveredTree = parser.parse(recoveredSource);
  const recoveredRoot = getRoot(recoveredTree);
  if (hasErrors(recoveredRoot)) {
    recoveredTree.delete?.();
    return { tree, root, hasSyntaxErrors: true };
  }
  tree.delete?.();
  tree = recoveredTree;
  root = recoveredRoot;
  return { tree, root, hasSyntaxErrors: false };
}

export function originalNodeText(source: Buffer, node: any): string {
  if (typeof node?.startIndex !== 'number' || typeof node?.endIndex !== 'number') return String(node?.text || '');
  return source.subarray(node.startIndex, node.endIndex).toString('utf8');
}

export interface TypeScriptSourceFailure {
  path: string;
  reason: string;
  bytes?: number;
}

export function partialTypeScriptSourceFailure(
  path: string,
  source: string,
  locations: readonly SyntaxErrorLocation[],
): TypeScriptSourceFailure & { bytes: number } {
  return {
    path,
    reason: locations.length > 0
      ? 'unparsed syntax near ' + locations.map(location => 'line ' + location.line + ': ' + location.snippet).join('; ')
      : 'parser reported unlocated syntax errors',
    bytes: Buffer.byteLength(source, 'utf8'),
  };
}

export function typeScriptSourceDiagnostics(
  omitted: readonly TypeScriptSourceFailure[],
  partial: readonly TypeScriptSourceFailure[],
): Record<string, unknown> {
  return {
    ...(omitted.length > 0 ? { omitted_source_files: [...omitted] } : {}),
    ...(partial.length > 0 ? { partial_source_files: [...partial] } : {}),
  };
}

export function typeScriptAnalysisScope(
  filesEligible: number,
  filesAnalyzed: number,
  incomplete: readonly TypeScriptSourceFailure[],
): { files_eligible: number; files_analyzed: number; files_skipped: number; complete: boolean; incomplete_reason?: string; omitted_paths?: string[] } {
  return {
    files_eligible: filesEligible,
    files_analyzed: filesAnalyzed,
    files_skipped: incomplete.length,
    complete: incomplete.length === 0,
    ...(incomplete.length > 0 ? {
      incomplete_reason: incomplete.length + ' source file(s) could not be fully parsed; see framework_specific omission diagnostics',
      omitted_paths: incomplete.map(file => file.path).sort(),
    } : {}),
  };
}
