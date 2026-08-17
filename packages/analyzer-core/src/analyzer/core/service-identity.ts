const TRANSPORT_SUFFIXES = new Set([
  'wsdl',
  'url',
  'uri',
  'endpoint',
  'address',
  'host',
  'config',
  'setting',
]);

function identifierWords(identifier: string): string[] {
  return identifier
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[_\s-]+/)
    .filter(Boolean);
}

function meaningfulWords(identifier: string): string[] {
  const words = identifierWords(identifier);
  while (words.length > 0 && TRANSPORT_SUFFIXES.has(words[words.length - 1].toLowerCase())) words.pop();
  return words;
}

function normalizedWords(words: string[]): string {
  return words.join('').toLowerCase();
}

function displayWords(words: string[]): string {
  return words.map(word => `${word.charAt(0).toUpperCase()}${word.slice(1).toLowerCase()}`).join(' ');
}

export function serviceNameFromEndpoint(endpoint: string): string | undefined {
  try {
    return new URL(endpoint).hostname || undefined;
  } catch {
    return undefined;
  }
}

export function serviceNameFromConfigurationExpression(
  expression: string | undefined,
  sourcePath?: string,
): string | undefined {
  const identifier = expression?.match(/([A-Za-z_][A-Za-z0-9_]*)\s*$/)?.[1];
  if (!identifier) return undefined;
  const words = meaningfulWords(identifier);
  if (words.length === 0) return undefined;
  const normalized = normalizedWords(words);
  for (const pathPart of (sourcePath || '').split('/')) {
    const candidateWords = identifierWords(pathPart.replace(/\.[^.]+$/, ''));
    if (candidateWords.length > 1 && normalizedWords(candidateWords) === normalized) {
      return displayWords(candidateWords);
    }
  }
  return displayWords(words);
}

export function isConfigurationConstantExpression(expression: string): boolean {
  const identifier = expression.match(/\.([A-Z][A-Z0-9_]+)\s*$/)?.[1];
  return Boolean(identifier && identifier.includes('_'));
}
