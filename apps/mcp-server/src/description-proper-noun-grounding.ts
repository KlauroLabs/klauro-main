const NON_CLAIM_TITLE_CASE_TERM = /^(A|An|The|This|It|Its|When|Key|Data|Entry|REST|API|UI|SQL|AWS|GPO)$/;

export function unexplainedShortTitleCaseTerms(
  text: string,
  isGrounded: (term: string) => boolean,
): string[] {
  return Array.from(new Set(
    [...String(text || '').matchAll(/\b[A-Z][a-z]{1,3}\b/g)]
      .map(match => match[0])
      .filter(term => !NON_CLAIM_TITLE_CASE_TERM.test(term))
      .filter(term => !isGrounded(term)),
  ));
}
