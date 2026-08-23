export interface ElementDescriptionSubject {
  name: string;
  kind?: string;
  relatedDomains?: string[];
  fields?: string[];

  relatedEntities?: string[];
  unrelatedEntities?: string[];







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
  '\\brecords?, lists?, or screen state\\b',
  '\\bscreen state\\b',
  '\\bworkflow state\\b',
  '\\bcurrent product context\\b',
  '\\bsurrounding product workflows?\\b',
  '\\bconfiguration support\\b',
  '\\b(?:details|information|data) (?:related|associated) (?:to|with)\\b',
  '\\bcentralizes? the coordination of [^.]{0,140}\\bscripts?\\b',
].join('|'), 'i');














const ENTITY_LEGITIMATE_STATE_PATTERN = /\b(?:state mutations?|screen state|workflow state|current product context|surrounding product workflows?|records?, lists?, or screen state)\b/gi;

const MARKETING_LANGUAGE_PATTERN = /\b(seamless(?:ly)?|robust|comprehensive|various|crucial role|plays a key role|accurate(?:ly)?|effective(?:ly)?|efficient(?:ly)?|efficiency|organized|properly|relevant|productivity|performance|compliant|compliance|advanced|modern|leverag(?:e|es|ing)|streamline(?:s|d|ing)?|user-friendly|business value|improving operational|enhanc(?:e|es|ing)|better understanding|insights(?: into)?|structured data and insights|reduces? costs?|best practices|scalable|scalability|flexibility|secure by design|user experience|strong foundation|ideal solution|best[- ]in[- ]class|state[- ]of[- ]the[- ]art|cutting[- ]edge|feature[- ]rich|decision[- ]making|collaboration|metrics?)\b/gi;

function splitGroundingSource(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function humanizeExactRelatedEntityIdentifiers(
  description: string,
  relatedEntities: readonly string[] = [],
): string {
  let result = description;
  for (const entityName of relatedEntities) {
    if (!/[a-z0-9][A-Z]|[_:$]/.test(entityName)) continue;
    const readableName = entityName
      .replace(/^entity[_:-]?/i, '')
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/[_\-./]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!readableName || readableName === entityName) continue;
    result = result.replace(new RegExp(`\\b${escapeRegExp(entityName)}\\b`, 'gi'), readableName);
  }
  return result;
}

function subjectGroundingTokens(
  subject: ElementDescriptionSubject,
  normalizeToken: (token: string) => string,
  isGenericToken: (token: string) => boolean,
): string[] {
  const semanticTokens = [
    ...splitGroundingSource(subject.name),
    ...(subject.relatedDomains || []),
    ...(subject.fields || []).map(field => field.split(':')[0]),
  ]
    .map(token => normalizeToken(token.toLowerCase()))
    .filter(token => token.length > 2 && !isGenericToken(token));
  const entityTokens = (subject.relatedEntities || [])
    .flatMap(splitGroundingSource)
    .map(token => normalizeToken(token.toLowerCase()))
    .filter(token => token.length > 2);
  return [...new Set([...semanticTokens, ...entityTokens])];
}







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

function unsupportedEnumeratedDetail(
  description: string,
  subject: ElementDescriptionSubject,
  normalizeToken: (token: string) => string,
  isGenericToken: (token: string) => boolean,
): string | undefined {
  const grounding = new Set([
    subject.name,
    ...(subject.relatedDomains || []),
    ...(subject.relatedEntities || []),
    ...(subject.fields || []),
    ...(subject.domainVocabulary || []),
  ]
    .flatMap(value => splitGroundingSource(String(value || '')))
    .map(token => normalizeToken(token))
    .filter(token => token.length >= 3 && !isGenericToken(token))
    .map(token => token.slice(0, 6)));
  if (grounding.size === 0) return undefined;

  const stop = new Set([
    'including', 'such', 'example', 'like', 'other', 'related', 'specific',
    'information', 'details', 'data', 'record', 'records', 'activity', 'activities',
  ]);
  for (const match of description.matchAll(/\b(?:details?|information|fields?|attributes?|properties|records?),?\s+(?:including|such as|for example)\s+([^.;]+)/gi)) {
    const listText = String(match[1] || '').replace(/,\s*(?:for|to|so|when|before|after|while|which|that)\b.*$/i, '');
    const items = listText.split(/\s*,\s*|\s+(?:and|or)\s+/).map(item => item.trim()).filter(Boolean);
    if (items.length < 2) continue;
    for (const item of items) {
      const claims = splitGroundingSource(item)
        .map(token => normalizeToken(token))
        .filter(token => token.length >= 4 && !stop.has(token) && !isGenericToken(token));
      if (claims.length > 0 && !claims.some(token => grounding.has(token.slice(0, 6)))) {
        return item;
      }
    }
  }
  return undefined;
}

function unrelatedEntityReference(description: string, unrelatedEntities: string[]): string | undefined {
  const singularize = (token: string): string => token.length > 4 && token.endsWith('s') && !token.endsWith('ss')
    ? token.slice(0, -1)
    : token;
  const normalizedText = ` ${splitGroundingSource(description).map(singularize).filter(token => token.length >= 3).join(' ')} `;
  return unrelatedEntities.find(entityName => {
    const phrase = splitGroundingSource(entityName).map(singularize).filter(token => token.length >= 3).join(' ');
    return (phrase.includes(' ') || phrase.length >= 5) && normalizedText.includes(` ${phrase} `);
  });
}








export function ungroundedMarketingMatches(
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
    const codeIdentifierMatches = cleaned.match(/\b[A-Za-z][a-z0-9]+[A-Z][A-Za-z0-9]*\b/g) || [];
    if (codeIdentifierMatches.length >= 2 ||
      codeIdentifierMatches.some(identifier => /(?:Service|Controller|Repository|Handler|Manager|Client|Provider)$/.test(identifier)) ||
      /\b(?:functions?|helpers?|methods?)\b/i.test(cleaned) && codeIdentifierMatches.length > 0) {
      return { ok: false, reason: 'implementation-identifier-restatement' };
    }
    if (/\b(?:data )?entit(?:y|ies)\b/i.test(cleaned)) return { ok: false, reason: 'internal-analysis-vocabulary' };
    const titleCaseInventoryItems = cleaned.match(/\b[A-Z][a-z0-9]+(?:\s+[A-Z][a-z0-9]+){1,4}\b/g) || [];
    const uniqueInventoryItems = new Set(titleCaseInventoryItems.filter(item =>
      !new RegExp(`^${escapeRegExp(subject.name)}$`, 'i').test(item) &&
      !/^(Management|Operator|Agent|User|Developer)$/.test(item)
    ));
    if (uniqueInventoryItems.size >= 5) {
      return { ok: false, reason: 'inventory-list-description' };
    }
  }
  if (subject.kind === 'capability') {
    const unrelatedEntity = unrelatedEntityReference(cleaned, subject.unrelatedEntities || []);
    if (unrelatedEntity) return { ok: false, reason: `unrelated-entity-vocabulary:${unrelatedEntity}` };
    const scaffoldReason = capabilityDescriptionScaffoldReason(cleaned, subject.name, [
      ...(subject.relatedEntities || []),
      ...(subject.relatedDomains || []),
      ...(subject.fields || []).map(field => field.split(':')[0]),
      ...(subject.domainVocabulary || []),
    ]);
    if (scaffoldReason) return { ok: false, reason: scaffoldReason };
    if (/\b(?:the|this)\s+[^.]{0,100}\bcapability\b/i.test(cleaned)) {
      return { ok: false, reason: 'internal-analysis-vocabulary' };
    }
    const unsupportedDetail = unsupportedEnumeratedDetail(cleaned, subject, normalizeToken, isGenericToken);
    if (unsupportedDetail) return { ok: false, reason: `unsupported-enumerated-detail:${unsupportedDetail}` };
  }
  if (FILLER_PHRASE_PATTERN.test(cleaned)) {
    const subjectVocabulary = [
      subject.name,
      ...(subject.relatedDomains || []),
      ...(subject.relatedEntities || []),
      ...(subject.domainVocabulary || []),
    ].join(' ');
    const withoutGroundedRuntimeBehavior = /\bruntime\b/i.test(subjectVocabulary)
      ? cleaned.replace(/\bruntime behavior\b/gi, ' ')
      : cleaned;
    const fillerCandidate = subject.kind === 'entity'
      ? withoutGroundedRuntimeBehavior.replace(ENTITY_LEGITIMATE_STATE_PATTERN, ' ')
      : withoutGroundedRuntimeBehavior;
    const fillerRemains = FILLER_PHRASE_PATTERN.test(fillerCandidate);
    if (fillerRemains) return { ok: false, reason: 'generic-structural-phrase' };
  }
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































export function capabilityDescriptionScaffoldReason(
  description: string,
  subjectName: string,
  groundingTokens: string[] = [],
): string | undefined {
  const cleaned = (description || '').trim();
  if (!cleaned) return undefined;
  if (/\b(?:capability|surface)\s+owns\b/i.test(cleaned) ||
    /\bowns the\b[^.]{0,60}\blifecycle\b/i.test(cleaned)) {
    return 'owns-lifecycle-template';
  }
  const letsScaffold = /\blets?\s+(?:the\s+)?(?:its\s+)?(?:product(?:'s)?\s+)?(?:users?|operators?|teams?|agents?|customers?|engineers?)\s+(.+)$/i.exec(cleaned);
  const directScaffold = /^(?:manages?|tracks?|coordinates?|supports?|provides?|handles?)\s+(.+)$/i.exec(cleaned);
  const scaffold = letsScaffold || directScaffold;
  if (!scaffold) return undefined;
  const scaffoldVerbs = new Set([
    'manage', 'manages', 'managing', 'track', 'tracks', 'tracking', 'view', 'views', 'viewing',
    'create', 'creates', 'creating', 'update', 'updates', 'updating', 'delete', 'deletes',
    'handle', 'handles', 'handling', 'access', 'accesses', 'accessing', 'work', 'works',
    'organize', 'organizes', 'maintain', 'maintains', 'control', 'controls', 'oversee', 'oversees',
    'record', 'records', 'data', 'information', 'items', 'lists', 'list', 'details', 'entries',
    'their', 'them', 'these', 'those', 'with', 'within', 'related', 'associated', 'relevant',
    'system', 'systems', 'product', 'products', 'application', 'operations', 'workflows',
    'activity', 'activities', 'codebase', 'codebases', 'software', 'people', 'agents',
  ]);
  const nameStems = new Set(
    splitGroundingSource(subjectName)
      .filter(token => token.length >= 3)
      .map(token => token.slice(0, 5)),
  );
  const informative = scaffold[1]
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(token =>
      token.length >= 4 &&
      !scaffoldVerbs.has(token) &&
      !nameStems.has(token.slice(0, 5)));
  if (!letsScaffold) return informative.length === 0 ? 'generic-name-restatement' : undefined;
  if (informative.length === 0) return 'lets-users-scaffold-restatement';
  if (groundingTokens.length > 0) {
    const groundedStems = new Set(
      groundingTokens
        .flatMap(value => splitGroundingSource(String(value || '')))
        .filter(token => token.length >= 3)
        .map(token => token.slice(0, 5)),
    );
    if (!informative.some(token => groundedStems.has(token.slice(0, 5)))) {
      return 'lets-users-scaffold-ungrounded';
    }
  }
  return undefined;
}

function isGenericAnalyzerCapabilityName(name: string): boolean {
  return /\b(?:mutation|query|handler|controller|route|page|component|command|function(?:\s+call)?|method|file|event|message|http|api|graphql|click|submit|select|input|change|hover|mouse|keyboard|keypress|keydown|keyup)\s+management\b/i.test(name || '');
}
