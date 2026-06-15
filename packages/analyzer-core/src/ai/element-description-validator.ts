export interface ElementDescriptionSubject {
  name: string;
  kind?: string;
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
  '\\b(?:system components?|different system components?|executing tasks?|execute tasks?|runtime behavior)\\b',
  '\\bacross different\\b',
  '\\bacross (?:devices?|channels?|platforms?|scripts?)\\b',
  '\\bacross platforms?\\b',
  '\\bscript usage\\b',
  '\\bbefore/while\\b',
  '\\bhelps engineers or agents\\b',
  '\\bwhen scripts?\\b',
  '\\bhandles? the (?:creation|management|creation and management|coordination) of\\b',
  '\\b(?:Key capabilities|Data model|Entry points|Integrations):',
  '\\bby\\s+(?:reading|processing|coordinating|handling)\\b',
  '\\bsupports?\\s+(?:reading|processing|coordinating|handling|tasks|operations)\\b',
  '\\bfacilitat(?:e|es|ing)\\b',
  '\\bthe (?:interaction|integration) (?:between|of|with)\\b',
  '\\bto (?:support|enable|ensure) (?:secure|seamless|effective|smooth|reliable)\\b',
  '\\b[a-z0-9]+-related (?:components?|modules?|services?|systems?|code)\\b',
  '\\b(?:parent signals?|internal entry points?|entry[- ]point mechanics|associated (?:graph )?endpoints?)\\b',
  '\\b(?:codebase decision|specific codebase decision|before a codebase decision|within the platform interactions?)\\b',
  '\\bstate mutations?\\b',
  '\\bactionable insights?\\b',
  '\\bwhen for\\b',
  '\\b(?:validated )?code understanding and modification\\b',
  '\\b(?:benchmark report|gate statuses|work unit estimates|recommended focus layers|different analysis focus configurations|structured report)\\b',
  '\\b(?:service|storage) interfaces?\\b',
  '\\b(?:service operations?|standardized data handling|data handling and protocols?|supported product areas)\\b',
  '\\b(?:read|update|coordinate|process|analyze|delete)(?:,? (?:and )?(?:read|update|coordinate|process|analyze|delete))+ (?:actions|operations|paths)\\b',
  '\\b(?:creation|coordination|generation|organization) of (?:these )?(?:files?|source files?|code files?)\\b',
  '\\b(?:files?|source files?|code files?) (?:related to|like|such as)\\b',
  '\\b(?:handles?|manages?|supports?|coordinates?) (?:both )?(?:the )?(?:generation|coordination|organization|creation) (?:and|of)\\b',
  '\\binternal coordination scripts?\\b',
  '\\bscript execution and configuration\\b',
  '\\bsetup and maintenance of analysis environments\\b',
  '\\bprovides tools for developers to integrate and extend analysis capabilities\\b',
  '\\bprovides tools for AI agents to interact with codebases\\b',
  '\\binstallation and environment checks?\\b',
  '\\bstorage and retrieval of analysis results\\b',
  '\\banalysis results and runs\\b',
  '\\bAnalysisResults? and AnalysisRuns?\\b',
  '\\bcollection and processing of trace data\\b',
  '\\bcaptures? and processes? trace data\\b',
  '\\bmanages? the lifecycle of analysis data\\b',
  '\\blets engineers manage [^.]{0,180}\\bthrough (?:HTTP|API) endpoints?\\b',
  '\\b(?:covers?|spans?) [^.]{0,80}\\bpaths?\\b',
  '\\bspans scripts?\\b',
  '\\bconfiguration support\\b',
  '\\bcentralizes? the coordination of [^.]{0,140}\\bscripts?\\b',
].join('|'), 'i');

const MARKETING_LANGUAGE_PATTERN = /\b(seamless(?:ly)?|robust|comprehensive|various|crucial role|plays a key role|efficient(?:ly)?|efficiency|productivity|compliant|compliance|advanced|streamline(?:s|d|ing)?|user-friendly|business value|improving operational|enhanc(?:e|es|ing)|better understanding|insights(?: into)?|structured data and insights|reduces? costs?|best practices|scalable|secure by design|user experience)\b/gi;

function splitGroundingSource(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
  if (/\b[\w.-]+\.(?:ts|tsx|js|jsx|py|php|rb|go|rs|java|cs|dart|swift|kt|sql|tf|tfvars|hcl|yaml|yml|json)\b/i.test(cleaned)) {
    return { ok: false, reason: 'source-file-restatement' };
  }
  if (subject.kind === 'capability' &&
    isGenericAnalyzerCapabilityName(subject.name) &&
    cleaned.toLowerCase().startsWith(subject.name.toLowerCase())) {
    return { ok: false, reason: 'generic-analyzer-name-restatement' };
  }
  if (subject.kind === 'capability' && /^[a-z]+\s/.test(cleaned)) {
    return { ok: false, reason: 'missing-subject' };
  }
  if (subject.kind === 'capability' &&
    /\b(?:coordinates?|generates?|manages?|supports?|organizes?|executes?) (?:and )?(?:generates?|coordinates?|manages?|executes?)? ?(?:specific )?functions?\b|\bfunctions? (?:to|like|such as) (?:process|format|render|parse|count|[a-zA-Z0-9_, ]+)\b|\b(?:these|specific) functions?\b|\bargument parsing\b|\btable formatting\b|\brow rendering\b|\bstructured data handling\b|\bprocess and structure data\b/i.test(cleaned)) {
    return { ok: false, reason: 'implementation-function-restatement' };
  }
  if (subject.kind === 'capability') {
    const codeIdentifierMatches = cleaned.match(/\b[a-z][a-z0-9]+[A-Z][A-Za-z0-9]*\b/g) || [];
    if (codeIdentifierMatches.length >= 2 || /\b(?:functions?|helpers?|methods?)\b/i.test(cleaned) && codeIdentifierMatches.length > 0) {
      return { ok: false, reason: 'implementation-identifier-restatement' };
    }
    const titleCaseInventoryItems = cleaned.match(/\b[A-Z][a-z0-9]+(?:\s+[A-Z][a-z0-9]+){1,4}\b/g) || [];
    const uniqueInventoryItems = new Set(titleCaseInventoryItems.filter(item =>
      !new RegExp(`^${escapeRegExp(subject.name)}$`, 'i').test(item) &&
      !/^(Management|Operator|Agent|User|Developer)$/.test(item)
    ));
    if (uniqueInventoryItems.size >= 5) {
      return { ok: false, reason: 'inventory-list-description' };
    }
  }
  if (FILLER_PHRASE_PATTERN.test(cleaned)) return { ok: false, reason: 'generic-structural-phrase' };
  if (/\borientation entry\b/i.test(cleaned)) return { ok: false, reason: 'source-bucket-restatement' };
  if (subject.kind === 'capability' && /\bcoordinates?\s+(?:scripts?|functions?|helpers?|files?|modules?|operations?)\b/i.test(cleaned)) {
    return { ok: false, reason: 'generic-structural-phrase' };
  }
  if (subject.kind === 'capability' &&
    (/\bthrough\s+[^.]{0,140}\b(?:handlers?|controllers?|routes?|pages?|components?|ws operations)\b/i.test(cleaned) ||
      /\bthrough\s+(?:HTTP|API)\s+endpoints?\b/i.test(cleaned) ||
      /\bacross\s+(?:pages?|routes?|handlers?|controllers?|components?)\b/i.test(cleaned) ||
      /\bacross\s+[^.]{0,120}\b(?:pages?|routes?|handlers?|controllers?|components?|connectors?)\b/i.test(cleaned) ||
      /\bmutating\s+state\s+through\s+(?:api\s+)?integrations?\b/i.test(cleaned) ||
      /\bclick events?\b|\bnavigate and interact\b|\bpages?\s+[A-Z][A-Za-z0-9 ]+\b/i.test(cleaned) ||
      /\b[A-Za-z][A-Za-z0-9 ]+\s+WS operations\b/i.test(cleaned))) {
    return { ok: false, reason: 'implementation-surface-restatement' };
  }
  if (/\b(?:manages?|supports?)\s+[A-Z][A-Za-z0-9_ ]{1,60}\s+(?:records?|operations?)\s+through\s+(?:API|HTTP)\s+endpoints?\b/i.test(cleaned)) {
    return { ok: false, reason: 'api-endpoint-restatement' };
  }
  if (subject.kind === 'capability' &&
    /\b(?:terms and conditions|legal agreements?|commercial contracts?|contractual obligations?|agreements? between systems)\b/i.test(cleaned) &&
    !/\b(?:legal|commercial|billing|subscription|customer contract|terms of service)\b/i.test([
      subject.name,
      ...(subject.relatedDomains || []),
      ...(subject.domainVocabulary || []),
    ].join(' '))) {
    return { ok: false, reason: 'unsupported-legal-contract-claim' };
  }
  if (/\b(?:internal script|script-based|script-driven|source files?|internal files?)\b/i.test(cleaned)) {
    return { ok: false, reason: 'source-bucket-restatement' };
  }

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
  if (cleaned.length < 75 &&
    /\b(?:manages?|supports?|coordinates?)\b/i.test(cleaned) &&
    /\b(?:records?|operations?|entities?|things?|items?|data)\b/i.test(cleaned)) {
    return { ok: false, reason: 'short-generic-capability-phrase' };
  }
  if (!subjectTokens.some(token => lower.includes(token))) return { ok: false, reason: 'target-not-grounded' };
  return { ok: true };
}

function isGenericAnalyzerCapabilityName(name: string): boolean {
  return /\b(?:mutation|query|handler|controller|route|page|component|command|function(?:\s+call)?|method|file|event|message|http|api|graphql|click|submit|select|input|change|hover|mouse|keyboard|keypress|keydown|keyup)\s+management\b/i.test(name || '');
}
