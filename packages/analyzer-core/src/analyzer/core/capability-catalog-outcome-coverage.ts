import type { SystemCapability } from '../../types/cas.types';
import { catalogEvidenceCoverageFailure, type CapabilityCatalogProjectSignal } from './capability-catalog-evidence';
import { CAPABILITY_PURPOSE_VERBS } from './capability-naming';

export interface CapabilityCatalogOutcomeRequirement {
  audience?: 'agent' | 'human';
  audienceLabel?: string;
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

const humanAudienceSource = '(?:humans?|people|persons?|users?)';
const agentAudienceSource = '(?:agents?|assistants?)';
const humanAudience = new RegExp(`\\b${humanAudienceSource}\\b`, 'i');
const agentAudience = new RegExp(`\\b${agentAudienceSource}\\b`, 'i');
const coordinatedAudienceList = new RegExp(
  `\\b(?:${humanAudienceSource}\\s*(?:,\\s*(?:and\\s+)?|\\s+and\\s+|\\s*&\\s*|\\s*\\/\\s*)(?:AI\\s+)?${agentAudienceSource}|(?:AI\\s+)?${agentAudienceSource}\\s*(?:,\\s*(?:and\\s+)?|\\s+and\\s+|\\s*&\\s*|\\s*\\/\\s*)${humanAudienceSource})\\b`,
  'i',
);

function canonicalToken(token: string): string {
  const source = token.toLowerCase();
  if (/^(?:auth|authenticate|authenticated|authenticating|authentication)$/.test(source)) return 'authenticate';
  if (source === 'status') return 'status';
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
  if (!CAPABILITY_PURPOSE_VERBS.has(value) && CAPABILITY_PURPOSE_VERBS.has(`${value}e`)) value = `${value}e`;
  if (/^(?:apps|jobs|maps|tags)$/.test(value)) value = value.slice(0, -1);

  if (/^(?:compreh|explain|explor|inspect|understand)/.test(value)) return 'understand';
  if (/^(?:accur|reliab|trust)/.test(value)) return 'trust';
  if (value === 'mapp') return 'mapping';
  if (/^(?:collabor|coordin)/.test(value)) return 'collaborate';
  if (/^(?:connect|relation)/.test(value)) return 'relation';
  if (/^(?:code|codebase|source|software)$/.test(value)) return 'software';
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

function purposeVerbIn(value: string): boolean {
  return (value.match(/[A-Za-z][A-Za-z'-]*/g) || [])
    .some(word => CAPABILITY_PURPOSE_VERBS.has(canonicalToken(word)));
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
  const sentences = [signal?.productDocSummary || signal?.manifestDescription]
    .filter((value): value is string => Boolean(value))
    .flatMap(value => value.split(/(?<=[.!?;])\s+/i))
    .map(value => value.trim())
    .filter(Boolean);
  const grouped: string[] = [];
  let activeFeatureIndex = -1;
  for (const sentence of sentences) {
    const separator = sentence.indexOf(':');
    const heading = separator >= 0 ? sentence.slice(0, separator).trim() : '';
    const body = separator >= 0 ? sentence.slice(separator + 1).trim() : '';
    const featureHeading = heading.length > 0 && heading.split(/\s+/).length <= 6 && purposeVerbIn(body);
    if (featureHeading) {
      grouped.push(sentence);
      activeFeatureIndex = grouped.length - 1;
    } else if (activeFeatureIndex >= 0) {
      grouped[activeFeatureIndex] = `${grouped[activeFeatureIndex]} ${sentence}`;
    } else {
      grouped.push(sentence);
    }
  }
  return grouped
    .flatMap(splitCoordinatedClause)
    .map(value => value.trim().replace(/^[,;]\s*/, '').replace(/[.!?]+$/, ''))
    .filter(value => value.length >= 20 && !/^[^,.:;!?]+?\s+(?:is|are)\s+(?:an?\s+|the\s+)?[^,.]+$/i.test(value));
}

function outcomeClauseBody(clause: string): string {
  const separator = clause.indexOf(':');
  if (separator < 0) return clause;
  const body = clause.slice(separator + 1).trim();
  return purposeVerbIn(body) ? body : clause;
}

function conciseOutcomeStatement(clause: string, subjectTokens: ReadonlySet<string>): string {
  const words = String(clause || '')
    .replace(humanAudience, ' ')
    .replace(agentAudience, ' ')
    .trim()
    .split(/\s+/);
  const actionIndex = words.findIndex(word => CAPABILITY_PURPOSE_VERBS.has(canonicalToken(
    (word.match(/[A-Za-z][A-Za-z'-]*/)?.[0]) || '',
  )));
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

function requirementAudiences(clause: string): Array<'agent' | 'human' | undefined> {
  const audiences: Array<'agent' | 'human'> = [];
  if (humanAudience.test(clause)) audiences.push('human');
  if (agentAudience.test(clause)) audiences.push('agent');
  return audiences.length > 0 ? audiences : [undefined];
}

function requirementAudienceLabel(clause: string, audience?: 'agent' | 'human'): string | undefined {
  if (!audience) return undefined;
  return clause.match(audience === 'human' ? humanAudience : agentAudience)?.[0]?.toLowerCase();
}

export function audienceScopedCapabilityCatalogOutcomeText(
  clause: string,
  audience?: 'agent' | 'human',
  audienceLabel?: string,
): string | undefined {
  if (!audience || !audienceLabel || !humanAudience.test(clause) || !agentAudience.test(clause)) return undefined;
  const coordinated = clause.match(coordinatedAudienceList);
  const index = coordinated?.index;
  if (!coordinated || index === undefined) return undefined;
  const governingText = clause.slice(0, index);
  const isClauseSubject = governingText.trim().length === 0;
  const hasAudienceMarker = /\b(?:for|to|by)\s*$/i.test(governingText);
  if (!isClauseSubject && !hasAudienceMarker) return undefined;
  return governingText + audienceLabel + clause.slice(index + coordinated[0].length);
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
  const action = words
    .map((word, index) => ({ index, token: canonicalToken(word) }))
    .find(({ index, token }) => CAPABILITY_PURPOSE_VERBS.has(token) &&
      !(token === 'support' && /^(?:staff|team|teams|engineers?|operators?|agents?)$/i.test(words[index + 1] || '')))
    ?.token;
  if (action && !/^(?:handle|manage|process)$/.test(action)) return [action];
  const statementLeading = canonicalToken((String(statement || '').match(/[A-Za-z][A-Za-z'-]*/)?.[0]) || '');
  return CAPABILITY_PURPOSE_VERBS.has(statementLeading) && !/^(?:handle|manage|process)$/.test(statementLeading)
    ? [statementLeading]
    : [];
}

export function deriveCapabilityCatalogOutcomeRequirements(
  signal: CapabilityCatalogProjectSignal | undefined,
  candidates: readonly SystemCapability[],
): CapabilityCatalogOutcomeRequirement[] {
  const candidateTokens = candidates.filter(candidate => candidate.evidence_role !== 'verification-harness').map(candidate => {
    const text = candidateText(candidate);
    const rawTokens = tokens(text, true);
    return { candidate, text, tokens: new Set([...rawTokens, ...rawTokens.map(comparableEvidenceToken)]) };
  });
  const requirements = new Map<string, CapabilityCatalogOutcomeRequirement>();
  const subjectStopwords = new Set(['also', 'different', 'easier', 'extra', 'faster', 'feature', 'seamlessly', 'that', 'their', 'this', 'using', 'with', 'your']);
  for (const firstPartyClause of productClauses(signal)) {
    const clause = outcomeClauseBody(firstPartyClause);
    const clauseTokens = tokens(clause, true);
    const subjectTokens = clauseTokens.filter(token => !subjectStopwords.has(token));
    const scoringSubjectTokens = subjectTokens.filter(token => !/^(?:add|change|close|create|delete|edit|get|handle|list|manage|process|read|remove|update|view)$/.test(token));
    if (subjectTokens.length === 0) continue;
    for (const audience of requirementAudiences(clause)) {
      const audienceCandidates = candidateTokens.filter(item => !audience || (audience === 'human'
        ? !agentAudience.test(item.text) || humanAudience.test(item.text)
        : !humanAudience.test(item.text) || agentAudience.test(item.text)));
      const scoringTokenFrequency = new Map(scoringSubjectTokens.map(token => [token,
        audienceCandidates.filter(item => item.tokens.has(comparableEvidenceToken(token))).length]));
      const scored = audienceCandidates.map(item => ({
        id: item.candidate.id,
        evidenceRank: item.candidate.evidence_role === 'product-outcome' ? 0
          : item.candidate.evidence_role === 'unresolved' || item.candidate.evidence_role === undefined ? 1 : 2,
        aggregateRank: item.candidate.evidence_kind === 'behavior-surface' ? 1 : 0,
        score: scoringSubjectTokens.filter(token => item.tokens.has(comparableEvidenceToken(token))).length,
        distinctive: scoringSubjectTokens.some(token => item.tokens.has(comparableEvidenceToken(token)) && scoringTokenFrequency.get(token) === 1),
      })).filter(item => item.id && scoringSubjectTokens.length > 0 && (
        item.score >= Math.min(2, scoringSubjectTokens.length) ||
        (item.score >= 1 && (item.evidenceRank === 0 || item.distinctive))
      )).sort((left, right) => right.score - left.score ||
        left.evidenceRank - right.evidenceRank ||
        left.aggregateRank - right.aggregateRank ||
        left.id.localeCompare(right.id));
      const bestScore = scored[0]?.score;
      const candidateIds = bestScore === undefined ? [] : scored.filter(item => item.score === bestScore).slice(0, 3).map(item => item.id);
      const candidateIdSet = new Set(candidateIds);
      const groundedSubjectTokens = candidateIds.length > 0
        ? subjectTokens.filter(token => candidateTokens.some(item =>
          candidateIdSet.has(item.candidate.id) && item.tokens.has(comparableEvidenceToken(token))))
        : subjectTokens.slice(0, 8);
      const originalClauseAlias = clauseTokens
        .filter(token => audienceCandidates.some(item => candidateIdSet.has(item.candidate.id) && item.tokens.has(token)))
        .slice(0, 8);
      const recoveredAliasTokens = originalClauseAlias.filter(token => !groundedSubjectTokens.includes(token));
      const aliasAnchor = recoveredAliasTokens.slice().sort((left, right) => {
        const occurrences = (token: string) => audienceCandidates.filter(item => item.tokens.has(token)).length;
        return occurrences(left) - occurrences(right) || right.length - left.length || left.localeCompare(right);
      })[0];
      const subjectTokenAliases = originalClauseAlias.some(token => groundedSubjectTokens.includes(token)) && aliasAnchor ? [originalClauseAlias] : undefined;
      const statement = conciseOutcomeStatement(clause, new Set(groundedSubjectTokens));
      const audienceLabel = requirementAudienceLabel(clause, audience);
      const audienceScopedOutcomeText = audienceScopedCapabilityCatalogOutcomeText(clause, audience, audienceLabel);
      const visibleActionTerms = clauseVisibleActionTerms(clause, statement);
      const id = requirementId(audience, [...new Set([...visibleActionTerms, ...groundedSubjectTokens])]);
      if (candidateIds.length === 0 && visibleActionTerms.length === 0) continue;
      requirements.set(id, {
        audience,
        audienceLabel,
        ...(audienceScopedOutcomeText ? { audienceScopedOutcomeText } : {}),
        candidateIds,
        id,
        firstPartyOutcomeText: firstPartyClause,
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
  return ordered.filter((requirement, index) => {
    if (requirement.firstPartyOutcomeText?.includes(':')) return true;
    const detailed = ordered.slice(index + 1, index + 3).find(candidate =>
      candidate.firstPartyOutcomeText?.includes(':') &&
      candidate.audience === requirement.audience &&
      (candidate.visibleActionTerms || []).some(action => requirement.visibleActionTerms?.includes(action)) &&
      candidate.candidateIds.some(candidateId => requirement.candidateIds.includes(candidateId)) &&
      candidate.subjectTokens.some(token => requirement.subjectTokens.includes(token)));
    return !detailed;
  });
}

function capabilityMatchesAudience(capabilityText: string, audience?: 'agent' | 'human'): boolean {
  if (!audience) return true;
  return audience === 'human' ? humanAudience.test(capabilityText) : agentAudience.test(capabilityText);
}

function capabilityMatchesBoundAudience(
  capability: Pick<SystemCapability, 'name' | 'description'>,
  audience?: 'agent' | 'human',
): boolean {
  if (!audience) return true;
  const opposite = audience === 'human' ? agentAudience : humanAudience;
  return capabilityMatchesAudience(capability.name || '', audience) &&
    capabilityMatchesAudience(capability.description || '', audience) &&
    !opposite.test(capability.name || '') && !opposite.test(capability.description || '');
}

function capabilityAudienceBindingFailure(
  capability: Pick<SystemCapability, 'name' | 'description'>,
  requirement: CapabilityCatalogOutcomeRequirement,
): Omit<CapabilityCatalogOutcomeBindingFailure, 'missingSubjectTerms'> | undefined {
  if (!requirement.audience) return undefined;
  const required = requirement.audience === 'human' ? humanAudience : agentAudience;
  const opposite = requirement.audience === 'human' ? agentAudience : humanAudience;
  const missingAudienceLocations = (['name', 'description'] as const).filter(location => !required.test(capability[location] || ''));
  const oppositeAudienceLocations = (['name', 'description'] as const).filter(location => opposite.test(capability[location] || ''));
  const oppositeAudienceLabels = [...new Set(oppositeAudienceLocations.map(location =>
    (capability[location] || '').match(opposite)?.[0]?.toLowerCase()).filter((label): label is string => Boolean(label)))];
  if (missingAudienceLocations.length > 0) return {
    missingAudience: requirement.audienceLabel || requirement.audience,
    missingAudienceLocations: [...missingAudienceLocations],
    ...(oppositeAudienceLabels.length ? { oppositeAudienceLabels, oppositeAudienceLocations: [...oppositeAudienceLocations] } : {}),
    reason: `required-outcome-audience-missing:${requirement.audience}`,
  };
  if (oppositeAudienceLocations.length > 0) return {
    oppositeAudienceLabels,
    oppositeAudienceLocations: [...oppositeAudienceLocations],
    reason: `required-outcome-audience-conflict:${requirement.audience}`,
  };
  return undefined;
}

function capabilityMatchesSubjectAlias(
  capabilityTokens: ReadonlySet<string>,
  primaryTerms: readonly string[],
  aliases: readonly string[][] = [],
  aliasAnchors: readonly string[][] = [],
): boolean {
  const primary = new Set(primaryTerms);
  return aliases.some((alias, index) => alias.filter(token => capabilityTokens.has(token)).length >= Math.min(2, alias.length) &&
    alias.some(token => primary.has(token) && capabilityTokens.has(token)) &&
    (aliasAnchors[index] || []).some(token => capabilityTokens.has(token)));
}

export function capabilitySatisfiesCatalogOutcomeRequirement(
  capability: Pick<SystemCapability, 'name' | 'description'> & Partial<Pick<SystemCapability, 'criticality_factors'>>,
  requirement: CapabilityCatalogOutcomeRequirement,
): boolean {
  if (capability.criticality_factors?.includes(`catalog-outcome-requirement:${requirement.id}`)) {
    return capabilityMatchesBoundAudience(capability, requirement.audience);
  }
  return capabilitySemanticallySatisfiesCatalogOutcomeRequirement(capability, requirement);
}

export function capabilitySemanticallySatisfiesCatalogOutcomeRequirement(
  capability: Pick<SystemCapability, 'name' | 'description'>,
  requirement: CapabilityCatalogOutcomeRequirement,
): boolean {
  const capabilityText = `${capability.name || ''} ${capability.description || ''}`;
  if (!capabilityMatchesBoundAudience(capability, requirement.audience)) return false;
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
  const requiredTerms = requirement.requiredSubjectTerms || requirement.subjectTokens;
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
  if (requiredAction.size > 0 && !requiredAction.has(canonicalLeading)) return `required-outcome-visible-action-missing:${requirement.id}`;
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
  if (!/[,;]/.test(normalized)) return normalized;
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
): SystemCapability[] {
  const result = capabilities.map(capability => ({ ...capability, criticality_factors: [...(capability.criticality_factors || [])] }));
  for (const requirement of requirements) {
    if (result.some(capability => capabilitySatisfiesCatalogOutcomeRequirement(capability, requirement) &&
      (capability.criticality_factors || []).includes(`catalog-outcome-requirement:${requirement.id}`))) continue;
    const coveredParents = requirement.candidateIds.filter(candidateId => fullyCoveredAggregateCandidateIds.has(candidateId));
    if (coveredParents.length === 0) continue;
    const members = result.filter(capability => (capability.criticality_factors || []).some(factor => {
      if (!factor.startsWith('catalog-operation-obligation:')) return false;
      const scope = obligationScopes.get(factor.slice('catalog-operation-obligation:'.length));
      return Boolean(scope && coveredParents.includes(scope.parentCandidateId));
    }));
    if (members.length === 0) continue;
    const combined = { name: members.map(item => item.name).join(' '), description: members.map(item => item.description || '').join(' ') };
    if (!capabilitySemanticallySatisfiesCatalogOutcomeRequirement(combined, requirement)) continue;
    const visibleActions = (requirement.visibleActionTerms || []).map(canonicalToken);
    const combinedTokens = new Set(tokens(`${combined.name} ${combined.description}`));
    if (visibleActions.some(action => !combinedTokens.has(action))) continue;
    const representative = [...members]
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
  if (!requirement) return { missingSubjectTerms: [], reason: `required-outcome-requirement-mismatch:${requirementId || 'missing'}` };
  if (fulfilledRequirementIds.has(requirementId)) return { missingSubjectTerms: [], reason: `required-outcome-already-fulfilled:${requirementId}` };
  if (!candidateIds.some(candidateId => requirement.candidateIds.includes(candidateId))) {
    return { missingSubjectTerms: [], reason: `required-outcome-candidate-mismatch:${requirementId}` };
  }
  const capabilityText = `${capability.name || ''} ${capability.description || ''}`;
  const capabilityTokens = new Set(tokens(capabilityText));
  const requiredTerms = requirement.requiredSubjectTerms || requirement.subjectTokens;
  const allMissingSubjectTerms = requiredTerms.filter(token => !capabilityTokens.has(token));
  const matches = requiredTerms.length - allMissingSubjectTerms.length;
  const minimumMatches = requirement.minimumSubjectMatches ?? Math.min(2, requiredTerms.length);
  const aliasMatches = capabilityMatchesSubjectAlias(capabilityTokens, requiredTerms, requirement.subjectTokenAliases, requirement.subjectAliasAnchorTokens);
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
  return leftIds.length === rightIds.length && leftIds.every((id, index) => id === rightIds[index]);
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
  return catalogEvidenceCoverageFailure(capabilities, requiredBehaviorCandidateIds, requiredEntityCandidateGroups, fullyCoveredAggregateCandidateIds) ||
    capabilityCatalogOutcomeCoverageFailure(capabilities, requirements);
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
    ? `Distinct first-party outcomes still required by corroborated evidence: ${JSON.stringify(relevant.map(requirement => ({ requirement_id: requirement.id, first_party_outcome_text: capabilityCatalogTargetedOutcomeText(requirement), required_audience_label: requirement.audienceLabel || requirement.audience, required_subject_terms: requirement.requiredSubjectTerms || requirement.subjectTokens, minimum_subject_matches: requirement.minimumSubjectMatches ?? Math.min(2, requirement.subjectTokens.length), outcome: requirement.statement })))}. Return one distinct outcome for each entry, including separate outcomes for different explicit audiences. Cite only opaque candidate_ids supplied in the repair facts. Include the literal required_audience_label in both name and description, omit every opposite audience named by prior_rejections, and copy enough required_subject_terms or their canonical validator forms.`
    : '';
}
