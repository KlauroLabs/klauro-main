export interface ElementDescriptionSubject {
  name: string;
  relatedDomains?: string[];
  fields?: string[];
  /** Entity names connected to the subject; ground domain-legitimate vocabulary. */
  relatedEntities?: string[];
  /**
   * System-level grounding vocabulary: primary domain, core concepts, and the
   * deterministic overview text. Marketing-flagged words that are grounded in
   * this vocabulary are domain terms (e.g. "compliance" in a fleet-compliance
   * system) and must not be rejected — parity with the system description
   * validator's grounded-words-allowed rule.
   */
  domainVocabulary?: string[];
}

export interface ElementDescriptionValidationOptions {
  minLength?: number;
  maxLength?: number;
  normalizeToken?: (token: string) => string;
  isGenericToken?: (token: string) => boolean;
}

const DEFAULT_GENERIC_SUBJECT_TOKENS = new Set([
  'management', 'service', 'services', 'system', 'systems', 'manager', 'module', 'modules',
  'component', 'components', 'handler', 'handlers', 'controller', 'controllers', 'data', 'api', 'the', 'and',
]);

const FILLER_PHRASE_PATTERN = new RegExp([
  '\\b(?:operations for|functionality|centers on|graph endpoints?|graph structure|coordinat(?:e|es|ing) operations|(?:read|process|coordinate|analyze|delete) behavior|(?:read|process|analyze|delete) paths?|coordinates? internal files|internal files|supports? tasks|agent-driven operations|operations and insights|quality of description analysis|review and understanding)\\b',
  '\\b(?:Key capabilities|Data model|Entry points|Integrations):',
  '\\bby\\s+(?:reading|processing|coordinating|handling)\\b',
  '\\bsupports?\\s+(?:reading|processing|coordinating|handling|tasks|operations)\\b',
  '\\bfacilitat(?:e|es|ing)\\b',
  '\\bthe (?:interaction|integration) (?:between|of|with)\\b',
  '\\bto (?:support|enable|ensure) (?:secure|seamless|effective|smooth|reliable)\\b',
  '\\b[a-z0-9]+-related (?:components?|modules?|services?|code)\\b',
  '\\b(?:parent signals?|internal entry points?|entry[- ]point mechanics|associated (?:graph )?endpoints?)\\b',
  '\\b(?:read|update|coordinate|process|analyze|delete)(?:,? (?:and )?(?:read|update|coordinate|process|analyze|delete))+ (?:actions|operations|paths)\\b',
].join('|'), 'i');

const MARKETING_LANGUAGE_PATTERN = /\b(seamless(?:ly)?|robust|comprehensive|various|crucial role|plays a key role|efficient(?:ly)?|efficiency|productivity|compliant|compliance|advanced|streamline(?:s|d|ing)?|user-friendly|business value|improving operational|enhanc(?:e|es|ing)|better understanding|insights(?: into)?|structured data and insights|reduces? costs?|best practices|scalable|secure by design|user experience)\b/gi;

function splitGroundingSource(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/);
}

function subjectGroundingTokens(
  subject: ElementDescriptionSubject,
  normalizeToken: (token: string) => string,
  isGenericToken: (token: string) => boolean,
): string[] {
  return [
    ...splitGroundingSource(subject.name),
    ...(subject.relatedDomains || []),
    ...(subject.fields || []).map(field => field.split(':')[0]),
  ]
    .map(token => normalizeToken(token.toLowerCase()))
    .filter(token => token.length > 2 && !isGenericToken(token));
}

/**
 * Grounding tokens that legitimize marketing-flagged vocabulary but do NOT
 * count toward target-not-grounded: entity names and system-level domain
 * vocabulary. Kept separate so a description still has to mention the subject
 * itself, while domain terms like "compliance" survive in a compliance system.
 */
function marketingGroundingTokens(
  subject: ElementDescriptionSubject,
  normalizeToken: (token: string) => string,
): string[] {
  return [
    ...(subject.relatedEntities || []),
    ...(subject.domainVocabulary || []),
  ]
    .flatMap(value => splitGroundingSource(String(value || '')))
    .map(token => normalizeToken(token))
    .filter(token => token.length > 2);
}

function ungroundedMarketingMatches(
  description: string,
  subjectTokens: string[],
  extraGroundingTokens: string[] = [],
  groundingText = '',
): string[] {
  const matches = Array.from(new Set(
    (description.match(MARKETING_LANGUAGE_PATTERN) || []).map(match => match.toLowerCase().trim())
  ));
  if (matches.length === 0) return [];
  const groundedStems = new Set(
    [...subjectTokens, ...extraGroundingTokens]
      .filter(token => token.length >= 4)
      .map(token => token.slice(0, 8))
  );
  const lowerGroundingText = groundingText.toLowerCase();
  return matches.filter(match => {
    const tokens = match.split(/\s+/);
    if (tokens.length > 1) {
      return !(lowerGroundingText && lowerGroundingText.includes(match));
    }
    return !groundedStems.has(tokens[0].slice(0, 8));
  });
}

export function validateElementDescription(
  description: string,
  subject: ElementDescriptionSubject,
  options: ElementDescriptionValidationOptions = {},
): { ok: boolean; reason?: string } {
  const minLength = options.minLength ?? 50;
  const maxLength = options.maxLength ?? 420;
  const normalizeToken = options.normalizeToken ?? ((token: string) => token);
  const isGenericToken = options.isGenericToken ?? ((token: string) => DEFAULT_GENERIC_SUBJECT_TOKENS.has(token));

  const cleaned = (description || '').trim();
  if (cleaned.length < minLength) return { ok: false, reason: 'too-short' };
  if (cleaned.length > maxLength) return { ok: false, reason: 'too-long' };
  if (/\*\*|`|^#+\s/m.test(cleaned)) return { ok: false, reason: 'markdown-formatting' };
  if (FILLER_PHRASE_PATTERN.test(cleaned)) return { ok: false, reason: 'generic-structural-phrase' };

  const subjectTokens = subjectGroundingTokens(subject, normalizeToken, isGenericToken);
  const marketingMatches = ungroundedMarketingMatches(
    cleaned,
    subjectTokens,
    marketingGroundingTokens(subject, token => normalizeToken(token)),
    (subject.domainVocabulary || []).join(' '),
  );
  if (marketingMatches.length > 0) {
    return { ok: false, reason: `unsupported-marketing-language: ${marketingMatches.join(', ')}` };
  }

  if (subjectTokens.length === 0) return { ok: true };
  const lower = cleaned.toLowerCase();
  if (!subjectTokens.some(token => lower.includes(token))) return { ok: false, reason: 'target-not-grounded' };
  return { ok: true };
}
