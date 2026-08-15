













export type RegexAnalyzedLanguage = 'python' | 'java' | 'ruby' | 'dart' | 'php';

export interface SyntaxDegradationCheck {
  relativePath: string;
  content: string;
  language: RegexAnalyzedLanguage;
  extractedNodeCount: number;
}

const DELIMITER_IMBALANCE_THRESHOLD = 3;

const DECLARATION_PATTERNS: Record<RegexAnalyzedLanguage, RegExp> = {
  python: /^\s*(?:def|class)\s+\w/m,
  java: /\b(?:class|interface|enum|record)\s+\w/,
  ruby: /^\s*(?:def|class|module)\s+\w/m,
  dart: /\b(?:class|enum|mixin|extension)\s+\w|^\s*(?:void|int|double|String|bool|Future|Stream)\b[^;]*\(/m,
  php: /\b(?:function|class|interface|trait|enum)\s+\w/,
};








const LINE_COMMENT_PATTERNS: Record<RegexAnalyzedLanguage, RegExp> = {
  python: /#[^\n]*/g,
  java: /\/\/[^\n]*/g,
  ruby: /#[^\n]*/g,
  dart: /\/\/[^\n]*/g,
  php: /\/\/[^\n]*|#(?!\[)[^\n]*/g,
};

const BLOCK_COMMENT_LANGUAGES = new Set<RegexAnalyzedLanguage>(['java', 'dart', 'php']);

const BRACE_LANGUAGES = new Set<RegexAnalyzedLanguage>(['java', 'dart', 'php']);

function stripStringsAndComments(content: string, language: RegexAnalyzedLanguage): string {
  let result = content;
  if (language === 'python') {
    result = result.replace(/("""[\s\S]*?"""|'''[\s\S]*?''')/g, ' ');
  }
  if (BLOCK_COMMENT_LANGUAGES.has(language)) {
    result = result.replace(/\/\*[\s\S]*?\*\//g, ' ');
  }
  if (language === 'ruby') {
    result = result.replace(/^=begin[\s\S]*?^=end/gm, ' ');
    result = result.replace(/<<[-~]?(['"]?)([A-Z_][A-Z0-9_]*)\1[\s\S]*?^\s*\2\s*$/gm, ' ');
  }
  result = result.replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g, ' ');
  result = result.replace(LINE_COMMENT_PATTERNS[language], ' ');
  return result;
}

function delimiterImbalance(stripped: string, open: string, close: string): number {
  let openCount = 0;
  let closeCount = 0;
  for (const character of stripped) {
    if (character === open) openCount += 1;
    else if (character === close) closeCount += 1;
  }
  return Math.abs(openCount - closeCount);
}

function isNonTrivial(content: string): boolean {
  let codeLines = 0;
  for (const line of content.split('\n')) {
    if (line.trim().length > 0) codeLines += 1;
    if (codeLines >= 10) return true;
  }
  return false;
}







export function detectSyntaxDegradation(check: SyntaxDegradationCheck): string | undefined {
  const { relativePath, content, language, extractedNodeCount } = check;
  if (content.trim().length === 0) return undefined;

  const stripped = stripStringsAndComments(content, language);

  const imbalances: Array<[string, number]> = [
    ['parentheses', delimiterImbalance(stripped, '(', ')')],
    ['brackets', delimiterImbalance(stripped, '[', ']')],
  ];
  if (BRACE_LANGUAGES.has(language)) {
    imbalances.push(['braces', delimiterImbalance(stripped, '{', '}')]);
  }
  const damaged = imbalances.filter(([, imbalance]) => imbalance >= DELIMITER_IMBALANCE_THRESHOLD);
  if (damaged.length > 0) {
    const description = damaged.map(([kind, imbalance]) => `${kind} off by ${imbalance}`).join(', ');
    return `${relativePath} appears to contain broken syntax (unbalanced ${description}); extraction may be partial`;
  }

  if (extractedNodeCount === 0 && isNonTrivial(content) && DECLARATION_PATTERNS[language].test(stripped)) {
    return `${relativePath} contains declaration keywords but no code elements could be extracted; the file may have broken syntax`;
  }

  return undefined;
}
