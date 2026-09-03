import type { SystemCapability } from '../../types/cas.types';
import { canonicalCapabilityCatalogOutcomeToken, capabilityCatalogOutcomeRepairNudge, capabilityPotentiallySatisfiesCatalogOutcomeRequirement, capabilitySemanticallySatisfiesCatalogOutcomeRequirement, type CapabilityCatalogOutcomeRequirement } from './capability-catalog-outcome-coverage';
import { capabilityEvidenceSubjectTokens } from './capability-catalog-evidence';
import { outcomeIdentityTokens } from './capability-evidence-language';
import { CAPABILITY_PURPOSE_VERBS } from './capability-naming';
import { observedCapabilityLifecycleActions } from './capability-lifecycle-actions';

export type CapabilityCatalogRepairBatch =
  | { mode: 'outcome'; candidateIds: string[]; requirements: CapabilityCatalogOutcomeRequirement[] }
  | { mode: 'evidence'; candidateIds: string[]; requirements: [] }
  | { mode: 'description'; candidateIds: string[]; requirements: CapabilityCatalogOutcomeRequirement[]; identity: SystemCapability; repairName?: boolean };

export interface PendingCapabilityEvidenceIdentity {
  audience: string;
  candidateId: string;
  evidenceDigest: string;
  familyKey: string;
  fallbackAttempted: boolean;
  identity: SystemCapability;
}

const factors = (capability: Partial<Pick<SystemCapability, 'criticality_factors'>>, prefix: string): string[] =>
  (capability.criticality_factors || []).filter(value => value.startsWith(prefix)).map(value => value.slice(prefix.length));

export function capabilityCatalogRepairLifecycleKey(
  capability: Pick<SystemCapability, 'id'> & Partial<Pick<SystemCapability, 'criticality_factors'>>,
): string {
  const requirementIds = [...new Set(factors(capability, 'catalog-outcome-requirement:'))].sort();
  if (requirementIds.length > 0) return `requirement:${requirementIds.join('|')}`;
  const candidateIds = [...new Set(factors(capability, 'catalog-candidate:'))].sort();
  if (candidateIds.length === 1) return `candidate:${candidateIds[0]}`;
  if (candidateIds.length > 1) return `candidates:${candidateIds.join('|')}`;
  return capability.id;
}

const descriptionWords = (value: string): string[] => String(value || '').trim().split(/\s+/).filter(Boolean);

const descriptionTokens = (value: string): string[] => [...new Set(String(value || '').toLowerCase()
  .split(/[^a-z0-9]+/)
  .filter(token => token.length >= 3)
  .map(canonicalCapabilityCatalogOutcomeToken))];

const descriptionAudiencePattern = (audience: string): RegExp => {
  const normalized = audience.toLowerCase();
  if (/^(?:user|users|people|person|humans?|customers?)$/.test(normalized)) {
    return /\b(?:you|users?|people|person|humans?|customers?)\b/i;
  }
  const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`, 'i');
};

const publicationAction = (action: string): string => {
  const normalized = canonicalCapabilityCatalogOutcomeToken(action);
  if (/^(?:browse|fetch|filter|find|get|list|read|retrieve|search|show)$/.test(normalized)) return 'view';
  if (/^(?:add|attach|connect|import|publish|record|register|submit|upload)$/.test(normalized)) return 'create';
  if (/^(?:adjust|change|edit|set|sync|synchronize)$/.test(normalized)) return 'update';
  if (/^(?:archive|cancel|delete|unfavorite|unfollow|withdraw)$/.test(normalized)) return 'remove';
  return normalized;
};

const publicationActions = new Set([
  'accept', 'archive', 'authenticate', 'cancel', 'categorize', 'close', 'create', 'decline', 'edit', 'favorite', 'filter', 'follow', 'manage', 'organize', 'remove',
  'run', 'search', 'test', 'track', 'unfavorite', 'unfollow', 'update', 'view', 'withdraw',
]);

const publicationActionsForOperations = (operations: readonly SystemCapability['operations'][number][]): string[] =>
  [...new Set(observedCapabilityLifecycleActions(operations)
    .flatMap(action => descriptionTokens(action).map(publicationAction))
    .filter(action => publicationActions.has(action)))];

const titleActionFamilies = (title: string): string[] => {
  const familyByAction: Record<string, string[]> = {
    access: ['view'], attach: ['create', 'update'], authenticate: ['authenticate'], manage: ['manage', 'create', 'view', 'update', 'remove'],
    configure: ['create', 'update'], control: ['create', 'view', 'update', 'remove'], customize: ['update'], download: ['view'], maintain: ['create', 'view', 'update', 'remove'],
    monitor: ['track', 'view', 'update'], organize: ['create', 'view', 'update'],
    plan: ['create', 'view', 'update'], reconcile: ['view', 'update'],
    track: ['create', 'track', 'view', 'update'],
  };
  const rawTokens = String(title || '').toLowerCase().split(/[^a-z0-9]+/)
    .filter(token => token.length >= 3);
  for (const rawToken of rawTokens) {
    const canonicalToken = canonicalCapabilityCatalogOutcomeToken(rawToken);
    const families = familyByAction[rawToken] || familyByAction[canonicalToken] ||
      [publicationAction(canonicalToken)].filter(action => publicationActions.has(action));
    if (families.length > 0) return families;
  }
  return [];
};

const descriptionContainsAction = (description: string, action: string): boolean => {
  if (action === 'create') return /\b(?:add|adds|added|adding|creat(?:e|es|ed|ing|ion)|publish(?:es|ed|ing)?|register(?:s|ed|ing)?|submit(?:s|ted|ting)?)\b/i.test(description);
  if (action === 'view') return /\b(?:access(?:es|ed|ing)?|brows(?:e|es|ed|ing)|display(?:s|ed|ing)?|fetch(?:es|ed|ing)?|filter(?:s|ed|ing)?|find(?:s|ing)?|get(?:s|ting)?|list(?:s|ed|ing)?|read(?:s|ing)?|retriev(?:e|es|ed|ing)|search(?:es|ed|ing)?|see|sees|seeing|seen|show(?:s|ed|ing)?|surfac(?:e|es|ed|ing)|view(?:s|ed|ing)?|visibility|visible)\b/i.test(description);
  if (action === 'categorize') return /\bcategor(?:ize|izes|ized|izing)\b/i.test(description);
  if (action === 'close') return /\bclos(?:e|es|ed|ing)\b/i.test(description);
  if (action === 'organize') return /\borganiz(?:e|es|ed|ing)\b/i.test(description);
  if (action === 'update') return /\b(?:categor(?:ize|izes|ized|izing)|chang(?:e|es|ed|ing)|clos(?:e|es|ed|ing)|edit(?:s|ed|ing)?|maintain(?:s|ed|ing)?|organiz(?:e|es|ed|ing)|updat(?:e|es|ed|ing))\b/i.test(description);
  if (action === 'remove') return /\b(?:delet(?:e|es|ed|ing|ion)|remove|removes|removed|removing|unfavou?rit(?:e|es|ed|ing)|unfollow(?:s|ed|ing)?)\b/i.test(description);
  if (action === 'unfavorite') return /\bunfavou?rit(?:e|es|ed|ing)\b/i.test(description);
  if (action === 'unfollow') return /\bunfollow(?:s|ed|ing)?\b/i.test(description);
  if (action === 'archive') return /\barchiv(?:e|es|ed|ing)\b/i.test(description);
  if (action === 'cancel') return /\bcancel(?:s|ed|led|ing|ling)?\b/i.test(description);
  if (action === 'withdraw') return /\bwithdraw(?:s|n|ing)?\b/i.test(description);
  return descriptionTokens(description).includes(canonicalCapabilityCatalogOutcomeToken(action));
};

const pluralSubject = (subject: string): string => {
  if (/ies$/.test(subject) || /s$/.test(subject)) return subject;
  if (/[^aeiou]y$/.test(subject)) return `${subject.slice(0, -1)}ies`;
  return `${subject}s`;
};

export function capabilityEvidenceIdentityDigest(candidate: SystemCapability): string {
  return JSON.stringify({
    id: candidate.id,
    entities: [...(candidate.related_entities || [])].sort(),
    operations: (candidate.operations || []).map(operation => [
      operation.entry_point_id, operation.entry_point_type, operation.action,
      operation.path_or_command || '', operation.trigger?.method || '', operation.trigger?.path || '',
    ].join('|')).sort(),
  });
}

export function pendingCapabilityEvidenceObservableActionFailure(
  capability: Pick<SystemCapability, 'name'>,
  candidate: SystemCapability,
): string | undefined {
  return capabilityTextObservableActionFailure(capability, candidate, false);
}

export function capabilityTextObservableActionFailure(
  capability: Pick<SystemCapability, 'name'> & Partial<Pick<SystemCapability, 'description' | 'criticality_factors'>>,
  candidate: SystemCapability,
  includeDescription = true,
): string | undefined {
  const rawObservedActions = [...new Set(observedCapabilityLifecycleActions(candidate.operations || [])
    .map(canonicalCapabilityCatalogOutcomeToken).filter(Boolean))];
  const observedActions = rawObservedActions.map(publicationAction).filter(action => publicationActions.has(action));
  const interactionVerb = candidate.id.startsWith('operation-obligation:')
    ? descriptionTokens(candidate.structural_label || candidate.name).find(token => /^(?:browse|fetch|filter|import|list|load|retrieve|search)$/.test(token))
    : undefined;
  const groupedOperationCapability = factors(capability, 'catalog-candidate:')
    .filter(candidateId => candidateId.startsWith('operation-obligation:'))
    .length > 1;
  if (interactionVerb && !groupedOperationCapability && !new RegExp(`\\b${interactionVerb}(?:es|ed|ing)?\\b`, 'i').test(capability.name)) {
    return `required-observable-interaction-missing:${interactionVerb}`;
  }
  const supportedTitleActions = titleActionFamilies(capability.name);
  const titleSupportsObservedAction = supportedTitleActions.some(action => observedActions.includes(action));
  const descriptionSupportsObservedAction = includeDescription &&
    observedActions.some(action => descriptionContainsAction(capability.description || '', action));
  return observedActions.length > 0 && !titleSupportsObservedAction && !descriptionSupportsObservedAction
    ? 'required-observable-action-missing:' + observedActions.join(',')
    : undefined;
}

export function establishPendingCapabilityEvidenceIdentity(args: {
  registry: Map<string, PendingCapabilityEvidenceIdentity>;
  capability: SystemCapability;
  candidate?: SystemCapability;
  requestedCandidateIds: readonly string[];
  requiredUncoveredCandidateIds: ReadonlySet<string>;
  familyKey?: string;
  audience?: string;
  descriptionFailure?: string;
  alreadyPublishedCandidateIds: ReadonlySet<string>;
  postReconciliation?: boolean;
}): boolean {
  if (args.requestedCandidateIds.length !== 1 || !args.candidate || !args.familyKey || !args.audience ||
      !args.descriptionFailure ||
      !args.requiredUncoveredCandidateIds.has(args.candidate.id) ||
      args.alreadyPublishedCandidateIds.has(args.candidate.id)) return false;
  const citations = factors(args.capability, 'catalog-candidate:');
  const titleTokens = outcomeNameTokens(args.capability.name);
  const evidenceSubjects = capabilityEvidenceSubjectTokens(args.candidate);
  const reconciledSubjectMatch = Boolean(args.postReconciliation) && evidenceSubjects.some(subject =>
    titleTokens.some(token => token === subject ||
      (Math.min(token.length, subject.length) >= 5 && (token.startsWith(subject) || subject.startsWith(token)))));
  if (citations.length !== 1 || citations[0] !== args.candidate.id || args.requestedCandidateIds[0] !== args.candidate.id ||
      factors(args.capability, 'catalog-outcome-requirement:').length > 0 ||
      titleTokens.length < 2 ||
      !(capabilitySemanticallySatisfiesCatalogOutcomeRequirement(args.capability, {
        id: args.candidate.id,
        statement: args.candidate.structural_label || args.candidate.name,
        candidateIds: [args.candidate.id],
        subjectTokens: evidenceSubjects,
        minimumSubjectMatches: 1,
      }) || reconciledSubjectMatch)) return false;
  const observedActions = [...new Set(observedCapabilityLifecycleActions(args.candidate.operations || [])
    .map(publicationAction).filter(action => publicationActions.has(action)))];
  const supportedTitleActions = titleActionFamilies(args.capability.name);
  if (observedActions.length === 0 || !supportedTitleActions.some(action => observedActions.includes(action)) ||
      (args.postReconciliation && pendingCapabilityEvidenceObservableActionFailure(args.capability, args.candidate))) return false;
  const candidateOperations = new Set((args.candidate.operations || []).map(operation => operation.entry_point_id));
  const candidateEntities = new Set(args.candidate.related_entities || []);
  const structurallyAnchored = (args.capability.operations || []).some(operation => candidateOperations.has(operation.entry_point_id)) ||
    (args.capability.related_entities || []).some(entity => candidateEntities.has(entity));
  if (!structurallyAnchored) return false;
  if ([...args.registry.values()].some(entry => entry.familyKey === args.familyKey && entry.candidateId !== args.candidate!.id)) return false;
  const evidenceDigest = capabilityEvidenceIdentityDigest(args.candidate);
  const existing = args.registry.get(args.candidate.id);
  if (existing?.evidenceDigest === evidenceDigest) return true;
  args.registry.set(args.candidate.id, {
    audience: args.audience,
    candidateId: args.candidate.id,
    evidenceDigest,
    familyKey: args.familyKey,
    fallbackAttempted: false,
    identity: args.capability,
  });
  return true;
}

export function deterministicCapabilityDescriptionFallback(args: {
  identity: SystemCapability;
  evidenceCandidates: readonly SystemCapability[];
  evidenceEntityNames?: readonly string[];
  audience?: string;
  firstPartyTexts: readonly string[];
  repairGenericGroupedName?: boolean;
  validate: (capability: SystemCapability) => boolean;
}): SystemCapability | undefined {
  const audience = String(args.audience || '').trim();
  if (!audience) return undefined;
  const candidateIds = factors(args.identity, 'catalog-candidate:');
  if (candidateIds.length === 0) return undefined;
  const evidenceById = new Map(args.evidenceCandidates.map(candidate => [candidate.id, candidate]));
  const candidates = candidateIds.map(candidateId => evidenceById.get(candidateId));
  if (candidates.some(candidate => !candidate)) return undefined;
  const resolvedCandidates = candidates.filter((candidate): candidate is SystemCapability => Boolean(candidate));
  const titleTokens = descriptionTokens(args.identity.name);
  const supportedTitleActions = titleActionFamilies(args.identity.name);
  const firstPartyOutcomeBound = factors(args.identity, "catalog-outcome-requirement:").length > 0;
  const titleObjectTokens = titleTokens.slice(1);
  const titleObjectBoundary = titleObjectTokens.findIndex(token =>
    ['for', 'from', 'through', 'via', 'with'].includes(token));
  const rawTitleSubjects = (titleObjectBoundary >= 0
    ? titleObjectTokens.slice(0, titleObjectBoundary)
    : titleObjectTokens)
    .filter(token => !['and', 'for', 'from', 'the', 'through', 'with'].includes(token));
  const nonActionTitleSubjects = rawTitleSubjects
    .filter(token => titleActionFamilies(token).length === 0 && !CAPABILITY_PURPOSE_VERBS.has(token));
  const titleSubjects = nonActionTitleSubjects.length > 0 ? nonActionTitleSubjects : rawTitleSubjects;
  if ((!firstPartyOutcomeBound && supportedTitleActions.length === 0) || titleSubjects.length === 0) return undefined;
  const evidenceSubjects = [...new Set(resolvedCandidates.flatMap(candidate => capabilityEvidenceSubjectTokens(candidate, args.evidenceEntityNames)))];
  const subjectMatches = (left: string, right: string): boolean => {
    const canonical = (token: string) => token === 'auth' || token === 'authentication' ? 'authenticate' : token;
    const rightTokens = new Set(outcomeIdentityTokens(right).map(canonical));
    return outcomeIdentityTokens(left).map(canonical).some(token => rightTokens.has(token));
  };
  const groundedTitleSubjects = titleSubjects.filter(subject => evidenceSubjects.some(evidence => subjectMatches(subject, evidence)));
  if (groundedTitleSubjects.length === 0) {
    const titleEvidenceSubject = evidenceSubjects.find(evidence =>
      titleTokens.some(token => subjectMatches(token, evidence)));
    if (titleEvidenceSubject) groundedTitleSubjects.push(titleEvidenceSubject);
  }
  if (supportedTitleActions.includes('authenticate')) {
    const audienceTokens = descriptionTokens(audience);
    groundedTitleSubjects.push(...titleSubjects.filter(subject =>
      audienceTokens.some(audienceToken => subjectMatches(subject, audienceToken))));
  }
  if (groundedTitleSubjects.length === 0) return undefined;
  const actionOrder = ['create', 'view', 'update', 'remove'];
  let actions = [...new Set(resolvedCandidates.flatMap(candidate => publicationActionsForOperations(candidate.operations || [])))]
    .sort((left, right) => {
      const leftIndex = actionOrder.indexOf(left);
      const rightIndex = actionOrder.indexOf(right);
      return (leftIndex < 0 ? Number.MAX_SAFE_INTEGER : leftIndex) - (rightIndex < 0 ? Number.MAX_SAFE_INTEGER : rightIndex);
    });
  if (actions.length === 0) return undefined;
  const authenticationSubject = titleSubjects.some(subject => ['auth', 'authenticate', 'authentication', 'session', 'user'].includes(subject));
  if (actions.length > 1 && actions.includes('authenticate') && !authenticationSubject) {
    actions = actions.filter(action => action !== 'authenticate');
  }
  const audiencePattern = descriptionAudiencePattern(audience);
  const exactSentence = args.firstPartyTexts
    .flatMap(text => String(text || '').split(/(?<=[.!?])\s+|[\r\n]+/))
    .map(sentence => sentence.trim())
    .filter(Boolean)
    .find(sentence => {
      if (!audiencePattern.test(sentence)) return false;
      const sentenceTokens = descriptionTokens(sentence);
      const subjectGrounded = groundedTitleSubjects.every(subject => sentenceTokens.some(token => subjectMatches(subject, token)));
      const titleActionGrounded = supportedTitleActions.some(action => descriptionContainsAction(sentence, action));
      const lifecycleComplete = actions.every(action => descriptionContainsAction(sentence, action));
      const wordCount = descriptionWords(sentence).length;
      return subjectGrounded && titleActionGrounded && lifecycleComplete && wordCount >= 12 && wordCount <= 28;
    });
  const titleGroundsEveryCandidate = resolvedCandidates.every(candidate => {
    const candidateSubjects = capabilityEvidenceSubjectTokens(candidate, args.evidenceEntityNames);
    return candidateSubjects.some(evidence =>
      titleSubjects.some(subject => subjectMatches(subject, evidence)));
  });
  if (!exactSentence && !supportedTitleActions.some(action => actions.includes(action)) && !firstPartyOutcomeBound) return undefined;
  const authoredExactGroupedLifecycle = resolvedCandidates.length > 1 &&
    candidateIds.every(candidateId => candidateId.startsWith('operation-obligation:')) &&
    titleGroundsEveryCandidate &&
    !/^(?:manage|handle|process)(?:s|d|ing)?\b/i.test(args.identity.name.trim());
  const exactGroupedLifecycle = authoredExactGroupedLifecycle || (resolvedCandidates.length >= 1 &&
    actions.length > 1 &&
    /^manage\b/i.test(args.identity.name) &&
    (args.identity.criticality_factors || []).includes('catalog-deterministic-grouped-lifecycle'));
  if (!exactSentence && resolvedCandidates.length !== 1 && !exactGroupedLifecycle && !firstPartyOutcomeBound) return undefined;
  const description = exactSentence || (() => {
    const normalizedTitle = args.identity.name.trim().replace(/[.!?]+$/, '').replace(/^./, value => value.toLowerCase());
    const coreOutcomeTitle = normalizedTitle.replace(/ +(?:for|from|through|via|with)(?: +|$).*$/i, "").trim();
    const evidenceSubject = exactGroupedLifecycle
      ? args.identity.name.trim().replace(/^[^\s]+\s+(?:and\s+[^\s]+\s+)?/i, '').toLowerCase()
      : groundedTitleSubjects.join(' ');
    if (!normalizedTitle || !evidenceSubject || actions.length === 0) return '';
    const subjectBase = exactGroupedLifecycle ? evidenceSubject : titleSubjects.join(' ') || evidenceSubject;
    const subjectPhrase = /(?:^| )(?:data|information)$/.test(subjectBase) ? subjectBase : pluralSubject(subjectBase);
    if (exactGroupedLifecycle) {
      if (subjectPhrase === 'authentication') {
        const verbByAction: Record<string, string> = {
          authenticate: 'authenticate', create: 'register', remove: 'remove access',
          update: 'update access', view: 'view access',
        };
        const verbs = actions.map(action => verbByAction[action]).filter((value): value is string =>
          typeof value === 'string' && value.length > 0);
        if (verbs.length !== actions.length) return '';
        const actionPhrase = verbs.length === 1 ? verbs[0]
          : verbs.length === 2 ? `${verbs[0]} and ${verbs[1]}`
          : `${verbs.slice(0, -1).join(', ')}, and ${verbs[verbs.length - 1]}`;
        return `${audience} can ${actionPhrase} through the same authentication lifecycle as their access needs change over time.`;
      }
      const inverseRemovalVerb = /\bunfollow\b/i.test(args.identity.name) ? 'unfollow' : /\bunfavou?rite\b/i.test(args.identity.name) ? 'unfavorite' : 'remove';
      const verbs = actions.map(action => ({
        accept: 'accept', authenticate: 'authenticate', create: 'create', decline: 'decline', favorite: 'favorite', follow: 'follow',
        filter: 'filter', remove: inverseRemovalVerb, update: 'update', view: 'view',
      }[action])).filter((value): value is string => Boolean(value)).sort((left, right) => {
        const title = args.identity.name.toLowerCase();
        const leftIndex = title.indexOf(left);
        const rightIndex = title.indexOf(right);
        return (leftIndex < 0 ? Number.MAX_SAFE_INTEGER : leftIndex) - (rightIndex < 0 ? Number.MAX_SAFE_INTEGER : rightIndex);
      });
      if (verbs.length !== actions.length) return '';
      const actionPhrase = verbs.length === 2 ? `${verbs[0]} and ${verbs[1]}`
        : `${verbs.slice(0, -1).join(', ')}, and ${verbs[verbs.length - 1]}`;
      return `${audience} can ${actionPhrase} ${subjectPhrase} while keeping those ${subjectPhrase} current over time.`;
    }
    if ((args.identity.criticality_factors || []).includes('catalog-deterministic-single-operation-aggregate')) {
      const outcomeByAction: Record<string, string> = {
        create: `producing a recorded ${subjectPhrase} outcome in the product`,
        remove: `producing a recorded removal outcome for those ${subjectPhrase} in the product`,
        update: `changing the recorded state for those ${subjectPhrase} in the product`,
        view: `returning the recorded state for those ${subjectPhrase} through the product`,
      };
      const outcome = outcomeByAction[actions[0]];
      if (!outcome) return '';
      return `${audience} can ${normalizedTitle}, ${outcome}.`;
    }
    if ((args.identity.criticality_factors || []).includes('catalog-deterministic-route-lineage') &&
      /(?:authentication|impersonation|session)/.test(subjectPhrase)) {
      return `${audience} can maintain ${subjectPhrase} over time as the access they represent changes.`;
    }
    if ((args.identity.criticality_factors || []).includes('catalog-deterministic-route-lineage')) {
      return `${audience} can ${normalizedTitle} as part of their normal workflow whenever needed.`;
    }
    if (firstPartyOutcomeBound) {
      if (coreOutcomeTitle !== normalizedTitle) return audience + " can " + coreOutcomeTitle + " as part of their normal workflow whenever needed.";
      return `${audience} can ${normalizedTitle} as those ${subjectPhrase} change over time.`;
    }
    if (actions.length > 1) {
      const continuity = actions.includes('remove')
        ? 'from first use through later changes, including when they no longer need them'
        : 'as their needs change over time';
      return `${audience} can ${normalizedTitle} ${continuity}.`;
    }
    return `${audience} can ${normalizedTitle} as part of their normal workflow whenever needed.`;
  })();
  const wordCount = descriptionWords(description).length;
  if (wordCount < 12 || wordCount > 28) return undefined;
  const fallback: SystemCapability = {
    ...args.identity,
    name: args.identity.name,
    description,
    description_source: 'deterministic',
    description_generation: {
      status: 'deterministic_kept',
      attempted: true,
      reason: exactSentence ? 'grounded-first-party-outcome' : 'grounded-cited-lifecycle',
    },
  };
  return args.validate(fallback) ? fallback : undefined;
}

export function deterministicCapabilityActionIdentityFallback(args: {
  capability: SystemCapability;
  candidate: SystemCapability;
  audience?: string;
  relatedEntityLabels?: readonly string[];
  allowUniqueStructuralSubject?: boolean;
  allowGroupedLifecycle?: boolean;
  validate: (capability: SystemCapability) => boolean;
}): SystemCapability | undefined {
  const actions = publicationActionsForOperations(args.candidate.operations || []);
  if (actions.length === 0 || (actions.length > 1 && !args.allowGroupedLifecycle)) return undefined;
  const excludedSubjects = new Set([
    'and', 'application', 'button', 'callback', 'card', 'click', 'component', 'container', 'control', 'data',
    'dialog', 'event', 'field', 'for', 'form', 'handler', 'hook', 'item', 'list', 'management', 'modal', 'open', 'page', 'panel',
    'record', 'screen', 'state', 'system', 'the', 'view', 'window', 'with',
  ]);
  const groundedSubjects = (value: string): string[] => descriptionTokens(
    value.replace(/[-_.]+/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2'),
  )
    .map(token => token.length > 4 && token.endsWith('ies') ? `${token.slice(0, -3)}y`
      : token.length >= 4 && token.endsWith('s') && !token.endsWith('ss') && token !== 'news'
        ? token.slice(0, -1) : token)
    .filter(token => !publicationActions.has(publicationAction(token)) && !excludedSubjects.has(token));
  const uniqueSubject = (values: readonly string[]): string | undefined => {
    const subjects = [...new Set(values.map(value => groundedSubjects(value).join(' ')).filter(Boolean))];
    return subjects.length === 1 ? subjects[0] : undefined;
  };
  const groupedRouteSubject = actions.length > 1 ? (() => {
    const literalRouteSegments = (args.candidate.operations || []).map(operation =>
      String(operation.trigger?.path || operation.path_or_command || '').split('/')
        .filter(segment => segment && !/^[:{]/.test(segment) && !segment.includes('.'))
        .map(segment => segment.replace(/[-_.]+/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().trim()));
    const sharedActionSegment = literalRouteSegments[0]?.find(segment =>
      publicationActions.has(publicationAction(descriptionTokens(segment)[0] || '')) &&
      literalRouteSegments.slice(1).every(segments => segments.includes(segment)));
    const structuralSubject = groundedSubjects(args.candidate.structural_label || '').join(' ');
    const relatedDomainSubjects = new Set((args.candidate.related_domains || []).map(domain => groundedSubjects(domain).join(' ')));
    const routeSegmentSets = (args.candidate.operations || []).map(operation => {
      const route = String(operation.trigger?.path || operation.path_or_command || '');
      return route.split('/').filter(segment => segment && !/^[:{]/.test(segment) && !segment.includes('.'))
        .map(segment => ({
          key: groundedSubjects(segment).join(' '),
          display: segment.replace(/[-_.]+/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().trim(),
        }))
        .filter(segment => segment.key && segment.key !== 'api' && !/^v\d+$/.test(segment.key) && !/(?:^| )service(?: |$)/.test(segment.key));
    });
    if (routeSegmentSets.length === 0 || routeSegmentSets.some(segments => segments.length === 0)) {
      if (sharedActionSegment) {
        if (sharedActionSegment === 'auth') return 'authentication';
        const structuralAlternative = descriptionTokens(args.candidate.structural_label || args.candidate.name || '')
          .filter(token => !['management', 'manager', 'workflow', 'lifecycle'].includes(token))
          .filter(token => publicationAction(token) !== publicationAction(sharedActionSegment))
          .filter(token => !excludedSubjects.has(token))[0];
        if (structuralAlternative) return structuralAlternative;
        return sharedActionSegment;
      }
      return sharedActionSegment && structuralSubject &&
        relatedDomainSubjects.has(structuralSubject)
        ? structuralSubject : undefined;
    }
    const commonSegments = routeSegmentSets[0].filter(segment =>
      routeSegmentSets.slice(1).every(segments => segments.some(other => other.key === segment.key)));
    const tokenSets = routeSegmentSets.map(segments =>
      new Set(segments.flatMap(segment => segment.key.split(/\s+/).filter(Boolean))));
    const commonTokens = [...tokenSets[0]].filter(token =>
      tokenSets.slice(1).every(tokens => tokens.has(token)));
    const subject = [...commonSegments].reverse().find(segment => !publicationActions.has(publicationAction(descriptionTokens(segment.display)[0] || '')))?.display ||
      (commonTokens.length > 0 ? commonTokens.join(' ') : undefined);
    if (!subject || publicationActions.has(publicationAction(descriptionTokens(subject)[0] || ''))) return undefined;
    return subject === 'auth' ? 'authentication' : subject;
  })() : undefined;
  if (actions.length > 1 && !groupedRouteSubject) return undefined;
  const routeSubjectEvidence = (() => {
    if ((args.candidate.operations || []).length !== 1) return undefined;
    const operation = args.candidate.operations[0];
    const rawRoute = String(operation.trigger?.path || operation.path_or_command || '');
    const cliCommand = operation.entry_point_type === 'cli' ? rawRoute.replace(/\s*\([^)]*\)\s*$/, '').trim() : '';
    if (!rawRoute.includes('/') && !cliCommand) return undefined;
    const segments = cliCommand ? [cliCommand] : rawRoute.split('/').filter(Boolean);
    const literalSegments = segments.filter(segment => !/^[:{]/.test(segment));
    const subjectSegment = literalSegments[literalSegments.length - 1] || '';
    const subjectTokens = groundedSubjects(subjectSegment);
    const displayTokens = subjectSegment.replace(/[-_.]+/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .toLowerCase().trim().split(/\s+/).filter(Boolean);
    while (displayTokens.length > 1 && publicationActions.has(publicationAction(displayTokens[0]))) displayTokens.shift();
    if (displayTokens.length > 1 && displayTokens[0] === 'all') displayTokens.shift();
    if (displayTokens.length >= 4 && ['user', 'users'].includes(displayTokens[0])) displayTokens.shift();
    const subjectLabel = displayTokens.join(' ');
    const parameterTokens = groundedSubjects(segments.filter(segment => /^[:{]/.test(segment))
      .join(' ').replace(/[{}:]/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2'));
    const ancestorTokens = groundedSubjects(literalSegments.slice(0, -1).join(' '));
    return subjectTokens.length > 0
      ? { label: subjectLabel, tokens: [...new Set([...subjectTokens, ...ancestorTokens, ...parameterTokens])] }
      : undefined;
  })();
  const structuralLabel = args.candidate.structural_label ||
    (args.candidate.id.startsWith('operation-obligation:') ||
      (args.candidate.evidence_kind === 'behavior-surface' && (args.candidate.operations || []).length === 1)
      ? args.candidate.name : undefined);
  const structuralLabelTokens = groundedSubjects(structuralLabel || '');
  const genericStructuralLabel = /\b(?:management|workflow|lifecycle)\b/i.test(structuralLabel || '');
  const exactOperationRouteSubject = args.candidate.id.startsWith('operation-obligation:') &&
    ['http', 'cli'].includes(String(args.candidate.operations?.[0]?.entry_point_type || ''))
    ? routeSubjectEvidence?.label : undefined;
  const obligationLabel = groupedRouteSubject || exactOperationRouteSubject ||
    (genericStructuralLabel ? routeSubjectEvidence?.label : undefined) ||
    (structuralLabel?.includes('/') || structuralLabelTokens.length <= 1
      ? routeSubjectEvidence?.label || structuralLabel
      : structuralLabel || routeSubjectEvidence?.label);
  if (routeSubjectEvidence && (args.relatedEntityLabels || []).some(label => {
    if (/(?:Request|Response|Status)$/i.test(label)) return false;
    const tokens = groundedSubjects(label);
    return tokens.length > 0 && !tokens.some(token => routeSubjectEvidence.tokens.includes(token));
  })) return undefined;
  const labelTokens = obligationLabel ? groundedSubjects(obligationLabel) : [];
  const matchingEntityLabels = (args.relatedEntityLabels || []).filter(label => {
    const tokens = groundedSubjects(label);
    return labelTokens.length === 0 || tokens.some(token => labelTokens.includes(token));
  });
  const entitySubject = uniqueSubject(matchingEntityLabels);
  const terminalEvidenceSubjects = capabilityEvidenceSubjectTokens(args.candidate);
  const labelSubject = (() => {
    if (labelTokens.length === 0) return undefined;
    if (!routeSubjectEvidence && matchingEntityLabels.length === 0 && labelTokens.length > 1) return undefined;
    if (args.allowUniqueStructuralSubject) {
      const matchingTokenSets = matchingEntityLabels.map(label => new Set(
        groundedSubjects(label).filter(token => labelTokens.includes(token))));
      if (matchingTokenSets.length > 1 && ![...matchingTokenSets[0]].some(token =>
        matchingTokenSets.slice(1).every(tokens => tokens.has(token)))) return undefined;
      return labelTokens.join(' ');
    }
    if (labelTokens.length === 1) return entitySubject ? labelTokens[0] : undefined;
    if (!entitySubject) return undefined;
    const entityTokens = groundedSubjects(entitySubject);
    return entityTokens.every(token => labelTokens.includes(token)) ? labelTokens.join(' ') : undefined;
  })();
  const terminalSubject = uniqueSubject(terminalEvidenceSubjects);
  const exactRouteDisplaySubject = routeSubjectEvidence && args.allowUniqueStructuralSubject
    ? routeSubjectEvidence.label : undefined;
  const subject = actions.length > 1 ? groupedRouteSubject : actions[0] === 'authenticate' ? String(args.audience).toLowerCase() : obligationLabel
    ? labelTokens.length > 0 ? exactRouteDisplaySubject || labelSubject : entitySubject || terminalSubject
    : entitySubject || terminalSubject;
  if (!subject) return undefined;
  const verbByAction: Record<string, string> = {
    accept: 'Accept', authenticate: 'Authenticate', create: 'Create', decline: 'Decline', favorite: 'Favorite', filter: 'Filter', follow: 'Follow', remove: 'Remove', run: 'Run', test: 'Test', update: 'Update', view: 'View',
  };
  const evidenceVerb = descriptionTokens(obligationLabel || '')[0];
  const exactEvidenceVerb = evidenceVerb && /^(?:browse|fetch|filter|import|list|load|retrieve|search)$/.test(evidenceVerb) && publicationAction(evidenceVerb) === actions[0]
    ? `${evidenceVerb[0].toUpperCase()}${evidenceVerb.slice(1)}`
    : undefined;
  const settingsMutation = actions[0] === 'update' &&
    (routeSubjectEvidence?.tokens || []).some(token => /^(?:setting|configuration|preference)$/.test(token));
  const verb = actions.length > 1 ? 'Manage' : settingsMutation ? 'Configure' : exactEvidenceVerb || verbByAction[actions[0]];
  if (!verb) return undefined;
  const identity: SystemCapability = {
    ...args.capability,
    name_source: 'deterministic',
    name: `${verb} ${subject === 'authentication' ? subject : pluralSubject(subject)}`,
    description: '',
    operations: [...(args.candidate.operations || [])],
    related_entities: [...(args.candidate.related_entities || [])],
    related_domains: [...new Set([...(args.candidate.related_domains || []),
      ...(routeSubjectEvidence?.tokens || []),
      ...(args.allowUniqueStructuralSubject ? [subject, ...groundedSubjects(subject)] : [])])],
    criticality_factors: [
      ...(args.capability.criticality_factors || []).filter(factor => !factor.startsWith('catalog-candidate:')),
      `catalog-candidate:${args.candidate.id}`,
      ...(args.allowGroupedLifecycle ? ['catalog-deterministic-grouped-lifecycle'] : []),
    ],
  };
  return deterministicCapabilityDescriptionFallback({
    identity, evidenceCandidates: [args.candidate], audience: args.audience,
    evidenceEntityNames: args.relatedEntityLabels,

    firstPartyTexts: [], validate: args.validate,
  });
}
export function capabilityCatalogRepairPlan(args: {
  evidenceCandidateIds: readonly string[];
  outcomeRequirements: readonly CapabilityCatalogOutcomeRequirement[];
  pendingCapabilities: readonly SystemCapability[];
  priorityEvidenceCandidateIds?: readonly string[];
  evidenceCandidates?: readonly SystemCapability[];
}): CapabilityCatalogRepairBatch[] {
  const evidenceById = new Map((args.evidenceCandidates || []).map(candidate => [candidate.id, candidate]));
  const groupedEvidenceBatches = (candidateIds: readonly string[]): CapabilityCatalogRepairBatch[] => {
    const groups = new Map<string, string[]>();
    for (const candidateId of candidateIds) {
      const candidate = evidenceById.get(candidateId);
      const operationObligation = candidate?.id.startsWith('operation-obligation:') ? candidate : undefined;
      const actions = operationObligation
        ? [...new Set(observedCapabilityLifecycleActions(operationObligation.operations || []).map(publicationAction).filter(action => publicationActions.has(action)))].sort()
        : [];
      const parentFactors = operationObligation ? factors(operationObligation, 'catalog-parent-candidate:') : [];
      const encodedParent = operationObligation ? /^operation-obligation:(.+):[^:]+$/.exec(operationObligation.id)?.[1] : undefined;
      const parent = parentFactors.length === 1 ? parentFactors[0] : encodedParent;
      const entitySubjects = [...new Set(operationObligation?.related_entities || [])].sort();
      const evidenceSubjects = operationObligation && entitySubjects.length === 0
        ? capabilityEvidenceSubjectTokens(operationObligation).filter(token => !publicationActions.has(publicationAction(token)))
        : [];
      const subject = entitySubjects.length > 0 ? 'entities:' + entitySubjects.join('|')
        : evidenceSubjects.length === 1 ? 'subject:' + evidenceSubjects[0] : undefined;
      const key = parent && actions.length === 1 && subject
        ? 'family:' + parent + ':' + subject
        : 'candidate:' + candidateId;
      const group = groups.get(key) || [];
      group.push(candidateId);
      groups.set(key, group);
    }
    return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right))
      .map(([, candidateIds]) => ({
      mode: 'evidence' as const,
      candidateIds: [...candidateIds].sort(),
      requirements: [] as [],
    }));
  };
  const pendingIdentityByLifecycleKey = new Map<string, SystemCapability>();
  for (const identity of args.pendingCapabilities) {
    const lifecycleKey = capabilityCatalogRepairLifecycleKey(identity);
    if (!pendingIdentityByLifecycleKey.has(lifecycleKey)) pendingIdentityByLifecycleKey.set(lifecycleKey, identity);
  }
  const descriptionBatches = [...pendingIdentityByLifecycleKey.values()].map(identity => {
    const requirementIds = new Set(factors(identity, 'catalog-outcome-requirement:'));
    return {
      mode: 'description' as const,
      candidateIds: factors(identity, 'catalog-candidate:'),
      requirements: args.outcomeRequirements.filter(requirement => requirementIds.has(requirement.id)),
      identity,
      ...((identity.name_source === 'deterministic' || (identity.criticality_factors || []).includes('catalog-name-repair-required')) ? { repairName: true } : {}),
    };
  });
  const pendingRequirements = new Set(descriptionBatches.flatMap(batch => batch.requirements.map(requirement => requirement.id)));
  const outcomeBatches = args.outcomeRequirements
    .filter(requirement => !pendingRequirements.has(requirement.id))
    .map(requirement => ({
      mode: 'outcome' as const,
      candidateIds: [...new Set(requirement.candidateIds)],
      requirements: [requirement],
    }));
  const reservedCandidates = new Set(descriptionBatches
    .flatMap(batch => batch.candidateIds)
    .filter(candidateId => !candidateId.startsWith('operation-obligation:')));
  const evidenceIds = [...new Set(args.evidenceCandidateIds)].filter(candidateId => !reservedCandidates.has(candidateId));
  const priorityIds = new Set(args.priorityEvidenceCandidateIds || []);
  const priorityEvidenceBatches = groupedEvidenceBatches(evidenceIds.filter(candidateId => priorityIds.has(candidateId)));
  const evidenceBatches = groupedEvidenceBatches(evidenceIds.filter(candidateId => !priorityIds.has(candidateId)));
  return [...descriptionBatches, ...priorityEvidenceBatches, ...outcomeBatches, ...evidenceBatches];
}

export function preserveCapabilityCatalogDescriptionIdentity(
  identity: SystemCapability,
  repair: SystemCapability,
): SystemCapability {
  return {
    ...identity,
    description: repair.description,
    description_source: repair.description_source,
    description_generation: repair.description_generation,
  };
}

export function capabilityCatalogPendingRequirementIds(
  capability: Pick<SystemCapability, 'name' | 'description'> & Partial<Pick<SystemCapability, 'criticality_factors'>>,
  requirements: readonly CapabilityCatalogOutcomeRequirement[],
): string[] {
  if (factors(capability, 'catalog-outcome-requirement:').length > 0) return [];
  return requirements
    .filter(requirement => capabilityPotentiallySatisfiesCatalogOutcomeRequirement(capability, requirement))
    .map(requirement => requirement.id);
}

export function captureCapabilityCatalogPendingRequirements(
  pendingRequirementIdsByLifecycleKey: Map<string, string[]>,
  capabilities: readonly SystemCapability[],
  requirements: readonly CapabilityCatalogOutcomeRequirement[],
): void {
  for (const capability of capabilities) {
    const lifecycleKey = capabilityCatalogRepairLifecycleKey(capability);
    if (!pendingRequirementIdsByLifecycleKey.has(lifecycleKey)) {
      pendingRequirementIdsByLifecycleKey.set(lifecycleKey, capabilityCatalogPendingRequirementIds(capability, requirements));
    }
  }
}

const outcomeNameTokens = (name: string): string[] => {
  const ignored = new Set(['a', 'an', 'across', 'and', 'for', 'from', 'in', 'of', 'on', 'the', 'through', 'to', 'with']);
  return [...new Set(String(name || '').toLowerCase().split(/[^a-z0-9]+/)
    .filter(token => token.length >= 3 && !ignored.has(token))
    .map(canonicalCapabilityCatalogOutcomeToken))];
};

function outcomeActionFamilies(capability: SystemCapability): Set<string> {
  const familyByAction: Record<string, string> = {
    add: 'create', create: 'create', publish: 'create', register: 'create', submit: 'create',
    browse: 'read', fetch: 'read', filter: 'read', find: 'read', get: 'read', list: 'read', read: 'read', review: 'read', search: 'read', show: 'read', view: 'read',
    categorize: 'update', change: 'update', edit: 'update', maintain: 'update', manage: 'update', organize: 'update', update: 'update',
    archive: 'delete', cancel: 'delete', close: 'delete', delete: 'delete', remove: 'delete', unfavorite: 'delete', unfollow: 'delete', withdraw: 'delete',
    analyze: 'analyze', build: 'build', collaborate: 'collaborate', comprehend: 'understand', coordinate: 'collaborate', correlate: 'correlate', explain: 'understand', inspect: 'understand', understand: 'understand',
  };
  return new Set(outcomeNameTokens(capability.name).map(token => familyByAction[token]).filter((value): value is string => Boolean(value)));
}

function capabilityNamesShareCanonicalAction(left: SystemCapability, right: SystemCapability): boolean {
  const leftActions = outcomeActionFamilies(left);
  const rightActions = outcomeActionFamilies(right);
  return leftActions.size > 0 && [...rightActions].some(action => leftActions.has(action));
}

function unboundNameIsCoveredByRequirementReplacement(
  pending: SystemCapability,
  replacement: SystemCapability,
  requirement: CapabilityCatalogOutcomeRequirement,
): boolean {
  if (requirement.audience) return false;
  const pendingTokens = outcomeNameTokens(pending.name);
  const replacementTokens = outcomeNameTokens(replacement.name);
  if (!pendingTokens[0] || pendingTokens[0] !== replacementTokens[0]) return false;
  const replacementTokenSet = new Set(replacementTokens);
  const overlap = pendingTokens.filter(token => replacementTokenSet.has(token)).length;
  const subjectTerms = (requirement.requiredSubjectTerms || requirement.subjectTokens).map(canonicalCapabilityCatalogOutcomeToken);
  return overlap >= 3 && overlap === pendingTokens.length &&
    subjectTerms.some(term => pendingTokens.includes(term));
}

function unboundOutcomeSynonymIsCoveredByRequirementReplacement(
  pending: SystemCapability,
  replacement: SystemCapability,
  requirement: CapabilityCatalogOutcomeRequirement,
): boolean {
  if (requirement.audience || !capabilityNamesShareCanonicalAction(pending, replacement)) return false;
  const pendingCandidateIds = factors(pending, 'catalog-candidate:');
  if (pendingCandidateIds.length === 0 || pendingCandidateIds.some(candidateId => !requirement.candidateIds.includes(candidateId))) return false;
  const pendingSubjects = outcomeNameTokens(pending.name).slice(1);
  const replacementSubjects = outcomeNameTokens(replacement.name).slice(1);
  const requirementSubjects = (requirement.requiredSubjectTerms || requirement.subjectTokens)
    .map(canonicalCapabilityCatalogOutcomeToken);
  const requiredMatches = requirement.minimumSubjectMatches ?? Math.min(2, requirementSubjects.length);
  const requirementMatches = requirementSubjects.filter(term => pendingSubjects.includes(term)).length;
  const sharedSubjects = pendingSubjects.filter(term => replacementSubjects.includes(term)).length;
  return requirementMatches >= requiredMatches && sharedSubjects >= 1;
}

function pendingTitleCoversRequirement(
  pending: SystemCapability,
  requirement: CapabilityCatalogOutcomeRequirement,
): boolean {
  const pendingTokens = new Set(outcomeNameTokens(pending.name));
  const subjectTerms = (requirement.requiredSubjectTerms || requirement.subjectTokens).map(canonicalCapabilityCatalogOutcomeToken);
  const minimumMatches = requirement.minimumSubjectMatches ?? Math.min(2, subjectTerms.length);
  return subjectTerms.filter(term => pendingTokens.has(term)).length >= minimumMatches;
}

function transferRequirementEvidence(
  target: SystemCapability,
  evidence: SystemCapability,
  requirement: CapabilityCatalogOutcomeRequirement,
): SystemCapability {
  const operationKey = (operation: SystemCapability['operations'][number]) => [
    operation.entry_point_id,
    operation.entry_point_type,
    operation.action,
    operation.path_or_command || '',
    operation.trigger?.method || '',
    operation.trigger?.path || '',
  ].join('|');
  const operations = new Map((target.operations || []).map(operation => [operationKey(operation), operation]));
  for (const operation of evidence.operations || []) operations.set(operationKey(operation), operation);
  const requirementCandidates = new Set(requirement.candidateIds);
  const evidenceCitations = (evidence.criticality_factors || []).filter(factor =>
    factor.startsWith('catalog-candidate:') && requirementCandidates.has(factor.slice('catalog-candidate:'.length)));
  return {
    ...target,
    operations: [...operations.values()],
    related_entities: [...new Set([...(target.related_entities || []), ...(evidence.related_entities || [])])],
    criticality_factors: [...new Set([...(target.criticality_factors || []), ...evidenceCitations])],
  };
}

export function supersedeUnboundPendingOutcomeDuplicates(
  existing: readonly SystemCapability[], incoming: readonly SystemCapability[], requirements: readonly CapabilityCatalogOutcomeRequirement[],
  pendingRequirementIdsByLifecycleKey: ReadonlyMap<string, readonly string[]>,
  protectedExactCandidateIds: ReadonlySet<string> = new Set(),
): { existing: SystemCapability[]; incoming: SystemCapability[] } {
  const requirementById = new Map(requirements.map(requirement => [requirement.id, requirement]));
  const validReplacements = new Map<string, SystemCapability[]>();
  for (const capability of [...existing, ...incoming]) {
    if (!capability.description || capability.description_generation?.status === 'ai_rejected' ||
        capability.criticality_factors?.some(factor => factor.startsWith('catalog-evidence-rejected:'))) continue;
    const candidateIds = factors(capability, 'catalog-candidate:');
    for (const requirementId of factors(capability, 'catalog-outcome-requirement:')) {
      const requirement = requirementById.get(requirementId);
      if (!requirement || !candidateIds.some(candidateId => requirement.candidateIds.includes(candidateId)) ||
          !capabilitySemanticallySatisfiesCatalogOutcomeRequirement(capability, requirement)) continue;
      validReplacements.set(requirementId, [...(validReplacements.get(requirementId) || []), capability]);
    }
  }
  const repairedRequirements = new Set(validReplacements.keys());
  if (repairedRequirements.size === 0) return { existing: [...existing], incoming: [...incoming] };
  const matchingRequirementIds = (capability: SystemCapability): string[] => {
    const captured = pendingRequirementIdsByLifecycleKey.get(capabilityCatalogRepairLifecycleKey(capability)) ||
      pendingRequirementIdsByLifecycleKey.get(capability.id) || [];
    if (captured.length > 0) return [...captured];
    return requirements
      .filter(requirement => (validReplacements.get(requirement.id) || []).some(replacement =>
        unboundNameIsCoveredByRequirementReplacement(capability, replacement, requirement) ||
        unboundOutcomeSynonymIsCoveredByRequirementReplacement(capability, replacement, requirement)))
      .map(requirement => requirement.id);
  };
  const evidenceTransfers = new Map<string, Array<{ evidence: SystemCapability; requirement: CapabilityCatalogOutcomeRequirement }>>();
  for (const capability of [...existing, ...incoming]) {
    if (factors(capability, 'catalog-outcome-requirement:').length > 0) continue;
    const capturedRequirementIds = matchingRequirementIds(capability);
    if (capturedRequirementIds.length !== 1) continue;
    const requirement = requirementById.get(capturedRequirementIds[0]);
    if (!requirement || !capabilitySemanticallySatisfiesCatalogOutcomeRequirement(capability, requirement)) continue;
    const candidateIds = factors(capability, 'catalog-candidate:');
    if (candidateIds.length === 0 || candidateIds.some(candidateId => !requirement.candidateIds.includes(candidateId))) continue;
    const replacements = [...new Map((validReplacements.get(requirement.id) || [])
      .map(replacement => [replacement.id, replacement])).values()];
    if (replacements.length !== 1 || replacements[0].id === capability.id ||
        !capabilityNamesShareCanonicalAction(capability, replacements[0])) continue;
    evidenceTransfers.set(replacements[0].id, [
      ...(evidenceTransfers.get(replacements[0].id) || []),
      { evidence: capability, requirement },
    ]);
  }
  const applyEvidenceTransfers = (capability: SystemCapability): SystemCapability =>
    (evidenceTransfers.get(capability.id) || []).reduce(
      (merged, transfer) => transferRequirementEvidence(merged, transfer.evidence, transfer.requirement),
      capability,
    );
  const isSupersededPendingIdentity = (capability: SystemCapability): boolean => {
    if (factors(capability, 'catalog-outcome-requirement:').length > 0) return false;
    const capturedCandidateIds = factors(capability, 'catalog-candidate:');
    const capturedRequirementIds = matchingRequirementIds(capability);
    if (capturedRequirementIds.length === 0 &&
        capturedCandidateIds.some(candidateId => protectedExactCandidateIds.has(candidateId))) return false;
    if (capturedRequirementIds.length > 0) {
      return capturedRequirementIds.every(requirementId => {
        const requirement = requirementById.get(requirementId);
        return Boolean(requirement && !capturedCandidateIds.some(candidateId => protectedExactCandidateIds.has(candidateId) && !requirement.candidateIds.includes(candidateId)) && repairedRequirements.has(requirementId) && pendingTitleCoversRequirement(capability, requirement) &&
          (validReplacements.get(requirementId) || []).some(replacement => capabilityNamesShareCanonicalAction(capability, replacement)));
      });
    }
    const matchedRequirementIds = matchingRequirementIds(capability);
    return matchedRequirementIds.length > 0 && matchedRequirementIds.every(requirementId => repairedRequirements.has(requirementId));
  };
  return {
    existing: existing.filter(capability => !isSupersededPendingIdentity(capability)).map(applyEvidenceTransfers),
    incoming: incoming.filter(capability => !isSupersededPendingIdentity(capability)).map(applyEvidenceTransfers),

  };
}
export function capabilityCatalogFocusedTask(mode: CapabilityCatalogRepairBatch['mode'] | undefined, identityName?: string, acceptsExistingOutcome = false): string {
  if (mode === 'description' && identityName) return `Rewrite only the description for the existing capability identity retained by the server: ${JSON.stringify(identityName)}. Return exactly one object with the supplied candidate_ids. Preserve any supplied requirement_id exactly. Set name to the stable_capability_name, and explain that exact audience outcome without listing create, read, update, delete, routes, handlers, or source symbols. The attached operations retain complete lifecycle proof. Correct every reason and missing term named in prior_rejections.`;
  if (mode === 'description') return 'Rewrite the deterministic fallback name and description into one audience-readable product outcome grounded only in the supplied evidence. Return exactly one object with all supplied candidate_ids. The server preserves the stable ID, operations, entities, and complete evidence provenance. Do not enumerate create, read, update, delete, routes, handlers, or source symbols in the prose.';
  if (mode === 'outcome') return `Return exactly one object for the single required_outcomes entry and copy its requirement_id exactly. Independently express that entry's audience and outcome subjects. Use the supplied audience label itself when present; do not expand it into an inferred profession or role.`;
  return acceptsExistingOutcome
    ? 'Name only the common user or operator purpose of this evidence family. Reuse an accepted name only when its wording and evidence express that same outcome.'
    : 'Name only the common user or operator purpose of this evidence family. Do not emit requirement_id and do not reuse or restate an accepted global outcome.';
}

export function capabilityCatalogRepairNudge(
  batch: CapabilityCatalogRepairBatch,
  facts: unknown,
  qualityFailure?: string,
  publishabilityFeedback?: string,
): string {
  const obligation = batch.mode === 'description'
    ? batch.repairName
      ? `${publishabilityFeedback || ''} Replace the deterministic fallback name and description with one durable user outcome. Begin the name with a specific imperative product verb and the exact evidence subject. Never begin with Manage, Handle, or Process, never use noun forms such as Category Deletion, Import Management, or Account Creation, and do not enumerate CRUD verbs in the name. Prefer an evidence-compatible purpose verb such as Maintain, Organize, Configure, Track, Reconcile, or Authenticate; use one observable action only when no more durable outcome is grounded. The description MUST be new, contain 12-28 words and at least 55 characters, and explain the durable outcome and its evidence-grounded scope without mechanically listing required_visible_actions. Treat required_visible_actions as attached evidence constraints, not prose quotas. Mention a destructive effect in ordinary audience language only when the supplied evidence grounds it.`
      : `${publishabilityFeedback || ''} Repair only the rejected description for the stable accepted identity. Write a new description containing 12-28 words and at least 55 characters; returning the current rejected wording is invalid. Explain the complete evidence-grounded scope in durable user-outcome language, not by mechanically enumerating transport or CRUD operation labels. Treat observable_actions as attached evidence constraints, not prose quotas. Mention a destructive effect in ordinary audience language only when the supplied evidence grounds it. Do not copy a route phrase or combine its path nouns as a delivery description.`
    : batch.mode === 'outcome'
      ? capabilityCatalogOutcomeRepairNudge(batch.requirements, batch.candidateIds)
      : batch.candidateIds.length > 1
        ? 'Cover this one product-subject lifecycle as one durable outcome and cite every supplied candidate_id. The name MUST be a 2-7 word verb phrase beginning with a concrete evidence-grounded product verb such as Organize, Track, Configure, Reconcile, Maintain, Plan, Match, Import, or Export, followed by the main evidence subject. A bare noun or a label ending in Management, Configuration, Tracking, or Maintenance is invalid. Good forms include Track budgets, Organize transaction categories, and Maintain family merchants; invalid forms include Budget Management, Category Management, and Family. Do not enumerate Create, Read, Update, or Delete in the name or description. Write an 8-24 word description of the durable audience outcome; the attached operations preserve the complete action evidence.'
        : 'Cover only this rejected proposal evidence family; it has no product-outcome requirement and cannot reuse another accepted outcome. Repair the proposed name into the durable, scope-relative user purpose supported by evidence_subject, entity_fields, operations, and first-party product context. Never mirror a CRUD action merely because it is observable, never begin with Manage, Handle, or Process, and never enumerate lifecycle verbs. Prefer a specific outcome verb such as Track, Organize, Plan, Maintain, Import, Export, Connect, Recover, Compare, or Configure when the supplied evidence supports it. For a full lifecycle over user-defined categories, tags, groups, folders, or profiles, the title MUST begin with Customize, Organize, or Maintain and use the exact evidence subject; valid forms are Customize categories or Organize categories, never Organize budgets with categories unless budget is itself an evidence subject. Describe users performing the observed actions with the supplied fields. Never describe internal objects or entities, and do not add a purpose, benefit, or downstream effect unless first_party_outcomes states it. If the evidence proves only a mechanism and no audience outcome, return an empty list.';
  return `Previous catalog failed a quality check (${qualityFailure}). ${obligation} Every prior_rejections.rejected_name is an invalid title and MUST NOT be returned again or treated as a stable identity. Every value listed in prior_rejections.forbidden_subject_terms is prohibited from both name and description; express only the supported product behavior without repeating or explaining those terms. For unsupported-absence-claim, remove the forbidden absence or benefit clause completely instead of paraphrasing it, and state only the positive behavior grounded by the supplied evidence. For description-contradicts-observed-operations, remove every action outside observable_actions and do not borrow behavior from another outcome. For each prior rejection with missing_audience and missing_audience_locations, state that exact audience label in every required location; do not substitute second-person, singular, or implicit voice. For description-target-not-grounded, rewrite with the exact evidence_subject terms from the supplied facts and omit unsupported target or result nouns. Return only the evidence-grounded result requested in this ${batch.mode} batch. Missing evidence facts: ${JSON.stringify(facts)}. Each result must cite one or more of these candidate_ids and name the shared USER PURPOSE delivered by that evidence subject. A behavior-surface family label and its individual operation names are delivery evidence, never title templates. Never use MCP, tool, or surface as a capability title or description noun. A transport or tool invocation may lead a name only when the evidence establishes that action itself as the audience outcome. Do not enumerate individual response objects, commands, or configuration fields.`;
}
