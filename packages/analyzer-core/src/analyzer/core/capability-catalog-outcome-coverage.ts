import type { SystemCapability } from '../../types/cas.types';
import { catalogEvidenceCoverageFailure, type CapabilityCatalogProjectSignal } from './capability-catalog-evidence';

export interface CapabilityCatalogOutcomeRequirement {
  audience?: 'agent' | 'human';
  candidateIds: string[];
  id: string;
  statement: string;
  subjectTokens: string[];
}

const humanAudience = /\b(?:humans?|people|persons?|users?)\b/i;
const agentAudience = /\b(?:agents?|assistants?)\b/i;

function canonicalToken(token: string): string {
  const source = token.toLowerCase();
  const value = source.endsWith('ies') && source.length > 4
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
  if (/^(?:compreh|explain|explor|inspect|understand)/.test(value)) return 'understand';
  if (/^(?:accur|reliab|trust)/.test(value)) return 'trust';
  if (/^(?:collabor|coordin)/.test(value)) return 'collaborate';
  if (/^(?:connect|relation)/.test(value)) return 'relation';
  if (/^(?:code|codebase|source|software)$/.test(value)) return 'software';
  if (/^(?:event|observ|runtime|telemetry)/.test(value)) return value.startsWith('runtime') ? 'runtime' : 'telemetry';
  return value;
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

function requirementId(audience: string | undefined, subjectTokens: readonly string[]): string {
  return `${audience || 'all'}:${subjectTokens.slice().sort().join('-')}`;
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
      const scored = candidateTokens.filter(item => !audience || (audience === 'human'
        ? !agentAudience.test(item.text) || humanAudience.test(item.text)
        : !humanAudience.test(item.text) || agentAudience.test(item.text))).map(item => ({
        id: item.candidate.id,
        score: subjectTokens.filter(token => item.tokens.has(token)).length,
      })).filter(item => item.id && item.score >= Math.min(2, subjectTokens.length)).sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
      if (scored.length === 0) continue;
      const bestScore = scored[0].score;
      const candidateIds = scored.filter(item => item.score === bestScore).slice(0, 3).map(item => item.id);
      const candidateIdSet = new Set(candidateIds);
      const groundedSubjectTokens = subjectTokens.filter(token => candidateTokens.some(item => candidateIdSet.has(item.candidate.id) && item.tokens.has(token)));
      const id = requirementId(audience, groundedSubjectTokens);
      requirements.set(id, { audience, candidateIds, id, statement: conciseOutcomeStatement(clause, new Set(groundedSubjectTokens)), subjectTokens: groundedSubjectTokens });
    }
  }
  return [...requirements.values()];
}

function capabilityMatchesAudience(capabilityText: string, audience?: 'agent' | 'human'): boolean {
  if (!audience) return true;
  return audience === 'human' ? humanAudience.test(capabilityText) : agentAudience.test(capabilityText);
}

export function capabilitySatisfiesCatalogOutcomeRequirement(
  capability: Pick<SystemCapability, 'name' | 'description'> & Partial<Pick<SystemCapability, 'criticality_factors'>>,
  requirement: CapabilityCatalogOutcomeRequirement,
): boolean {
  if (capability.criticality_factors?.includes(`catalog-outcome-requirement:${requirement.id}`)) return true;
  const capabilityText = `${capability.name || ''} ${capability.description || ''}`;
  if (!capabilityMatchesAudience(capabilityText, requirement.audience)) return false;
  const capabilityTokens = new Set(tokens(capabilityText));
  const requiredMatches = Math.min(2, requirement.subjectTokens.length);
  return requirement.subjectTokens.filter(token => capabilityTokens.has(token)).length >= requiredMatches;
}

export function bindUniquelySatisfiedCatalogOutcomeRequirements(
  capabilities: readonly SystemCapability[],
  requirements: readonly CapabilityCatalogOutcomeRequirement[],
): SystemCapability[] {
  const matches = requirements.map(requirement => capabilities.flatMap((capability, index) =>
    capabilitySatisfiesCatalogOutcomeRequirement(capability, requirement) ? [index] : []));
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
  if (requirements.length === 0) return undefined;
  const requirement = requirements.find(candidate => candidate.id === requirementId);
  return requirement && !fulfilledRequirementIds.has(requirementId) &&
    candidateIds.some(candidateId => requirement.candidateIds.includes(candidateId)) &&
    capabilitySatisfiesCatalogOutcomeRequirement(capability, requirement)
    ? undefined : 'required-outcome-mismatch';
}

export function uncoveredCapabilityCatalogOutcomeRequirements(
  capabilities: readonly SystemCapability[],
  requirements: readonly CapabilityCatalogOutcomeRequirement[],
  isEligible: (capability: SystemCapability) => boolean = () => true,
): CapabilityCatalogOutcomeRequirement[] {
  const matches = requirements.map(requirement => capabilities.flatMap((capability, index) => {
    if (!isEligible(capability)) return [];
    return capabilitySatisfiesCatalogOutcomeRequirement(capability, requirement) ? [index] : [];
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
    ? `Distinct first-party outcomes still required by corroborated structural evidence: ${JSON.stringify(relevant.map(requirement => ({ audience: requirement.audience, outcome: requirement.statement, candidate_ids: requirement.candidateIds })))}. Return one distinct outcome for each entry, including separate outcomes for different explicit audiences.`
    : '';
}
