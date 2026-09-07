import type { CASEntryPoint, SystemCapability } from '../../types/cas.types';
import type { CapabilityCatalogProjectSignal } from './capability-catalog-evidence';
import { CAPABILITY_PURPOSE_VERBS } from './capability-naming';
import {
  capabilityMatchesSubjectAlias,
  canonicalOutcomeEvidenceCandidateId,
  selectMultiActionOutcomeCandidateIds,
} from './capability-outcome-evidence-selection';

import {
  humanAudience, agentAudience, coordinatedAudienceList,
  requirementAudiences, requirementAudienceLabel, audienceScopedCapabilityCatalogOutcomeText,
  capabilityMatchesAudience, capabilityMatchesBoundAudience, capabilityAudienceBindingFailure,
} from './capability-outcome-audience';
export { audienceScopedCapabilityCatalogOutcomeText } from './capability-outcome-audience';

export interface CapabilityCatalogOutcomeRequirement {
  audience?: 'agent' | 'human';
  audienceLabel?: string;
  beneficiaryAudiences?: Array<'human' | 'agent'>;
  audienceScopedOutcomeText?: string;
  candidateIds: string[];
  id: string;
  firstPartyOutcomeText?: string;
  minimumSubjectMatches?: number;
  requiredSubjectTerms?: string[];
  visibleActionTerms?: string[];
  subjectAliasAnchorTokens?: string[][];
  subjectTokenAliases?: string[][];
  statement: string;
  subjectTokens: string[];
}

export interface CapabilityCatalogOutcomeBindingFailure {
  missingAudience?: string;
  missingAudienceLocations?: Array<'description' | 'name'>;
  missingSubjectTerms: string[];
  oppositeAudienceLabels?: string[];
  oppositeAudienceLocations?: Array<'description' | 'name'>;
  reason: string;
}

function canonicalToken(token: string): string {
  const source = token.toLowerCase();
  if (/^(?:auth|authenticate|authenticated|authenticating|authentication)$/.test(source)) return 'authenticate';
  if (/^statu(?:s)?$/.test(source)) return 'status';
  let value = source.endsWith('ies') && source.length > 4
    ? `${source.slice(0, -3)}y`
    : /(?:ches|shes|sses|xes|zes)$/.test(source)
      ? source.slice(0, -2)
      : source.endsWith('ing') && source.length > 5
        ? source.slice(0, -3)
        : source.endsWith('ed') && source.length > 4
          ? source.slice(0, -2)
          : source.endsWith('s') && source.length > 4 && !/(?:sis|ss)$/.test(source)
            ? source.slice(0, -1)
            : source;
  if (/^(?:add|attach)$/.test(value)) return 'add';
  if (!CAPABILITY_PURPOSE_VERBS.has(value) && CAPABILITY_PURPOSE_VERBS.has(`${value}e`)) value = `${value}e`;
  if (/^(?:apps|jobs|maps|tags)$/.test(value)) value = value.slice(0, -1);

  if (/^(?:compreh|explain|explor|inspect|understand)/.test(value)) return 'understand';
  if (/^(?:adopt|onboard|orient)/.test(value)) return 'onboard';
  if (/^(?:break|risk)/.test(value)) return 'risk';
  if (/^(?:test|validat|verify)/.test(value)) return 'verify';
  if (/^(?:collid|duplicat|overlap)/.test(value)) return 'collaborate';
  if (/^(?:accur|reliab|trust)/.test(value)) return 'trust';
  if (value === 'mapp') return 'mapping';
  if (/^(?:collabor|coordin)/.test(value)) return 'collaborate';
  if (/^(?:connect|relation)/.test(value)) return 'relation';
  if (/^(?:code|codebase|source|software)$/.test(value)) return 'software';
  if (/^extract(?:or|ion)?$/.test(value)) return 'extract';
  if (/^(?:event|observ|runtime|telemetry)/.test(value)) return value.startsWith('runtime') ? 'runtime' : 'telemetry';
  return value;
}

export function canonicalCapabilityCatalogOutcomeToken(token: string): string {
  return canonicalToken(token);
}

function comparableEvidenceToken(token: string): string {
  const canonical = canonicalToken(token);
  return /^(?:browse|fetch|find|get|list|load|read|retrieve|show|view)$/.test(canonical) ? 'view' : canonical;
}

const outcomeTokenStopwords = new Set([
  'all', 'also', 'and', 'any', 'are', 'but', 'can', 'each', 'for', 'had', 'has', 'have', 'how', 'its', 'may', 'not', 'our',
  'per', 'than', 'that', 'the', 'their', 'then', 'this', 'through', 'under', 'using', 'was', 'were', 'what', 'when', 'where',
  'which', 'who', 'why', 'will', 'with', 'without', 'you', 'your',
]);

function tokens(value: string, omitAudience = false): string[] {
  const source = omitAudience
    ? String(value || '').replace(humanAudience, ' ').replace(agentAudience, ' ')
      .replace(/\b(?:(?:support|operations?|engineering|development)\s+)?(?:staff|teams?|operators?|engineers?|developers?)\b/gi, ' ')
    : String(value || '');
  return [...new Set(source
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(token => token.length >= 3)
    .map(canonicalToken)
    .filter(token => token.length >= 3 && !outcomeTokenStopwords.has(token)))];
}

function candidateText(candidate: SystemCapability): string {
  return [
    candidate.name,
    candidate.structural_label,
    ...(candidate.related_domains || []),
    ...(candidate.related_entities || []),
    ...(candidate.evidence_examples || []),
    ...(candidate.operations || []).flatMap(operation => [operation.action, operation.path_or_command]),
  ].filter(Boolean).join(' ');
}

function candidateAggregationRank(candidate: SystemCapability): number {
  if (candidate.evidence_kind === 'behavior-surface') return 2;
  return (candidate.operations || []).length > 1 ? 0 : 1;
}

function purposeVerbIndex(words: readonly string[]): number {
  return words.findIndex((word, index) => {
    const token = canonicalToken(word);
    if (!CAPABILITY_PURPOSE_VERBS.has(token)) return false;
    if (token === 'support' && /^(?:staff|team|teams|engineers?|operators?|agents?)$/i.test(words[index + 1] || '')) return false;
    return index === 0 || !/^[A-Z]/.test(word);
  });
}

function purposeVerbIn(value: string): boolean {
  return purposeVerbIndex(value.match(/[A-Za-z][A-Za-z'-]*/g) || []) >= 0;
}

function splitCoordinatedClause(value: string): string[] {
  const boundaries = [...value.matchAll(/\s*,\s*(?:and\s+)?|\s+and\s+/gi)];
  const boundary = boundaries.find(match => {
    const index = match.index || 0;
    const left = value.slice(0, index).trim();
    const right = value.slice(index + match[0].length).trim();
    const leftWords = left.split(/\s+/);
    const rightWords = right.match(/[A-Za-z][A-Za-z'-]*/g) || [];
    const rightHead = (rightWords[0] || '').toLowerCase() === 'then' ? rightWords[1] || '' : rightWords[0] || '';
    return leftWords.length >= 3 && rightWords.length >= 3 &&
      purposeVerbIn(left) && CAPABILITY_PURPOSE_VERBS.has(canonicalToken(rightHead)) &&
      !/ing$/i.test(rightHead);
  });
  if (!boundary) return [value];
  const index = boundary.index || 0;
  return [value.slice(0, index), ...splitCoordinatedClause(value.slice(index + boundary[0].length))];
}

function productClauses(signal?: CapabilityCatalogProjectSignal): string[] {
  const declared = signal?.productDocStatements?.filter(statement => statement.role === 'feature') || [];
  const source = declared.length > 0 ? declared.map(statement => `Feature: ${statement.value}`).join(' ') : signal?.productDocSummary || signal?.manifestDescription;
  const sentences = [source]
    .filter((value): value is string => Boolean(value))
    .flatMap(value => value.split(/(?<=[.!?;])\s+/i))
    .map(value => value.trim())
    .filter(Boolean);
  const grouped: string[] = [];
  const sourceSentences = sentences.filter(sentence => !/^(?:Context|Example):\s*/i.test(sentence));
  let activeFeatureIndex = -1;
  for (const sentence of sourceSentences) {
    const separator = sentence.indexOf(':');
    const heading = separator >= 0 ? sentence.slice(0, separator).trim() : '';
    const body = separator >= 0 ? sentence.slice(separator + 1).trim() : '';
    const featureHeading = /^Feature$/i.test(heading) ||
      (heading.length > 0 && heading.split(/\s+/).length <= 6 && purposeVerbIn(body));
    const pluralFeatureHeading = /^(?:(?:key\s+|high(?:-|\s+)level\s+)?(?:features?|capabilities|functionality|use cases?))$/i.test(heading);
    if (pluralFeatureHeading && body) {
      grouped.push(`Feature: ${body}`);
      activeFeatureIndex = -1;
    } else if (featureHeading) {
      grouped.push(sentence);
      activeFeatureIndex = grouped.length - 1;
    } else if (activeFeatureIndex >= 0) {
      grouped[activeFeatureIndex] = `${grouped[activeFeatureIndex]} ${sentence}`;
    } else {
      grouped.push(sentence);
    }
  }
  return grouped
    .flatMap(value => /^Feature:\s*/i.test(value) ? [value] : splitCoordinatedClause(value))
    .map(value => value.trim()
      .replace(/^[,;]\s*/, '').replace(/[.!?]+$/, ''))
    .filter(value => value.length >= 20 && !/^[^,.:;!?]+?\s+(?:is|are)\s+(?:an?\s+|the\s+)?[^,.]+$/i.test(value));
}

function outcomeClauseBody(clause: string): string {
  const authored = clause.replace(/^Feature:\s*/i, '').trim();
  const enabledAction = authored.match(/\b(?:allows?|enables?)\s+you\s+to\s+(.+?)(?:\s+Here are some examples.*)?$/i);
  if (enabledAction && /\bchatbot\b/i.test(authored) && /^interact\b/i.test(enabledAction[1])) {
    return 'Ask questions in natural language through the chatbot';
  }
  if (enabledAction) return enabledAction[1].replace(/\bin a natural language\b/i, 'in natural language');
  const politeAction = authored.match(/^please\s+((?:add|browse|create|find|get|list|search|show|view)\b.+)$/i);
  if (politeAction) return politeAction[1];
  const existenceQuestion = authored.match(/^(?:are there any|is there (?:an?|the))\s+(.+)$/i);
  if (existenceQuestion) return `Find ${existenceQuestion[1]}`;
  const whichQuestion = authored.match(/^which\s+(.+?)\s+have\s+(.+)$/i);
  if (whichQuestion) return `Find ${whichQuestion[1]} with ${whichQuestion[2]}`;
  const illustratedCollection = authored.match(/^(?:an?\s+)?collection of (.+?) that (?:illustrate|demonstrate|show) (.+)$/i);
  if (illustratedCollection) {
    const lesson = illustratedCollection[2].replace(/^best practices for (.+)$/i, '$1 best practices');
    return `Learn ${lesson} from ${illustratedCollection[1]}`;
  }
  const demonstratedLesson = authored.match(/\b(?:to|that)\s+(?:demonstrate|illustrate|show)s?\s+how\s+to\s+(.+)$/i);
  if (demonstratedLesson) return `Learn how to ${demonstratedLesson[1]}`;
  const separator = authored.indexOf(':');
  if (separator < 0) return authored;
  const body = authored.slice(separator + 1).trim();
  return purposeVerbIn(body) ? body : authored;
}

function authoredFeatureLabel(clause: string): string | undefined {
  const explicitFeature = clause.match(/^Feature:\s*(.+)$/i)?.[1]?.trim();
  if (explicitFeature && !/^(?:are|can|could|do|does|how|is|please|what|when|where|which|who|why)\b/i.test(explicitFeature) &&
      !explicitFeature.includes(':') && !explicitFeature.includes('—') &&
      !explicitFeature.includes('–') && !/ +-- +/.test(explicitFeature) && explicitFeature.split(/ +/).length <= 14) {
    return explicitFeature;
  }
  const label = (explicitFeature || clause).match(/^(.{3,80}?) +[—–-] +/)?.[1]?.trim();
  if (!label) return undefined;
  const firstToken = canonicalToken(label.match(/[A-Za-z][A-Za-z'-]*/)?.[0] || '');
  return CAPABILITY_PURPOSE_VERBS.has(firstToken) ? label : undefined;
}

function conciseOutcomeStatement(clause: string, subjectTokens: ReadonlySet<string>): string {
  const words = String(clause || '')
    .replace(humanAudience, ' ')
    .replace(agentAudience, ' ')
    .trim()
    .split(/\s+/);
  const actionIndex = purposeVerbIndex(words.map(word =>
    (word.match(/[A-Za-z][A-Za-z'-]*/)?.[0]) || '',
  ));
  const matchingIndexes = words.flatMap((word, index) =>
    tokens(word).some(token => subjectTokens.has(token)) ? [index] : []);
  if (matchingIndexes.length === 0) return '';
  const first = actionIndex >= 0 ? actionIndex : matchingIndexes[0];
  const last = actionIndex >= 0 ? words.length - 1 : matchingIndexes[matchingIndexes.length - 1];
  return words.slice(Math.min(first, last), last + 1)
    .join(' ')
    .replace(/\s+(?:for|to|by)\s+(?:and\s+)?(?:ai\s*)?$/i, '')
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/gi, '');
}

export function capabilityCatalogTargetedOutcomeText(requirement: CapabilityCatalogOutcomeRequirement): string | undefined {
  const raw = String(requirement.firstPartyOutcomeText || '').trim();
  if (!raw) return undefined;
  if (!requirement.audience || !humanAudience.test(raw) || !agentAudience.test(raw)) return raw;
  return requirement.audienceScopedOutcomeText || audienceScopedCapabilityCatalogOutcomeText(raw, requirement.audience, requirement.audienceLabel);
}

function requirementId(audience: string | undefined, subjectTokens: readonly string[]): string {
  return `${audience || 'all'}:${subjectTokens.slice().sort().join('-')}`;
}

function clauseVisibleActionTerms(clause: string, statement: string): string[] {
  const words = String(clause || '').match(/[A-Za-z][A-Za-z'-]*/g) || [];
  const leadingWord = words[0] || '';
  const action = purposeVerbIndex(words) === 0 &&
    !(canonicalToken(leadingWord) === 'support' && /^(?:staff|team|teams|engineers?|operators?|agents?)$/i.test(words[1] || ''))
    ? canonicalToken(leadingWord)
    : undefined;
  if (action && !/^(?:handle|manage|process)$/.test(action)) return [action];
  const statementLeading = canonicalToken((String(statement || '').match(/[A-Za-z][A-Za-z'-]*/)?.[0]) || '');
  return CAPABILITY_PURPOSE_VERBS.has(statementLeading) && !/^(?:handle|manage|process)$/.test(statementLeading)
    ? [statementLeading]
    : [];
}

export function deriveCapabilityCatalogOutcomeRequirements(
  signal: CapabilityCatalogProjectSignal | undefined,
  candidates: readonly SystemCapability[],
  context: { entryPoints?: readonly CASEntryPoint[] } = {},
): CapabilityCatalogOutcomeRequirement[] {
  const entryById = new Map((context.entryPoints || []).map(entry => [entry.id, entry]));
  const contextualProductClauses = String(signal?.productDocSummary || '')
    .split(/(?<=[.!?;])\s+/i)
    .map(value => value.trim())
    .filter(value => /^Context:\s*/i.test(value));
  const genericContextAnchors = new Set([
    'app', 'application', 'component', 'core', 'handler', 'management', 'module', 'operation',
    'repository', 'route', 'service', 'system', 'workflow',
  ]);
  const candidateTokens = candidates.filter(candidate => candidate.evidence_role !== 'verification-harness').map(candidate => {
    const entries = candidate.operations.flatMap(operation => {
      const entry = entryById.get(operation.entry_point_id);
      return entry ? [entry] : [];
    });
    const text = [candidateText(candidate), ...entries.flatMap(entry => [entry.name, entry.description || ''])].join(' ');
    const rawTokens = tokens(text, true);
    const identityRawTokens = tokens([
      candidate.name,
      candidate.structural_label,
      ...(candidate.related_domains || []),
    ].filter(Boolean).join(' '), true);
    const symbolRawTokens = tokens(entries.map(entry => entry.name).join(' '), true);
    const contextAnchorTokens = identityRawTokens.filter(token => !genericContextAnchors.has(token));
    const contextualAliasTokens = contextualProductClauses.flatMap(clause => {
      const clauseTokens = tokens(clause.replace(/^Context:\s*/i, ''), true);
      const anchorsContext = contextAnchorTokens.some(anchor => clauseTokens.some(token =>
        token === anchor || (Math.min(token.length, anchor.length) >= 3 && (token.startsWith(anchor) || anchor.startsWith(token)))));
      return anchorsContext
        ? clauseTokens.filter(token => !genericContextAnchors.has(token) && !CAPABILITY_PURPOSE_VERBS.has(token))
        : [];
    });
    return {
      candidate,
      observedRank: entries.some(entry => entry.interaction_reach === 'external') ? 0
        : entries.some(entry => entry.interaction_reach !== 'internal') ? 1 : entries.length > 0 ? 2 : 3,
      text,
      tokens: new Set([
        ...rawTokens,
        ...symbolRawTokens,
        ...contextualAliasTokens,
        ...rawTokens.map(comparableEvidenceToken),
        ...symbolRawTokens.map(comparableEvidenceToken),
        ...contextualAliasTokens.map(comparableEvidenceToken),
      ]),
      identityTokens: new Set([...identityRawTokens, ...identityRawTokens.map(comparableEvidenceToken)]),
      symbolTokens: new Set([...symbolRawTokens, ...symbolRawTokens.map(comparableEvidenceToken)]),
    };
  });
  const requirements = new Map<string, CapabilityCatalogOutcomeRequirement>();
  const subjectStopwords = new Set(['also', 'different', 'easier', 'extra', 'faster', 'feature', 'seamlessly', 'that', 'their', 'this', 'using', 'with', 'your']);
  for (const firstPartyClause of productClauses(signal)) {
    const clause = outcomeClauseBody(firstPartyClause);
    const explicitAuthoredFeature = /^Feature: */i.test(firstPartyClause);
    const clauseTokens = tokens(clause, true);
    const subjectTokens = clauseTokens.filter(token => !subjectStopwords.has(token));
    const scoringSubjectTokens = subjectTokens.filter(token => !/^(?:add|change|close|create|delete|edit|get|handle|list|manage|process|read|remove|update|view)$/.test(token));
    const multiActionFeature = String(clause || '')
      .split(/(?<=[.!?;])\s+/i)
      .filter(sentence => purposeVerbIn(sentence)).length > 1;
    if (subjectTokens.length === 0) continue;
    for (const audience of requirementAudiences(clause)) {
      const audienceCandidates = candidateTokens.filter(item => !audience || (audience === 'human'
        ? !agentAudience.test(item.text) || humanAudience.test(item.text)
        : !humanAudience.test(item.text) || agentAudience.test(item.text)));
      const scoringTokenFrequency = new Map(scoringSubjectTokens.map(token => [token,
        audienceCandidates.filter(item => item.tokens.has(comparableEvidenceToken(token))).length]));
      const scored = audienceCandidates.map(item => ({
        id: item.candidate.id,
        observedRank: item.observedRank,
        evidenceRank: item.candidate.evidence_role === 'product-outcome' ? 0
          : item.candidate.evidence_role === 'unresolved' || item.candidate.evidence_role === undefined ? 1 : 2,
        aggregateRank: candidateAggregationRank(item.candidate),
        score: scoringSubjectTokens.filter(token => item.tokens.has(comparableEvidenceToken(token))).length,
        matchedSubjectTokens: subjectTokens.filter(token => item.tokens.has(comparableEvidenceToken(token))),
        identityScore: scoringSubjectTokens.filter(token => item.identityTokens.has(comparableEvidenceToken(token))).length,
        symbolScore: scoringSubjectTokens.filter(token => item.symbolTokens.has(comparableEvidenceToken(token))).length,
        distinctive: scoringSubjectTokens.some(token => item.tokens.has(comparableEvidenceToken(token)) && scoringTokenFrequency.get(token) === 1),
      })).filter(item => item.id && scoringSubjectTokens.length > 0 && (
        item.score >= Math.min(2, scoringSubjectTokens.length) ||
        item.identityScore > 0 ||
        item.symbolScore > 0 ||
        (item.score >= 1 && (item.evidenceRank === 0 || item.distinctive))
      )).sort((left, right) => left.observedRank - right.observedRank ||
        right.symbolScore - left.symbolScore || right.identityScore - left.identityScore ||
        right.score - left.score ||
        left.evidenceRank - right.evidenceRank ||
        left.aggregateRank - right.aggregateRank ||
        left.id.localeCompare(right.id));
      const ranked = scored;
      const bestObservedRank = ranked[0]?.observedRank;
      const bestIdentityScore = ranked[0]?.identityScore;
      const bestScore = ranked[0]?.score;
      const bestSymbolScore = ranked[0]?.symbolScore;
      const strongestCandidateIds = bestScore === undefined ? [] : ranked
        .filter(item => item.observedRank === bestObservedRank && item.identityScore === bestIdentityScore && item.symbolScore === bestSymbolScore && item.score === bestScore)
        .slice(0, 3)
        .map(item => item.id);
      const candidateIds = multiActionFeature
        ? selectMultiActionOutcomeCandidateIds(clause, audienceCandidates.map(item => ({
          ...item,
          aggregateRank: candidateAggregationRank(item.candidate),
          evidenceRank: item.candidate.evidence_role === 'product-outcome' ? 0
            : item.candidate.evidence_role === 'unresolved' || item.candidate.evidence_role === undefined ? 1 : 2,
          id: item.candidate.id,
        })), value => tokens(value, true).map(comparableEvidenceToken), token => CAPABILITY_PURPOSE_VERBS.has(token))
        : strongestCandidateIds;
      const candidateIdSet = new Set(candidateIds);
      const groundedSubjectTokens = candidateIds.length > 0
        ? subjectTokens.filter(token => candidateTokens.some(item =>
          candidateIdSet.has(canonicalOutcomeEvidenceCandidateId(item.candidate.id)) && item.tokens.has(comparableEvidenceToken(token))))
        : subjectTokens.slice(0, 8);
      if (!explicitAuthoredFeature && groundedSubjectTokens.length > 0 && groundedSubjectTokens.every(token => CAPABILITY_PURPOSE_VERBS.has(token))) continue;
      const originalClauseAlias = clauseTokens
        .filter(token => audienceCandidates.some(item =>
          candidateIdSet.has(canonicalOutcomeEvidenceCandidateId(item.candidate.id)) && item.tokens.has(token)))
        .slice(0, 8);
      const recoveredAliasTokens = originalClauseAlias.filter(token => !groundedSubjectTokens.includes(token));
      const aliasAnchor = recoveredAliasTokens.slice().sort((left, right) => {
        const occurrences = (token: string) => audienceCandidates.filter(item => item.tokens.has(token)).length;
        return occurrences(left) - occurrences(right) || right.length - left.length || left.localeCompare(right);
      })[0];
      const subjectTokenAliases = originalClauseAlias.some(token => groundedSubjectTokens.includes(token)) && aliasAnchor ? [originalClauseAlias] : undefined;
      const statement = authoredFeatureLabel(firstPartyClause) || conciseOutcomeStatement(clause, new Set(groundedSubjectTokens));
      const audienceLabel = requirementAudienceLabel(clause, audience);
      const audienceScopedOutcomeText = audienceScopedCapabilityCatalogOutcomeText(clause, audience, audienceLabel);
      const visibleActionTerms = clauseVisibleActionTerms(statement, statement);
      const statementWords = statement.match(/[A-Za-z][A-Za-z'-]*/g) || [];
      if (!explicitAuthoredFeature && visibleActionTerms.length === 0 && purposeVerbIndex(statementWords) !== 0) continue;
      const id = requirementId(audience, [...new Set([...visibleActionTerms, ...groundedSubjectTokens])]);
      if (candidateIds.length === 0 && visibleActionTerms.length === 0) continue;
      requirements.set(id, {
        audience,
        audienceLabel,
        ...(!audience && coordinatedAudienceList.test(clause) ? { beneficiaryAudiences: ['human', 'agent'] as Array<'human' | 'agent'> } : {}),
        ...(audienceScopedOutcomeText ? { audienceScopedOutcomeText } : {}),
        candidateIds,
        firstPartyOutcomeText: firstPartyClause.replace(/^Feature: */i, ''),
        id,
        minimumSubjectMatches: Math.min(2, groundedSubjectTokens.length),
        requiredSubjectTerms: groundedSubjectTokens,
        visibleActionTerms,
        ...(subjectTokenAliases && aliasAnchor ? { subjectAliasAnchorTokens: [[aliasAnchor]] } : {}),
        ...(subjectTokenAliases ? { subjectTokenAliases } : {}),
        statement,
        subjectTokens: groundedSubjectTokens,
      });
    }
  }
  const ordered = [...requirements.values()];
  const redundantRequirementIds = new Set<string>();
  for (const requirement of ordered) {
    if (requirement.firstPartyOutcomeText?.includes(':')) continue;
    const detailed = ordered.find(candidate => {
      if (candidate.id === requirement.id ||
          (!candidate.firstPartyOutcomeText?.includes(':') && !/\bby\b/i.test(candidate.firstPartyOutcomeText || '')) ||
          candidate.audience !== requirement.audience ||
          !(candidate.visibleActionTerms || []).some(action => requirement.visibleActionTerms?.includes(action))) return false;
      const requirementTextSubjects = tokens(
        outcomeClauseBody(requirement.firstPartyOutcomeText || requirement.statement), true,
      ).filter(token => !subjectStopwords.has(token));
      const candidateTextSubjects = new Set(tokens(
        outcomeClauseBody(candidate.firstPartyOutcomeText || candidate.statement), true,
      ).filter(token => !subjectStopwords.has(token)));
      const sharedSubjects = requirementTextSubjects.filter(token => candidateTextSubjects.has(token));
      return sharedSubjects.length >= Math.min(2, requirementTextSubjects.length);
    });
    if (!detailed) continue;
    detailed.candidateIds = [...new Set([...detailed.candidateIds, ...requirement.candidateIds])];
    redundantRequirementIds.add(requirement.id);
  }
  return ordered.filter(requirement => !redundantRequirementIds.has(requirement.id));
}


export function recoverGroundedAuthoredOutcomeCapabilities(
  capabilities: readonly SystemCapability[],
  requirements: readonly CapabilityCatalogOutcomeRequirement[],
  evidenceCandidates: readonly SystemCapability[],
  _obligationScopes: ReadonlyMap<string, { parentCandidateId: string }> = new Map(),
  preferredCapabilities: readonly SystemCapability[] = [],
): SystemCapability[] {
  const evidenceById = new Map(evidenceCandidates.map(candidate => [candidate.id, candidate]));
  const isAuthored = (capability: SystemCapability): boolean =>
    ['ai', 'manual', 'reused'].includes(String(capability.description_source || ''));
  const recoverable = preferredCapabilities.filter(capability => {
    const factors = capability.criticality_factors || [];
    if (!isAuthored(capability) || factors.includes('catalog-grounded-authored-outcome-recovery')) return false;
    const cited = factors.filter(factor => factor.startsWith('catalog-candidate:'))
      .map(factor => factor.slice('catalog-candidate:'.length));
    if (cited.length === 0 || cited.some(id => !evidenceById.has(id))) return false;
    const observedEntries = new Set(cited.flatMap(id => (evidenceById.get(id)?.operations || []).map(operation => operation.entry_point_id)));
    if (capability.operations.length === 0 || capability.operations.some(operation => !observedEntries.has(operation.entry_point_id))) return false;
    return requirements.some(requirement =>
      cited.some(id => requirement.candidateIds.includes(id)) &&
      capabilitySemanticallySatisfiesCatalogOutcomeRequirement(capability, requirement));
  });
  const byId = new Map<string, SystemCapability>();
  for (const capability of [...capabilities, ...recoverable]) {
    const existing = byId.get(capability.id);
    const authored = isAuthored(capability);
    const existingAuthored = existing && isAuthored(existing);
    if (!existing || (authored && !existingAuthored) ||
      (authored === existingAuthored && capability.description.length > existing.description.length)) {
      byId.set(capability.id, capability);
    }
  }
  return [...byId.values()];
}
export function capabilitySatisfiesCatalogOutcomeRequirement(
  capability: Pick<SystemCapability, 'name' | 'description'> & Partial<Pick<SystemCapability, 'criticality_factors'>>,
  requirement: CapabilityCatalogOutcomeRequirement,
): boolean {
  if (capability.criticality_factors?.includes(`catalog-outcome-requirement:${requirement.id}`)) {
    return capabilityMatchesBoundAudience(capability, requirement);
  }
  return capabilitySemanticallySatisfiesCatalogOutcomeRequirement(capability, requirement);
}

export function capabilitySemanticallySatisfiesCatalogOutcomeRequirement(
  capability: Pick<SystemCapability, 'name' | 'description'>,
  requirement: CapabilityCatalogOutcomeRequirement,
): boolean {
  const capabilityText = `${capability.name || ''} ${capability.description || ''}`;
  if (!capabilityMatchesBoundAudience(capability, requirement)) return false;
  return capabilityTextMatchesCatalogOutcomeRequirement(capabilityText, requirement);
}

export function capabilityPotentiallySatisfiesCatalogOutcomeRequirement(
  capability: Pick<SystemCapability, 'name' | 'description'>,
  requirement: CapabilityCatalogOutcomeRequirement,
): boolean {
  const capabilityText = `${capability.name || ''} ${capability.description || ''}`;
  if (!capabilityMatchesAudience(capabilityText, requirement.audience)) return false;
  return capabilityTextMatchesCatalogOutcomeRequirement(capabilityText, requirement);
}

function capabilityTextMatchesCatalogOutcomeRequirement(
  capabilityText: string,
  requirement: CapabilityCatalogOutcomeRequirement,
): boolean {
  const capabilityTokens = new Set(tokens(capabilityText));
  const requiredTerms = (requirement.requiredSubjectTerms || requirement.subjectTokens).map(canonicalToken);
  const requiredMatches = requirement.minimumSubjectMatches ?? Math.min(2, requiredTerms.length);
  if (requiredTerms.filter(token => capabilityTokens.has(token)).length >= requiredMatches) return true;
  return capabilityMatchesSubjectAlias(capabilityTokens, requiredTerms, requirement.subjectTokenAliases, requirement.subjectAliasAnchorTokens);
}

export function capabilityCatalogOutcomeNameFailure(
  name: string,
  requirement: CapabilityCatalogOutcomeRequirement,
): string | undefined {
  const orderedNameTokens = tokens(name);
  if (/\byou\s+can\b/i.test(name) || /[,;]/.test(name)) {
    return `required-outcome-title-not-concise:${requirement.id}`;
  }
  const leading = orderedNameTokens[0];
  const rawLeading = String(name || '').toLowerCase().match(/[a-z][a-z0-9]*/)?.[0] || '';
  const canonicalLeading = canonicalToken(rawLeading);
  const recoveredAnchors = [...new Set((requirement.subjectAliasAnchorTokens || []).flat().map(canonicalToken))];
  const subjectTerms = new Set((requirement.requiredSubjectTerms || requirement.subjectTokens).map(canonicalToken));
  const actionStem = rawLeading.replace(/(?:ing|ed|es|s)$/, '');
  const actionHeaded = CAPABILITY_PURPOSE_VERBS.has(canonicalLeading) ||
    CAPABILITY_PURPOSE_VERBS.has(leading || '') ||
    CAPABILITY_PURPOSE_VERBS.has(rawLeading) ||
    CAPABILITY_PURPOSE_VERBS.has(actionStem);
  const requiredAction = new Set((requirement.visibleActionTerms || []).map(canonicalToken));
  const multiActionFeature = String(requirement.firstPartyOutcomeText || '')
    .split(/(?<=[.!?;])\s+/i)
    .filter(sentence => purposeVerbIn(sentence)).length > 1;
  if (!multiActionFeature && requiredAction.size > 0 && !requiredAction.has(canonicalLeading)) return `required-outcome-visible-action-missing:${requirement.id}`;
  if (leading && subjectTerms.has(leading) && !actionHeaded && recoveredAnchors.length > 0 && !recoveredAnchors.some(anchor => orderedNameTokens.includes(anchor))) {
    return `required-outcome-visible-action-missing:${requirement.id}`;
  }
  return undefined;
}

export function conciseCapabilityCatalogOutcomeName(
  name: string,
  supportingText: string,
): string {
  const normalized = String(name || '').replace(/\s+/g, ' ').trim();
  const procedural = normalized.match(/^(.+?)\s+by\s+(.+)$/i);
  if (procedural && purposeVerbIn(procedural[1])) {
    const detailActions = [...new Set(tokens(procedural[2]).filter(token => CAPABILITY_PURPOSE_VERBS.has(token)))];
    const supportingTokens = new Set(tokens(supportingText));
    if (detailActions.length >= 2 && detailActions.every(action => supportingTokens.has(action))) {
      return procedural[1].trim();
    }
  }
  const transition = normalized.match(/^((?:change|update|set|transition|move)\b.+?)\s+(?:to|as|between)\s+(.+[,;].+)$/i);
  if (!transition) return normalized;
  const detailTokens = transition[2]
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(token => token.length >= 3 && !/^(?:and|the|with)$/.test(token))
    .map(canonicalCapabilityCatalogOutcomeToken);
  const supportingTokens = new Set(String(supportingText || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map(canonicalCapabilityCatalogOutcomeToken));
  if (detailTokens.length < 2 || !detailTokens.every(token => supportingTokens.has(token))) return normalized;
  return transition[1].trim();
}
export function sanitizeCapabilityCatalogDescription(description: string): string {
  return String(description || '')
    .replace(/\s+(?:through|using|via)\s+(?:the\s+)?[^.,;]{0,80}\b(?:api|apis|routes?|endpoints?|operations?|controllers?)\b[^.,;]*/gi, '')
    .replace(/\b[a-z]+:\/[^\s.]*/gi, '')
    .replace(/\bretain full of (?=(?:their|the)\b)/gi, 'retain full control of ')
    .replace(/\s+/g, ' ')
    .trim();
}


export function capabilityCandidateCorroboratesCatalogOutcomeRequirement(
  candidate: SystemCapability,
  requirement: CapabilityCatalogOutcomeRequirement,
): boolean {
  if (candidate.evidence_role === 'verification-harness') return false;
  const text = candidateText(candidate);
  if (requirement.audience === 'human' && agentAudience.test(text) && !humanAudience.test(text)) return false;
  if (requirement.audience === 'agent' && humanAudience.test(text) && !agentAudience.test(text)) return false;
  const candidateTokens = new Set(tokens(text, true));
  const requiredTerms = requirement.requiredSubjectTerms || requirement.subjectTokens;
  const requiredMatches = requirement.minimumSubjectMatches ?? Math.min(2, requiredTerms.length);
  return requiredTerms.filter(token => candidateTokens.has(canonicalToken(token))).length >= requiredMatches;
}

function capabilityActionMatchesCatalogOutcomeRequirement(
  capability: Pick<SystemCapability, 'name'>,
  requirement: CapabilityCatalogOutcomeRequirement,
): boolean {
  const requiredActions = (requirement.visibleActionTerms || []).map(canonicalToken);
  if (requiredActions.length === 0) return false;
  const multiActionFeature = String(requirement.firstPartyOutcomeText || '')
    .split(/(?<=[.!?;])\s+/i)
    .filter(sentence => purposeVerbIn(sentence)).length > 1;
  if (multiActionFeature) return true;
  const leadingAction = canonicalToken((String(capability.name || '').match(/[A-Za-z][A-Za-z'-]*/)?.[0]) || '');
  return requiredActions.includes(leadingAction);
}

export function bindUniquelySatisfiedCatalogOutcomeRequirements(
  capabilities: readonly SystemCapability[],
  requirements: readonly CapabilityCatalogOutcomeRequirement[],
): SystemCapability[] {
  const factors = (capability: SystemCapability, prefix: string) => (capability.criticality_factors || [])
    .filter(value => value.startsWith(prefix)).map(value => value.slice(prefix.length));
  const matches = requirements.map(requirement => capabilities.flatMap((capability, index) => {
    if (factors(capability, 'catalog-outcome-requirement:').length > 0) return [];
    const citedCandidates = factors(capability, 'catalog-candidate:');
    return citedCandidates.some(candidateId => requirement.candidateIds.includes(candidateId)) &&
      capabilitySatisfiesCatalogOutcomeRequirement(capability, requirement) ? [index] : [];
  }));
  const requirementIndexesByCapability = new Map<number, number[]>();
  matches.forEach((capabilityIndexes, requirementIndex) => capabilityIndexes.forEach(capabilityIndex => {
    requirementIndexesByCapability.set(capabilityIndex, [
      ...(requirementIndexesByCapability.get(capabilityIndex) || []),
      requirementIndex,
    ]);
  }));
  for (const [capabilityIndex, requirementIndexes] of requirementIndexesByCapability) {
    if (requirementIndexes.length < 2) continue;
    const actionMatches = requirementIndexes.filter(requirementIndex =>
      capabilityActionMatchesCatalogOutcomeRequirement(capabilities[capabilityIndex], requirements[requirementIndex]));
    if (actionMatches.length === 0 || actionMatches.length === requirementIndexes.length) continue;
    const preferred = new Set(actionMatches);
    matches.forEach((capabilityIndexes, requirementIndex) => {
      if (!preferred.has(requirementIndex)) matches[requirementIndex] = capabilityIndexes.filter(index => index !== capabilityIndex);
    });
  }
  const requirementMatchesByCapability = new Map<number, number[]>();
  matches.forEach((capabilityIndexes, requirementIndex) => capabilityIndexes.forEach(capabilityIndex => {
    const requirementIndexes = requirementMatchesByCapability.get(capabilityIndex) || [];
    requirementIndexes.push(requirementIndex);
    requirementMatchesByCapability.set(capabilityIndex, requirementIndexes);
  }));
  const bindings = new Map<number, string>();
  matches.forEach((capabilityIndexes, requirementIndex) => {
    if (capabilityIndexes.length !== 1 || requirementMatchesByCapability.get(capabilityIndexes[0])?.length !== 1) return;
    bindings.set(capabilityIndexes[0], requirements[requirementIndex].id);
  });
  return capabilities.map((capability, index) => {
    const requirementId = bindings.get(index);
    if (!requirementId) return capability;
    return { ...capability, criticality_factors: [...new Set([...(capability.criticality_factors || []), `catalog-outcome-requirement:${requirementId}`])] };
  });
}

export function bindAtomicallySatisfiedCatalogOutcomeRequirements(
  capabilities: readonly SystemCapability[],
  requirements: readonly CapabilityCatalogOutcomeRequirement[],
  fullyCoveredAggregateCandidateIds: ReadonlySet<string>,
  obligationScopes: ReadonlyMap<string, { parentCandidateId: string }>,
  eligibleCapabilities: readonly SystemCapability[] = capabilities,
): SystemCapability[] {
  const result = capabilities.map(capability => ({ ...capability, criticality_factors: [...(capability.criticality_factors || [])] }));
  const eligibleCapabilityIds = new Set(eligibleCapabilities.map(capability => capability.id));
  const citedObligationIds = new Set(eligibleCapabilities.flatMap(capability =>
    (capability.criticality_factors || []).filter(factor => factor.startsWith('catalog-operation-obligation:'))
      .map(factor => factor.slice('catalog-operation-obligation:'.length))));
  const obligationIdsByParent = new Map<string, string[]>();
  for (const [id, scope] of obligationScopes) {
    obligationIdsByParent.set(scope.parentCandidateId, [...(obligationIdsByParent.get(scope.parentCandidateId) || []), id]);
  }
  for (const requirement of requirements) {
    const coveredParents = requirement.candidateIds.filter(candidateId => {
      const obligationIds = obligationIdsByParent.get(candidateId) || [];
      return fullyCoveredAggregateCandidateIds.has(candidateId) || (obligationIds.length > 0 && obligationIds.every(id => citedObligationIds.has(id)));
    });
    if (coveredParents.length === 0) continue;
    const representedParents = new Set<string>();
    result
      .filter(capability => eligibleCapabilityIds.has(capability.id) && (capability.criticality_factors || []).includes(`catalog-outcome-requirement:${requirement.id}`))
      .forEach(capability => (capability.criticality_factors || []).forEach(factor => {
        const candidateId = factor.startsWith('catalog-candidate:')
          ? factor.slice('catalog-candidate:'.length)
          : factor.startsWith('catalog-operation-obligation:')
            ? factor.slice('catalog-operation-obligation:'.length)
            : undefined;
        if (!candidateId) return;
        const parentCandidateId = obligationScopes.get(candidateId)?.parentCandidateId || candidateId;
        if (coveredParents.includes(parentCandidateId)) representedParents.add(parentCandidateId);
      }));
    const unrepresentedParents = coveredParents.filter(candidateId => !representedParents.has(candidateId));
    if (unrepresentedParents.length === 0) continue;
    const members = result.filter(capability => eligibleCapabilityIds.has(capability.id) && (capability.criticality_factors || []).some(factor => {
      if (factor.startsWith('catalog-candidate:')) {
        const candidateId = factor.slice('catalog-candidate:'.length);
        return unrepresentedParents.includes(obligationScopes.get(candidateId)?.parentCandidateId || candidateId);
      }
      if (!factor.startsWith('catalog-operation-obligation:')) return false;
      const scope = obligationScopes.get(factor.slice('catalog-operation-obligation:'.length));
      return Boolean(scope && unrepresentedParents.includes(scope.parentCandidateId));
    }));
    if (members.length === 0) continue;
    const combined = { name: members.map(item => item.name).join(' '), description: members.map(item => item.description || '').join(' ') };
    if (!capabilitySemanticallySatisfiesCatalogOutcomeRequirement(combined, requirement)) continue;
    const visibleActions = (requirement.visibleActionTerms || []).map(canonicalToken);
    const combinedTokens = new Set(tokens(`${combined.name} ${combined.description}`));
    const multiActionFeature = String(requirement.firstPartyOutcomeText || '')
      .split(/(?<=[.!?;])\s+/i)
      .filter(sentence => purposeVerbIn(sentence)).length > 1;
    if (!multiActionFeature && visibleActions.some(action => !combinedTokens.has(action))) continue;
    const representative = [...members]
      .filter(member => !(member.criticality_factors || [])
        .some(factor => factor.startsWith('catalog-outcome-requirement:')))
      .filter(member => capabilityCatalogOutcomeNameFailure(member.name, requirement) === undefined)
      .sort((left, right) => left.id.localeCompare(right.id))[0];
    if (!representative) continue;
    representative.criticality_factors = [...new Set([
      ...(representative.criticality_factors || []),
      `catalog-outcome-requirement:${requirement.id}`,
      `catalog-outcome-union:${requirement.id}`,
    ])];
  }
  return result;
}

export function capabilityCatalogOutcomeBindingFailure(
  capability: Pick<SystemCapability, 'name' | 'description'>,
  candidateIds: readonly string[],
  requirementId: string,
  requirements: readonly CapabilityCatalogOutcomeRequirement[],
  fulfilledRequirementIds: ReadonlySet<string>,
): string | undefined {
  return capabilityCatalogOutcomeBindingFailureDetail(
    capability, candidateIds, requirementId, requirements, fulfilledRequirementIds,
  )?.reason;
}

export function capabilityCatalogOutcomeBindingFailureDetail(
  capability: Pick<SystemCapability, 'name' | 'description'>,
  candidateIds: readonly string[],
  requirementId: string,
  requirements: readonly CapabilityCatalogOutcomeRequirement[],
  fulfilledRequirementIds: ReadonlySet<string>,
): CapabilityCatalogOutcomeBindingFailure | undefined {
  if (requirements.length === 0) return undefined;
  const requirement = requirements.find(candidate => candidate.id === requirementId);
  const capabilityText = `${capability.name || ''} ${capability.description || ''}`;
  const capabilityTokens = new Set(tokens(capabilityText));
  if (!requirement) {
    const overlapsRequirement = requirements.some(candidate => {
      const terms = candidate.requiredSubjectTerms || candidate.subjectTokens;
      return terms.some(token => capabilityTokens.has(token))
        || capabilityMatchesSubjectAlias(capabilityTokens, terms, candidate.subjectTokenAliases, candidate.subjectAliasAnchorTokens)
        || candidateIds.some(candidateId => candidate.candidateIds.includes(candidateId));
    });
    return { missingSubjectTerms: [], reason: overlapsRequirement
      ? `required-outcome-requirement-mismatch:${requirementId || 'missing'}`
      : 'independent-outcome' };
  }
  const requiredTerms = requirement.requiredSubjectTerms || requirement.subjectTokens;
  const allMissingSubjectTerms = requiredTerms.filter(token => !capabilityTokens.has(token));
  const matches = requiredTerms.length - allMissingSubjectTerms.length;
  const minimumMatches = requirement.minimumSubjectMatches ?? Math.min(2, requiredTerms.length);
  const aliasMatches = capabilityMatchesSubjectAlias(capabilityTokens, requiredTerms, requirement.subjectTokenAliases, requirement.subjectAliasAnchorTokens);
  const subjectMatched = matches >= minimumMatches || aliasMatches;
  const citesRequirementCandidate = candidateIds.some(candidateId => requirement.candidateIds.includes(candidateId));
  const independent = { missingSubjectTerms: allMissingSubjectTerms, reason: 'independent-outcome' };
  if (fulfilledRequirementIds.has(requirementId)) return subjectMatched ? { missingSubjectTerms: [], reason: `required-outcome-already-fulfilled:${requirementId}` } : independent;
  if (matches === 0 && !aliasMatches && !citesRequirementCandidate) return independent;
  if (!citesRequirementCandidate) return { missingSubjectTerms: [], reason: `required-outcome-candidate-mismatch:${requirementId}` };
  const missingSubjectTerms = matches >= minimumMatches || aliasMatches ? [] : allMissingSubjectTerms;
  const audienceFailure = capabilityAudienceBindingFailure(capability, requirement);
  if (audienceFailure) return { ...audienceFailure, missingSubjectTerms };
  return matches >= minimumMatches || aliasMatches ? undefined : { missingSubjectTerms, reason: `required-outcome-subject-mismatch:${requirementId}` };
}

export function capabilityCatalogOutcomesMayMerge(
  left: Pick<SystemCapability, 'criticality_factors'>,
  right: Pick<SystemCapability, 'criticality_factors'>,
): boolean {
  const ids = (capability: Pick<SystemCapability, 'criticality_factors'>) => [...new Set((capability.criticality_factors || [])
    .filter(factor => factor.startsWith('catalog-outcome-requirement:'))
    .map(factor => factor.slice('catalog-outcome-requirement:'.length)))].sort();
  const leftIds = ids(left); const rightIds = ids(right);
  return leftIds.length > 0 && leftIds.length === rightIds.length && leftIds.every((id, index) => id === rightIds[index]);
}

export function uncoveredCapabilityCatalogOutcomeRequirements(
  capabilities: readonly SystemCapability[],
  requirements: readonly CapabilityCatalogOutcomeRequirement[],
  isEligible: (capability: SystemCapability) => boolean = () => true,
): CapabilityCatalogOutcomeRequirement[] {
  const matches = requirements.map(requirement => capabilities.flatMap((capability, index) => {
    if (!isEligible(capability)) return [];
    const factors = capability.criticality_factors || [];
    const boundRequirements = factors.filter(factor => factor.startsWith('catalog-outcome-requirement:'));
    const bound = boundRequirements.includes(`catalog-outcome-requirement:${requirement.id}`);
    const citedCandidates = factors
      .filter(factor => factor.startsWith('catalog-candidate:'))
      .map(factor => factor.slice('catalog-candidate:'.length));
    const candidateGrounded = citedCandidates.some(candidateId => requirement.candidateIds.includes(candidateId));
    const unionBound = factors.includes(`catalog-outcome-union:${requirement.id}`);
    const grounded = boundRequirements.length > 0 ? bound && (candidateGrounded || unionBound) : candidateGrounded;
    return grounded && capabilitySatisfiesCatalogOutcomeRequirement(capability, requirement) ? [index] : [];
  }));
  const capabilityAssignments = new Map<number, number>();
  const assignedRequirements = new Set<number>();
  const assign = (requirementIndex: number, visited: Set<number>): boolean => {
    for (const capabilityIndex of matches[requirementIndex]) {
      if (visited.has(capabilityIndex)) continue;
      visited.add(capabilityIndex);
      const previousRequirement = capabilityAssignments.get(capabilityIndex);
      if (previousRequirement === undefined || assign(previousRequirement, visited)) {
        capabilityAssignments.set(capabilityIndex, requirementIndex);
        assignedRequirements.add(requirementIndex);
        return true;
      }
    }
    return false;
  };
  requirements.forEach((_, index) => assign(index, new Set()));
  return requirements.filter((_, index) => !assignedRequirements.has(index));
}

export function capabilityCatalogOutcomeCoverageFailure(
  capabilities: readonly SystemCapability[],
  requirements: readonly CapabilityCatalogOutcomeRequirement[],
): string | undefined {
  const groundedRequirements = requirements.filter(requirement => requirement.candidateIds.length > 0);
  const uncovered = uncoveredCapabilityCatalogOutcomeRequirements(capabilities, groundedRequirements);
  if (uncovered.length === 0) return undefined;
  return `catalog omits ${uncovered.length} first-party product outcome${uncovered.length === 1 ? '' : 's'} corroborated by structural evidence: ${uncovered.slice(0, 4).map(requirement => `${requirement.audience ? `${requirement.audience} ` : ''}${requirement.statement}`).join(' | ')}`;
}

export function capabilityCatalogCoverageFailure(
  capabilities: readonly SystemCapability[],
  requiredBehaviorCandidateIds: readonly string[],
  requiredEntityCandidateGroups: ReadonlyArray<ReadonlyArray<string>>,
  requirements: readonly CapabilityCatalogOutcomeRequirement[],
  fullyCoveredAggregateCandidateIds: ReadonlySet<string> = new Set(),
): string | undefined {
  void requiredBehaviorCandidateIds; void requiredEntityCandidateGroups; void fullyCoveredAggregateCandidateIds;
  return capabilityCatalogOutcomeCoverageFailure(capabilities, requirements);
}

export function capabilityCatalogOutcomeRepairCandidateIds(
  requirements: readonly CapabilityCatalogOutcomeRequirement[],
): string[] {
  return [...new Set(requirements.flatMap(requirement => requirement.candidateIds))];
}

export function capabilityCatalogOutcomeRequirementsForCandidates(
  requirements: readonly CapabilityCatalogOutcomeRequirement[],
  candidateIds: readonly string[],
): CapabilityCatalogOutcomeRequirement[] {
  const ids = new Set(candidateIds);
  return requirements.filter(requirement => requirement.candidateIds.some(candidateId => ids.has(candidateId)));
}

export function capabilityCatalogOutcomeRepairNudge(
  requirements: readonly CapabilityCatalogOutcomeRequirement[],
  candidateIds: readonly string[],
): string {
  const relevant = capabilityCatalogOutcomeRequirementsForCandidates(requirements, candidateIds);
  return relevant.length > 0
    ? `Distinct first-party outcomes still required by corroborated evidence: ${JSON.stringify(relevant.map(requirement => ({ requirement_id: requirement.id, first_party_outcome_text: capabilityCatalogTargetedOutcomeText(requirement), required_audience_label: requirement.audienceLabel || requirement.audience, shared_beneficiary_audiences: requirement.beneficiaryAudiences, required_subject_terms: requirement.requiredSubjectTerms || requirement.subjectTokens, minimum_subject_matches: requirement.minimumSubjectMatches ?? Math.min(2, requirement.subjectTokens.length), outcome: requirement.statement })))}. Return one distinct outcome for each entry. Shared beneficiary audiences describe who receives the SAME outcome; do not split an outcome merely because both people and agents benefit. Cite only opaque candidate_ids supplied in the repair facts. When required_audience_label is present, include it in both name and description; omit every opposite audience named by prior_rejections, and copy enough required_subject_terms or their canonical validator forms.`
    : '';
}
