import type { SystemCapability } from '../../types/cas.types';
import { capabilityCatalogOutcomesMayMerge } from './capability-catalog-outcome-coverage';
import { capabilityTitlesShareOutcome } from './capability-catalog-scheduling';
import { applyPreferredAiCapabilityDescription } from './capability-merge';
import { projectReversibleCapabilityEvidence } from './capability-operation-attribution';

interface CapabilityDeduplicationDependencies {
  stemTerminologyToken(token: string): string;
  uniqueCapabilityOperations(...groups: ReadonlyArray<SystemCapability['operations']>): SystemCapability['operations'];
}

export function dedupeSystemCapabilitiesByEntitySet(
  capabilities: SystemCapability[],
  preserveExactCandidateIdentity: boolean,
  dependencies: CapabilityDeduplicationDependencies,
): SystemCapability[] {
  const criticalityRank: Record<SystemCapability['criticality'], number> = {
    critical: 4,
    high: 3,
    medium: 2,
    low: 1,
  };
  const categoryRank: Record<SystemCapability['category'], number> = {
    core: 4,
    supporting: 3,
    admin: 2,
    internal: 1,
  };
  const normalizeEntityRef = (reference: string) =>
    String(reference || '').toLowerCase().replace(/^entity_/, '').replace(/[^a-z0-9]/g, '');
  const entitySetOf = (capability: SystemCapability) =>
    new Set((capability.related_entities || []).map(normalizeEntityRef).filter(Boolean));
  const richness = (capability: SystemCapability) =>
    categoryRank[capability.category] * 1000 +
    (capability.description_source === 'ai' ? 500 : 0) +
    Math.min(capability.operations.length, 99);
  const operationKey = (operation: SystemCapability['operations'][number]) =>
    [operation.entry_point_id, operation.entry_point_type, operation.action, operation.path_or_command].join('|'); const exactObligationKey = (capability: SystemCapability) => (capability.criticality_factors || []).filter(factor => factor.startsWith('catalog-candidate:operation-obligation:') || factor.startsWith('catalog-operation-obligation:')).sort().join('|');

  const subjectPhraseOf = (capability: SystemCapability): string =>
    String(capability.name || '')
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .toLowerCase()
      .replace(/^\s*(?:lets|allows|enables)\s+users\s+(?:to\s+)?/i, '')
      .replace(/^\s*(provides?|surfaces?|tracks?|categorizes?|categorises?|organizes?|organises?|classifies?|groups?|exposes?|manages?|monitors?|secures?|handles?|enforces?|settles?|delivers?|renders?|displays?|shows?|creates?|updates?|deletes?|lists?|views?|reads?|browses?|searches?|finds?|adds?|removes?|edits?|posts?|comments?|favorites?|favourites?|unfavorites?|unfavourites?|follows?|unfollows?|automates?|trains?|syncs?|synchronizes?|synchronises?)\s+/i, '')
      .replace(/\s+(results?|insights?|data|info|information|details?|records?|entries?|items?)\s*$/i, '')
      .replace(/\s+capabilit(?:y|ies)\s*$/i, '')
      .replace(/\s+(?:management|maintenance)\s*$/i, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  const semanticSubjectTokens = (capability: SystemCapability): Set<string> => new Set(
    subjectPhraseOf(capability)
      .split(/\s+/)
      .map(token => dependencies.stemTerminologyToken(token))
      .filter(token => token.length >= 3 && !['from', 'via', 'with', 'using'].includes(token)),
  );
  const subjectsSemanticallyOverlap = (left: SystemCapability, right: SystemCapability): boolean => {
    const leftTokens = semanticSubjectTokens(left);
    const rightTokens = semanticSubjectTokens(right);
    if (leftTokens.size === 0 || rightTokens.size === 0) return false;
    const shared = [...leftTokens].filter(token => rightTokens.has(token)).length;
    return shared / Math.min(leftTokens.size, rightTokens.size) >= 0.6;
  };
  const purposeActionClass = (capability: SystemCapability): string => {
    const action = String(capability.name || '')
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .toLowerCase()
      .replace(/^\s*(?:lets|allows|enables)\s+users\s+(?:to\s+)?/i, '')
      .match(/^[a-z]+/)?.[0] || '';
    if (/^unfavou?rite/.test(action)) return 'unfavorite';
    if (/^favou?rite/.test(action)) return 'favorite';
    if (/^unfollow/.test(action)) return 'unfollow';
    if (/^follow/.test(action)) return 'follow';
    if (/^(?:create|update|delete|manage|add|remove|edit|write|modify|post|comment)/.test(action)) return 'mutate';
    if (/^(?:categorize|categorise|organize|organise|classify|group)/.test(action) ||
      (/^track/.test(action) && /\bby\b/i.test(capability.name))) return 'organize';
    if (/^automate/.test(action)) return 'automate';
    if (/^(?:sync|synchronize|synchronise)/.test(action)) return 'synchronize';
    if (/^(?:provide|surface|track|monitor|display|show|view|list|read|browse|search|find|access|retrieve|expose)/.test(action)) return 'observe';
    if (/^(?:attach|correlate|secure|handle|enforce|settle|deliver|render|train)/.test(action)) {
      return action.replace(/(?:es|s)$/, '');
    }
    return '';
  };
  const outcomeActionsConflict = (left: SystemCapability, right: SystemCapability): boolean => {
    const actionPair = [purposeActionClass(left), purposeActionClass(right)].sort().join(':');
    return actionPair === 'favorite:unfavorite' || actionPair === 'follow:unfollow';
  };
  const unboundOutcomesMayMerge = (left: SystemCapability, right: SystemCapability): boolean => {
    const leftAction = purposeActionClass(left);
    const rightAction = purposeActionClass(right);
    if (outcomeActionsConflict(left, right)) return false;
    return capabilityTitlesShareOutcome(left, right) ||
      subjectPhraseOf(left) === subjectPhraseOf(right) || (
      leftAction.length > 0 &&
      leftAction === rightAction &&
      subjectsSemanticallyOverlap(left, right)
    );
  };
  const hasExactEntityAndOperationEvidence = (left: SystemCapability, right: SystemCapability): boolean => {
    const leftEntities = entitySetOf(left);
    const rightEntities = entitySetOf(right);
    if (leftEntities.size === 0 || leftEntities.size !== rightEntities.size) return false;
    if ([...leftEntities].some(entity => !rightEntities.has(entity))) return false;
    const leftOperations = new Set(left.operations.map(operationKey));
    const rightOperations = new Set(right.operations.map(operationKey));
    if (leftOperations.size === 0 || rightOperations.size === 0) return false;
    return [...leftOperations].every(operation => rightOperations.has(operation)) || [...rightOperations].every(operation => leftOperations.has(operation));
  };
  const exactCatalogCandidateKey = (capability: SystemCapability) => (capability.criticality_factors || [])
    .filter(factor => factor.startsWith('catalog-candidate:') && !factor.startsWith('catalog-candidate:operation-obligation:'))
    .sort().join('|');
  const exactRequirementKey = (capability: SystemCapability) => (capability.criticality_factors || [])
    .filter(factor => factor.startsWith('catalog-outcome-requirement:')).sort().join('|');
  const entityDedupeOutcomesMayMerge = (left: SystemCapability, right: SystemCapability): boolean => {
    if (preserveExactCandidateIdentity && exactObligationKey(left) !== exactObligationKey(right)) return false;
    if (outcomeActionsConflict(left, right)) return false;
    const leftCandidateIds = new Set(exactCatalogCandidateKey(left).split('|').filter(Boolean));
    const sameEvidenceIdentity = [...leftCandidateIds].some(candidateId => exactCatalogCandidateKey(right).split('|').includes(candidateId)) &&
      exactRequirementKey(left) === exactRequirementKey(right) &&
      subjectsSemanticallyOverlap(left, right);
    const leftHasBoundOutcome = exactRequirementKey(left).length > 0;
    const rightHasBoundOutcome = exactRequirementKey(right).length > 0;
    const compatibleBoundAndUnboundOutcome = leftHasBoundOutcome !== rightHasBoundOutcome &&
      unboundOutcomesMayMerge(left, right);
    const compatibleUnboundOutcomes = !leftHasBoundOutcome && !rightHasBoundOutcome &&
      (hasExactEntityAndOperationEvidence(left, right) || unboundOutcomesMayMerge(left, right));
    if (!sameEvidenceIdentity && !capabilityCatalogOutcomesMayMerge(left, right) &&
      !compatibleBoundAndUnboundOutcome && !compatibleUnboundOutcomes) return false;
    if (sameEvidenceIdentity || hasExactEntityAndOperationEvidence(left, right)) return true;
    const hasBoundOutcome = [left, right].some(capability =>
      (capability.criticality_factors || []).some(factor => factor.startsWith('catalog-outcome-requirement:')));
    return hasBoundOutcome || unboundOutcomesMayMerge(left, right);
  };

  const removed = new Set<SystemCapability>();
  const mergeInto = (winner: SystemCapability, loser: SystemCapability) => {
    if (!entityDedupeOutcomesMayMerge(winner, loser)) return false;
    applyPreferredAiCapabilityDescription(winner, loser);
    winner.related_entities = Array.from(new Set([...winner.related_entities, ...loser.related_entities]));
    winner.related_domains = Array.from(new Set([...winner.related_domains, ...loser.related_domains]));
    winner.depends_on = [...new Map([...(winner.depends_on || []), ...(loser.depends_on || [])].map(dependency => [
      [dependency.from_capability, dependency.to_capability, dependency.dependency_type].join(':'), dependency,
    ])).values()];
    winner.criticality = criticalityRank[loser.criticality] > criticalityRank[winner.criticality]
      ? loser.criticality
      : winner.criticality;
    const projectedEntityEvidence = projectReversibleCapabilityEvidence(
      winner.name, dependencies.uniqueCapabilityOperations(winner.operations, loser.operations),
      [...new Set([...winner.criticality_factors, ...loser.criticality_factors])],
    );
    winner.operations = projectedEntityEvidence.operations;
    winner.criticality_factors = projectedEntityEvidence.criticalityFactors;
    if (winner.category !== 'core' && loser.category === 'core') {
      winner.category = loser.category;
    }
    removed.add(loser);
    return true;
  };

  const isSurfaceCap = (capability: SystemCapability) => capability.evidence_kind === 'behavior-surface';

  const bySetKey = new Map<string, SystemCapability>();
  for (const capability of capabilities) {
    if (isSurfaceCap(capability)) continue;
    const set = entitySetOf(capability);
    if (set.size === 0) continue;
    const key = `${[...set].sort().join('|')}::${subjectPhraseOf(capability)}`;
    const existing = bySetKey.get(key);
    if (!existing) {
      bySetKey.set(key, capability);
      continue;
    }
    if (richness(capability) > richness(existing)) {
      if (mergeInto(capability, existing)) {
        bySetKey.set(key, capability);
      } else {
        bySetKey.set(`${key}::${capability.id}`, capability);
      }
    } else {
      if (!mergeInto(existing, capability)) {
        bySetKey.set(`${key}::${capability.id}`, capability);
      }
    }
  }
  const anchored = [...bySetKey.values()];
  for (const capability of anchored) {
    if (removed.has(capability)) continue;
    const set = entitySetOf(capability);
    const superset = anchored.find(other => {
      if (other === capability || removed.has(other)) return false;
      const otherSet = entitySetOf(other);
      if (otherSet.size < set.size) return false;
      if (otherSet.size === set.size) {
        const otherRichness = richness(other);
        const ownRichness = richness(capability);
        if (otherRichness < ownRichness) return false;
        if (otherRichness === ownRichness && other.id <= capability.id) return false;
      }
      for (const name of set) {
        if (!otherSet.has(name)) return false;
      }
      const supersetOperations = new Set(other.operations.map(operationKey));
      if (!capability.operations.every(operation => supersetOperations.has(operationKey(operation)))) return false;
      if (otherSet.size === set.size) {
        const ownOperations = new Set(capability.operations.map(operationKey));
        if (!other.operations.every(operation => ownOperations.has(operationKey(operation)))) return false;
      }
      return true;
    });
    if (superset) mergeInto(superset, capability);
  }

  const opSurvivors = capabilities.filter(capability =>
    !removed.has(capability) && !isSurfaceCap(capability) && capability.operations.length > 0);
  for (const capability of opSurvivors) {
    if (removed.has(capability)) continue;
    const ownOperationKeys = new Set(capability.operations.map(operationKey));
    const opSuperset = opSurvivors.find(other => {
      if (other === capability || removed.has(other)) return false;
      if (other.id === capability.id) return entityDedupeOutcomesMayMerge(capability, other);
      const otherOperationKeys = new Set(other.operations.map(operationKey));
      if (otherOperationKeys.size < ownOperationKeys.size) return false;
      for (const key of ownOperationKeys) {
        if (!otherOperationKeys.has(key)) return false;
      }
      if (!entityDedupeOutcomesMayMerge(capability, other)) return false;
      if (otherOperationKeys.size > ownOperationKeys.size) return true;
      const titleSpecificity = (candidate: SystemCapability) =>
        String(candidate.name || '').split(/[^a-z0-9]+/i).filter(Boolean).length;
      const otherSpecificity = titleSpecificity(other);
      const ownSpecificity = titleSpecificity(capability);
      if (otherSpecificity !== ownSpecificity) return otherSpecificity > ownSpecificity;
      const otherRichness = richness(other);
      const ownRichness = richness(capability);
      if (otherRichness !== ownRichness) return otherRichness > ownRichness;
      return other.id > capability.id;
    });
    if (opSuperset) mergeInto(opSuperset, capability);
  }

  const primaryEntityOf = (capability: SystemCapability): string =>
    normalizeEntityRef((capability.related_entities || [])[0] || '');
  const survivors = capabilities.filter(capability => !removed.has(capability) && !isSurfaceCap(capability));
  for (const capability of survivors) {
    if (removed.has(capability)) continue;
    const primary = primaryEntityOf(capability);
    if (!primary) continue;
    const subject = subjectPhraseOf(capability);
    if (!subject) continue;
    const domains = new Set((capability.related_domains || []).map(d => normalizeEntityRef(String(d))));
    for (const other of survivors) {
      if (other === capability || removed.has(other) || removed.has(capability)) continue;
      const crossEntityOutcome = Boolean(exactRequirementKey(capability)) !== Boolean(exactRequirementKey(other)) && purposeActionClass(capability) === purposeActionClass(other) && subjectsSemanticallyOverlap(capability, other); if (primaryEntityOf(other) !== primary && !crossEntityOutcome) continue;
      if (!unboundOutcomesMayMerge(capability, other) && !(exactRequirementKey(capability) === exactRequirementKey(other) && exactCatalogCandidateKey(capability).split('|').some(candidateId => candidateId && exactCatalogCandidateKey(other).split('|').includes(candidateId)) && subjectsSemanticallyOverlap(capability, other))) continue;
      const otherDomains = new Set((other.related_domains || []).map(d => normalizeEntityRef(String(d))));
      const domainOverlap = domains.size === 0 || otherDomains.size === 0 ||
        [...domains].some(d => otherDomains.has(d));
      if (!domainOverlap && !crossEntityOutcome) continue;
      if (richness(capability) >= richness(other)) mergeInto(capability, other);
      else mergeInto(other, capability);
    }
  }

  const nameTokenSetOf = (capability: SystemCapability): Set<string> =>
    new Set(subjectPhraseOf(capability).split(/\s+/).filter(Boolean));
  const operationPathsOf = (capability: SystemCapability): Set<string> =>
    new Set((capability.operations || [])
      .map(operation => operation.path_or_command)
      .filter((value): value is string => Boolean(value)));
  const emptyEntityCapabilities = capabilities.filter(capability =>
    !removed.has(capability) && !isSurfaceCap(capability) && entitySetOf(capability).size === 0);
  for (const capability of emptyEntityCapabilities) {
    if (removed.has(capability)) continue;
    const tokens = nameTokenSetOf(capability);
    if (tokens.size === 0) continue;
    const domains = new Set((capability.related_domains || []).map(d => normalizeEntityRef(String(d))));
    const paths = operationPathsOf(capability);
    for (const other of emptyEntityCapabilities) {
      if (other === capability || removed.has(other) || removed.has(capability)) continue;
      const otherTokens = nameTokenSetOf(other);
      if (otherTokens.size === 0) continue;
      const overlapCount = [...tokens].filter(token => otherTokens.has(token)).length;
      const similarity = overlapCount / Math.max(tokens.size, otherTokens.size);
      if (similarity < 0.6) continue;
      const otherDomains = new Set((other.related_domains || []).map(d => normalizeEntityRef(String(d))));
      const otherPaths = operationPathsOf(other);
      const sharedDomain = domains.size > 0 && otherDomains.size > 0 &&
        [...domains].some(d => otherDomains.has(d));
      const sharedPath = paths.size > 0 && otherPaths.size > 0 &&
        [...paths].some(p => otherPaths.has(p));
      if (!sharedDomain && !sharedPath) continue;
      if (richness(capability) >= richness(other)) mergeInto(capability, other);
      else mergeInto(other, capability);
    }
  }

  return capabilities.filter(capability => !removed.has(capability));
}
