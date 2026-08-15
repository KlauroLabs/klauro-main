export function mentionsDeclaredImplementationName(description: string, names: string[]): boolean {
  const descriptionTokens = new Set(description.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  return names.some(name => String(name || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(token => token.length >= 5 && !/^(?:framework|library|platform)$/.test(token))
    .some(token => descriptionTokens.has(token)));
}

export function containsGenericImplementationMechanicFiller(description: string): boolean {
  return /\b(?:the\s+)?(?:system|application|app|service|product)\s+(?:runs|operates|is\s+(?:hosted|deployed))\s+(?:on|as|within)\s+(?:a\s+)?(?:server|backend|frontend|database)\b/i.test(description) ||
    /\b(?:the\s+)?(?:system|application|app|service|product)\s+(?:interacts|connects|communicates)\s+with\s+(?:a\s+)?(?:database|server|backend|frontend)\b/i.test(description) ||
    /\b(?:database|server|backend|frontend)\s+to\s+(?:store|retrieve|process|handle|serve)\b/i.test(description) ||
    /\b(?:authentication|authorization|access[- ]control)\s+(?:guard|middleware)\b/i.test(description);
}

export function stripApplicationImplementationFillerSentences(description: string, frameworks: string[]): string {
  const sentences = description.split(/(?<=[.!?])\s+/).map(sentence => sentence.trim()).filter(Boolean);
  const productSentences = sentences.filter(sentence =>
    !mentionsDeclaredImplementationName(sentence, frameworks) &&
    !containsGenericImplementationMechanicFiller(sentence)
  );
  if (productSentences.length < 2 || productSentences.length === sentences.length) return description;
  return productSentences.join(' ');
}
