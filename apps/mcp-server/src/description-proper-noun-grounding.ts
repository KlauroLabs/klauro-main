const SHORT_TITLE_CASE_LANGUAGE_TERMS = new Set([
  'a', 'an', 'the', 'this', 'that', 'it', 'its', 'when', 'once', 'then',
  'if', 'as', 'but', 'and', 'or', 'for', 'from', 'with', 'into', 'onto',
  'than', 'each', 'some', 'many', 'most', 'more', 'less', 'also', 'key', 'data',
]);

export function unexplainedShortTitleCaseTerms(
  text: string,
  isGrounded: (term: string) => boolean,
): string[] {
  return Array.from(new Set(
    [...String(text || '').matchAll(/\b[A-Z][a-z]{1,3}\b/g)]
      .map(match => match[0])
      .filter(term => !SHORT_TITLE_CASE_LANGUAGE_TERMS.has(term.toLowerCase()))
      .filter(term => !isGrounded(term)),
  ));
}
