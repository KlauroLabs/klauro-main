import type { SystemCapability } from '../../types/cas.types';
import { catalogEvidenceCoverageFailure, type CapabilityCatalogProjectSignal } from './capability-catalog-evidence';
import { CAPABILITY_PURPOSE_VERBS } from './capability-naming';

export interface CapabilityCatalogOutcomeRequirement {
  audience?: 'agent' | 'human';
  audienceLabel?: string;
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
  missingSubjectTerms: string[];
  reason: string;
}

const humanAudience = /\b(?:humans?|people|persons?|users?)\b/i;
const agentAudience = /\b(?:agents?|assistants?)\b/i;

function canonicalToken(token: string): string {
  const source = token.toLowerCase();
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
  if (/^(?:compreh|explain|explor|inspect|understand)/.test(value)) return 'understand';
  if (/^(?:accur|reliab|trust)/.test(value)) return 'trust';
  if (/^(?:collabor|coordin)/.test(value)) return 'collaborate';
  if (/^(?:connect|relation)/.test(value)) return 'relation';
  if (/^(?:code|codebase|source|software)$/.test(value)) return 'software';
  if (/^(?:event|observ|runtime|telemetry)/.test(value)) return value.startsWith('runtime') ? 'runtime' : 'telemetry';
  return value;
}

export function canonicalCapabilityCatalogOutcomeToken(token: string): string {
  return canonicalToken(token);
}

function tokens(value: string, omitAudience = false): string[] {
  const source = omitAudience ? String(value || '').replace(humanAudience, ' ').replace(agentAudience, ' ') : String(value || '');
  return [...new Set(source
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(token => token.length >= 4)
    .map(canonicalToken)
    .filter(token => token.length >= 4))];
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

function splitCoordinatedClause(value: string): string[] {
  const conjunctions = [...value.matchAll(/\s+and\s+/gi)];
  const boundary = conjunctions.find(match => {
    const index = match.index || 0;
    const left = value.slice(0, index).trim().split(/\s+/);
    const right = value.slice(index + match[0].length).trim().split(/\s+/);
    return left.length >= 3 && right.length >= 3;
  });
  if (!boundary) return [value];
  const index = boundary.index || 0;
  return [value.slice(0, index), ...splitCoordinatedClause(value.slice(index + boundary[0].length))];
}

function productClauses(signal?: CapabilityCatalogProjectSignal): string[] {
  return [signal?.productDocSummary || signal?.manifestDescription]
    .filter((value): value is string => Boolean(value))
    .flatMap(value => value.split(/(?<=[.!?;])\s+|\s*,\s*(?:and\s+)?/i))
    .flatMap(splitCoordinatedClause)
    .map(value => value.trim().replace(/^[,;]\s*/, '').replace(/[.!?]+$/, ''))
    .filter(value => value.length >= 20 && !/^.+?\s+(?:is|are)\s+(?:an?\s+|the\s+)?[^,.]+$/i.test(value));
}

function conciseOutcomeStatement(clause: string, subjectTokens: ReadonlySet<string>): string {
  return String(clause || '')
    .replace(humanAudience, ' ')
    .replace(agentAudience, ' ')
    .split(/\s+/)
    .filter(word => tokens(word).some(token => subjectTokens.has(token)))
    .join(' ')
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

function requirementId(audience: string | undefined, subjectTokens: readonly string[]): string {
  return `${audience || 'all'}:${subjectTokens.slice().sort().join('-')}`;
}

function clauseVisibleActionTerms(clause: string, statement: string): string[] {
  const words = String(clause || '').match(/[A-Za-z][A-Za-z'-]*/g) || [];
  const action = words.map(canonicalToken).find(token => CAPABILITY_PURPOSE_VERBS.has(token));
  if (action) return [action];
  const statementLeading = canonicalToken((String(statement || '').match(/[A-Za-z][A-Za-z'-]*/)?.[0]) || '');
  return CAPABILITY_PURPOSE_VERBS.has(statementLeading) ? [statementLeading] : [];
}

export function deriveCapabilityCatalogOutcomeRequirements(
  signal: CapabilityCatalogProjectSignal | undefined,
  candidates: readonly SystemCapability[],
): CapabilityCatalogOutcomeRequirement[] {
  const candidateTokens = candidates.filter(candidate => candidate.evidence_role !== 'verification-harness').map(candidate => ({
    candidate,
    text: candidateText(candidate),
    tokens: new Set(tokens(candidateText(candidate), true)),
  }));
  const requirements = new Map<string, CapabilityCatalogOutcomeRequirement>();
  const previousClauseTokens = new Set<string>();
  for (const clause of productClauses(signal)) {
    const clauseTokens = tokens(clause, true);
    const subjectTokens = clauseTokens.filter(token => !previousClauseTokens.has(token));
    clauseTokens.forEach(token => previousClauseTokens.add(token));
    if (subjectTokens.length === 0) continue;
    for (const audience of requirementAudiences(clause)) {
      const audienceCandidates = candidateTokens.filter(item => !audience || (audience === 'human'
        ? !agentAudience.test(item.text) || humanAudience.test(item.text)
        : !humanAudience.test(item.text) || agentAudience.test(item.text)));
      const scored = audienceCandidates.map(item => ({
        id: item.candidate.id,
        score: subjectTokens.filter(token => item.tokens.has(token)).length,
      })).filter(item => item.id && item.score >= Math.min(2, subjectTokens.length)).sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
      if (scored.length === 0) continue;
      const bestScore = scored[0].score;
      const candidateIds = scored.filter(item => item.score === bestScore).slice(0, 3).map(item => item.id);
      const candidateIdSet = new Set(candidateIds);
      const groundedSubjectTokens = subjectTokens.filter(token => candidateTokens.some(item => candidateIdSet.has(item.candidate.id) && item.tokens.has(token)));
      const originalClauseAlias = clauseTokens
        .filter(token => audienceCandidates.some(item => candidateIdSet.has(item.candidate.id) && item.tokens.has(token)))
        .slice(0, 8);
      const recoveredAliasTokens = originalClauseAlias.filter(token => !groundedSubjectTokens.includes(token));
      const aliasAnchor = recoveredAliasTokens.slice().sort((left, right) => {
        const occurrences = (token: string) => audienceCandidates.filter(item => item.tokens.has(token)).length;
        return occurrences(left) - occurrences(right) || right.length - left.length || left.localeCompare(right);
      })[0];
      const subjectTokenAliases = originalClauseAlias.some(token => groundedSubjectTokens.includes(token)) && aliasAnchor ? [originalClauseAlias] : undefined;
      const id = requirementId(audience, groundedSubjectTokens);
      const statement = conciseOutcomeStatement(clause, new Set(groundedSubjectTokens));
      const audienceLabel = requirementAudienceLabel(clause, audience);
      const visibleActionTerms = clauseVisibleActionTerms(clause, statement);
      requirements.set(id, {
        audience,
        audienceLabel,
        candidateIds,
        id,
        firstPartyOutcomeText: clause,
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
  return [...requirements.values()];
}

function capabilityMatchesAudience(capabilityText: string, audience?: 'agent' | 'human'): boolean {
  if (!audience) return true;
  return audience === 'human' ? humanAudience.test(capabilityText) : agentAudience.test(capabilityText);
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
  if (capability.criticality_factors?.includes(`catalog-outcome-requirement:${requirement.id}`)) return true;
  return capabilitySemanticallySatisfiesCatalogOutcomeRequirement(capability, requirement);
}

export function capabilitySemanticallySatisfiesCatalogOutcomeRequirement(
  capability: Pick<SystemCapability, 'name' | 'description'>,
  requirement: CapabilityCatalogOutcomeRequirement,
): boolean {
  const capabilityText = `${capability.name || ''} ${capability.description || ''}`;
  if (!capabilityMatchesAudience(capabilityText, requirement.audience)) return false;
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
  const leading = orderedNameTokens[0];
  const recoveredAnchors = [...new Set((requirement.subjectAliasAnchorTokens || []).flat().map(canonicalToken))];
  const subjectTerms = new Set((requirement.requiredSubjectTerms || requirement.subjectTokens).map(canonicalToken));
  const rawLeading = String(name || '').toLowerCase().match(/[a-z][a-z0-9]*/)?.[0] || '';
  const actionStem = rawLeading.replace(/(?:ing|ed|es|s)$/, '');
  const actionHeaded = CAPABILITY_PURPOSE_VERBS.has(leading || '') || CAPABILITY_PURPOSE_VERBS.has(rawLeading) || CAPABILITY_PURPOSE_VERBS.has(actionStem);
  const requiredAction = new Set((requirement.visibleActionTerms || []).map(canonicalToken));
  if (requiredAction.size > 0 && !requiredAction.has(leading || '')) return `required-outcome-visible-action-missing:${requirement.id}`;
  if (leading && subjectTerms.has(leading) && !actionHeaded && recoveredAnchors.length > 0 && !recoveredAnchors.some(anchor => orderedNameTokens.includes(anchor))) {
    return `required-outcome-visible-action-missing:${requirement.id}`;
  }
  return undefined;
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
  const missingSubjectTerms = requiredTerms.filter(token => !capabilityTokens.has(token));
  const missingAudience = capabilityMatchesAudience(capabilityText, requirement.audience)
    ? undefined
    : requirement.audienceLabel || requirement.audience;
  if (missingAudience) return { missingAudience, missingSubjectTerms, reason: `required-outcome-audience-missing:${requirement.audience}` };
  const aliasMatches = capabilityMatchesSubjectAlias(capabilityTokens, requiredTerms, requirement.subjectTokenAliases, requirement.subjectAliasAnchorTokens);
  const matches = requiredTerms.length - missingSubjectTerms.length;
  const minimumMatches = requirement.minimumSubjectMatches ?? Math.min(2, requiredTerms.length);
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
    const grounded = boundRequirements.length > 0 ? bound : citedCandidates.some(candidateId => requirement.candidateIds.includes(candidateId));
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
  const uncovered = uncoveredCapabilityCatalogOutcomeRequirements(capabilities, requirements);
  if (uncovered.length === 0) return undefined;
  return `catalog omits ${uncovered.length} first-party product outcome${uncovered.length === 1 ? '' : 's'} corroborated by structural evidence: ${uncovered.slice(0, 4).map(requirement => `${requirement.audience ? `${requirement.audience} ` : ''}${requirement.statement}`).join(' | ')}`;
}

export function capabilityCatalogCoverageFailure(
  capabilities: readonly SystemCapability[],
  requiredBehaviorCandidateIds: readonly string[],
  requiredEntityCandidateGroups: ReadonlyArray<ReadonlyArray<string>>,
  requirements: readonly CapabilityCatalogOutcomeRequirement[],
): string | undefined {
  return catalogEvidenceCoverageFailure(capabilities, requiredBehaviorCandidateIds, requiredEntityCandidateGroups) ||
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
    ? `Distinct first-party outcomes still required by corroborated evidence: ${JSON.stringify(relevant.map(requirement => ({ requirement_id: requirement.id, first_party_outcome_text: requirement.firstPartyOutcomeText, required_audience_label: requirement.audienceLabel || requirement.audience, required_subject_terms: requirement.requiredSubjectTerms || requirement.subjectTokens, minimum_subject_matches: requirement.minimumSubjectMatches ?? Math.min(2, requirement.subjectTokens.length), outcome: requirement.statement })))}. Return one distinct outcome for each entry, including separate outcomes for different explicit audiences. Cite only opaque candidate_ids supplied in the repair facts. Copy the literal required_audience_label and enough required_subject_terms, or their canonical validator forms, across the name and description.`
    : '';
}
