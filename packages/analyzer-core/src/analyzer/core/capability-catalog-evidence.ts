import { CASDataEntity, SystemCapability } from '../../types/cas.types';
import { USER_FACING_ENTRY_TYPES } from './journey-builder';
import { analyzeTerminality } from './terminality';

export interface CapabilityCatalogProjectSignal {
  concepts?: string[];
  productDocTitle?: string;
  productDocSummary?: string;
  manifestDescription?: string;
  summary?: string;
}

function normalizedSubjectTokens(value: string): Set<string> {
  const scaffolding = new Set(['management', 'capability', 'workflow', 'handling', 'operation', 'operations']);
  return new Set(String(value || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(token => token.length >= 3 && !scaffolding.has(token))
    .map(token => token.length > 4 && token.endsWith('s') && !token.endsWith('ss') ? token.slice(0, -1) : token));
}

function productTextCorroborates(candidate: SystemCapability, signal?: CapabilityCatalogProjectSignal): boolean {
  if (!signal) return false;
  const productTokens = normalizedSubjectTokens([
    ...(signal.concepts || []),
    signal.productDocTitle,
    signal.productDocSummary,
    signal.manifestDescription,
    signal.summary,
  ].filter(Boolean).join(' '));
  const subjectTokens = normalizedSubjectTokens([candidate.structural_label, candidate.name].filter(Boolean).join(' '));
  const matches = [...subjectTokens].filter(token => productTokens.has(token)).length;
  return subjectTokens.size > 0 && matches >= Math.min(2, subjectTokens.size);
}

function isCorroboratedInternalBehavior(candidate: SystemCapability, signal?: CapabilityCatalogProjectSignal): boolean {
  const operations = candidate.operations || [];
  if (operations.length < 2 || !operations.every(operation => operation.entry_point_type === 'internal')) return false;
  if (!productTextCorroborates(candidate, signal)) return false;
  return candidate.category === 'core' || operations.some(operation => !/^(?:coordinate|handle|process)$/i.test(operation.action || ''));
}

export function catalogCandidateTerminality(candidates: SystemCapability[]) {
  const candidateIds = new Set(candidates.map(candidate => candidate.id));
  return new Map(analyzeTerminality(
    candidateIds,
    candidates.flatMap(candidate => (candidate.depends_on || [])
      .filter(dependency => candidateIds.has(dependency.to_capability))
      .map(dependency => ({ source: dependency.to_capability, target: dependency.from_capability }))),
  ).map(member => [member.id, member]));
}

export function behaviorSurfaceEntryCount(surface: SystemCapability): number {
  const factorMatch = /^\s*(\d+)\b/.exec((surface.criticality_factors || [])[0] || '');
  if (factorMatch) return Number(factorMatch[1]);
  const descriptionMatch = /Behavior surface:\s*(\d+)\b/i.exec(surface.description || '');
  return descriptionMatch ? Number(descriptionMatch[1]) : (surface.operations || []).length;
}

export function catalogBehaviorSurfaceCandidates(surfaces: SystemCapability[]): SystemCapability[] {
  return surfaces.filter(surface => {
    const entryCount = behaviorSurfaceEntryCount(surface);
    const cohesiveFamily = (surface.criticality_factors || []).some(factor => /cohesive behavior family\s*\('/i.test(factor));
    const eligible = entryCount >= 15 || (surface.evidence_kind === 'behavior-surface' && cohesiveFamily && entryCount >= 2);
    const operations = surface.operations || [];
    if (!eligible || operations.every(operation => operation.entry_point_type === 'external')) return false;
    return operations.length === 0 || !operations.every(operation =>
      operation.entry_point_type === 'page' || operation.entry_point_type === 'route');
  });
}

export function firstPartySupportsIdentityProduct(signal?: CapabilityCatalogProjectSignal): boolean {
  if (!signal) return false;
  const text = [signal.productDocTitle, signal.productDocSummary, signal.manifestDescription, signal.summary]
    .filter(Boolean)
    .join(' ');
  const identity = '(?:identity|authentication|authorization|access[ -]?control)';
  const product = '(?:platform|service|provider|product|system|server|gateway)';
  return new RegExp(`\\b${identity}\\b[^.]{0,60}\\b${product}\\b|\\b${product}\\b[^.]{0,60}\\b${identity}\\b`, 'i').test(text) ||
    new RegExp(`\\b(?:provides?|delivers?|offers?|sells?|issues?|verifies?|authenticates?|authorizes?)\\b[^.]{0,60}\\b${identity}\\b`, 'i').test(text);
}

export function catalogEvidenceCandidates(
  candidates: SystemCapability[],
  behaviorSurfaces: SystemCapability[],
  dataEntities?: CASDataEntity[],
  artifactType = 'app',
  projectTextSignal?: CapabilityCatalogProjectSignal,
): SystemCapability[] {
  const productEntityIds = new Set((dataEntities || [])
    .filter(entity => !entity.kind || entity.kind === 'persisted-entity' || entity.kind === 'api-response')
    .map(entity => entity.id));
  const scopeCandidates = dataEntities === undefined || ['library', 'client-sdk', 'infrastructure'].includes(artifactType)
    ? candidates
    : candidates.filter(candidate => {
        const operations = candidate.operations || [];
        const hasProductEntity = (candidate.related_entities || []).some(entityId => productEntityIds.has(entityId));
        const presentationOnly = operations.length > 0 &&
          operations.some(operation => /^(?:page|route)$/i.test(operation.entry_point_type || '')) &&
          operations.every(operation => /^(?:page|route|event)$/i.test(operation.entry_point_type || ''));
        if (presentationOnly && !hasProductEntity) return false;
        const userFacingOperation = operations.some(operation =>
          USER_FACING_ENTRY_TYPES.has(operation.entry_point_type as never) ||
          /^(?:message|event|schedule|queue)$/i.test(operation.entry_point_type || ''));
        const pageOnly = operations.length > 0 && operations.every(operation => /^(?:page|route)$/i.test(operation.entry_point_type || ''));
        return (!pageOnly && userFacingOperation) || hasProductEntity || isCorroboratedInternalBehavior(candidate, projectTextSignal);
      });
  const result = [...scopeCandidates];
  const ids = new Set(scopeCandidates.map(candidate => candidate.id).filter(Boolean));
  const eligibleSurfaces = catalogBehaviorSurfaceCandidates(behaviorSurfaces);
  const operationIds = (surface: SystemCapability) => new Set((surface.operations || []).map(operation => operation.entry_point_id).filter(Boolean));
  const semanticSurfaces = eligibleSurfaces.filter((surface, index) => {
    const surfaceTokens = new Set(String(surface.name || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
    const transportTokens = new Set(['mcp', 'tool', 'tools', 'message', 'event', 'command', 'surface']);
    if (surfaceTokens.size > 0 && [...surfaceTokens].every(token => transportTokens.has(token))) {
      const semanticChildren = eligibleSurfaces.filter((other, otherIndex) => {
        if (otherIndex === index) return false;
        const otherTokens = new Set(String(other.name || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
        return otherTokens.size > surfaceTokens.size && [...surfaceTokens].every(token => otherTokens.has(token));
      });
      if (semanticChildren.length >= 2) return false;
    }
    const own = operationIds(surface);
    if (own.size === 0) return true;
    const contributors = eligibleSurfaces
      .map((other, otherIndex) => otherIndex === index ? undefined : operationIds(other))
      .filter((other): other is Set<string> => Boolean(other && [...own].some(id => other.has(id))));
    const covered = new Set(contributors.flatMap(other => [...other].filter(id => own.has(id))));
    const ownExamples = new Set((surface.evidence_examples || []).map(value => String(value).toLowerCase()));
    const exampleContributors = eligibleSurfaces
      .filter((_, otherIndex) => otherIndex !== index)
      .map(other => new Set((other.evidence_examples || []).map(value => String(value).toLowerCase())))
      .filter(other => [...ownExamples].some(example => other.has(example)));
    const coveredExamples = new Set(exampleContributors.flatMap(other => [...other].filter(example => ownExamples.has(example))));
    return !(contributors.length >= 2 && covered.size / own.size >= 0.75) &&
      !(ownExamples.size > 0 && exampleContributors.length >= 2 && coveredExamples.size / ownExamples.size >= 0.75);
  });
  for (const surface of semanticSurfaces) {
    if (surface.id && ids.has(surface.id)) continue;
    result.push(surface);
    if (surface.id) ids.add(surface.id);
  }
  if (artifactType !== 'app' || !projectTextSignal || firstPartySupportsIdentityProduct(projectTextSignal)) return result;
  return result.filter(candidate => !/\b(?:auth|authentication|authorization|identity|permissions?|sessions?|access[ -]?control)\b/i
    .test([candidate.name, ...(candidate.evidence_examples || [])].join(' ')));
}
