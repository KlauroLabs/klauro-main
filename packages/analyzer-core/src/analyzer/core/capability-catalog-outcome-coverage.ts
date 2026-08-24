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
  const value = token.toLowerCase().replace(/(?:ing|ed|es|s)$/i, '');
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
    .filter(token => token.length >= 3)
    .map(canonicalToken)
    .filter(token => token.length >= 3))];
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
  return [signal?.productDocSummary, signal?.manifestDescription]
    .filter((value): value is string => Boolean(value))
    .flatMap(value => value.split(/(?<=[.!?;])\s+|\s*,\s*(?:and\s+)?/i))
    .flatMap(splitCoordinatedClause)
    .map(value => value.trim().replace(/^[,;]\s*/, ''))
    .filter(value => value.length >= 20 && !/^.+?\s+(?:is|are)\s+(?:an?\s+|the\s+)?[^,.]+$/i.test(value));
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
  for (const clause of productClauses(signal)) {
    const subjectTokens = tokens(clause, true);
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
      const id = requirementId(audience, subjectTokens);
      requirements.set(id, { audience, candidateIds, id, statement: clause, subjectTokens });
    }
  }
  return [...requirements.values()];
}

function capabilityMatchesAudience(capabilityText: string, audience?: 'agent' | 'human'): boolean {
  if (!audience) return true;
  return audience === 'human' ? humanAudience.test(capabilityText) : agentAudience.test(capabilityText);
}

export function uncoveredCapabilityCatalogOutcomeRequirements(
  capabilities: readonly SystemCapability[],
  requirements: readonly CapabilityCatalogOutcomeRequirement[],
): CapabilityCatalogOutcomeRequirement[] {
  const matches = requirements.map(requirement => capabilities.flatMap((capability, index) => {
    const capabilityText = `${capability.name || ''} ${capability.description || ''}`;
    if (!capabilityMatchesAudience(capabilityText, requirement.audience)) return [];
    const capabilityTokens = new Set(tokens(capabilityText));
    const matchingSubjects = requirement.subjectTokens.filter(token => capabilityTokens.has(token));
    const requiredMatches = Math.min(2, requirement.subjectTokens.length);
    return matchingSubjects.length >= requiredMatches ? [index] : [];
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
