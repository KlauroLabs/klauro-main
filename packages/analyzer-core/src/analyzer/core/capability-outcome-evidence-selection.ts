export interface OutcomeEvidenceCandidate {
  aggregateRank: number;
  evidenceRank: number;
  id: string;
  identityTokens: ReadonlySet<string>;
  symbolTokens: ReadonlySet<string>;
  tokens: ReadonlySet<string>;
}

interface OutcomeEvidenceGroup extends OutcomeEvidenceCandidate {
}

const operationObligationId = /^operation-obligation:(.+):[a-f0-9]{16}$/;

export function canonicalOutcomeEvidenceCandidateId(id: string): string {
  return id.match(operationObligationId)?.[1] || id;
}

function actionClass(token: string): string {
  if (/^(?:add|create|record|register)$/.test(token)) return 'create';
  if (/^(?:change|edit|modify|set|update)$/.test(token)) return 'update';
  if (/^(?:delete|remove)$/.test(token)) return 'delete';
  if (/^(?:find|filter|search)$/.test(token)) return 'filter';
  if (/^(?:browse|display|fetch|get|list|load|read|retrieve|show|view)$/.test(token)) return 'view';
  return token;
}

function mergeTokens(target: Set<string>, source: ReadonlySet<string>): void {
  for (const token of source) target.add(token);
}

function groupCandidates(candidates: readonly OutcomeEvidenceCandidate[]): OutcomeEvidenceGroup[] {
  const groups = new Map<string, OutcomeEvidenceGroup>();
  for (const candidate of candidates) {
    const id = canonicalOutcomeEvidenceCandidateId(candidate.id);
    const existing = groups.get(id);
    if (!existing) {
      groups.set(id, {
        ...candidate,
        id,
        identityTokens: new Set(candidate.identityTokens),
        symbolTokens: new Set(candidate.symbolTokens),
        tokens: new Set(candidate.tokens),
      });
      continue;
    }
    mergeTokens(existing.tokens as Set<string>, candidate.tokens);
    mergeTokens(existing.identityTokens as Set<string>, candidate.identityTokens);
    mergeTokens(existing.symbolTokens as Set<string>, candidate.symbolTokens);
    existing.evidenceRank = Math.min(existing.evidenceRank, candidate.evidenceRank);
    existing.aggregateRank = Math.min(existing.aggregateRank, candidate.aggregateRank);
  }
  return [...groups.values()];
}

export function selectMultiActionOutcomeCandidateIds(
  clause: string,
  candidates: readonly OutcomeEvidenceCandidate[],
  tokenize: (value: string) => string[],
  isPurposeVerb: (token: string) => boolean,
): string[] {
  const groups = groupCandidates(candidates);
  const actionableSentences = clause
    .split(/(?<=[.!?;])\s+/)
    .filter(sentence => tokenize(sentence).some(isPurposeVerb));
  const selected: string[] = [];

  for (const sentence of actionableSentences) {
    const sentenceTokens = tokenize(sentence);
    const actionClasses = new Set(sentenceTokens.filter(isPurposeVerb).map(actionClass));
    const directSubjects: string[] = [];
    let actionSeen = false;
    for (const word of sentence.toLowerCase().match(/[a-z0-9]+/g) || []) {
      const normalized = tokenize(word)[0];
      if (normalized && isPurposeVerb(normalized)) {
        actionSeen = true;
        continue;
      }
      if (actionSeen && /^(?:across|by|for|from|into|through|to|using|via|with)$/.test(word)) break;
      if (actionSeen && normalized) directSubjects.push(normalized);
    }
    const subjects = directSubjects.length > 0 ? [...new Set(directSubjects)] : sentenceTokens.filter(token => !isPurposeVerb(token));
    const subjectFrequency = new Map(subjects.map(token => [
      token,
      groups.filter(group => group.tokens.has(token)).length,
    ]));
    const ranked = groups.map(group => {
      const groupActions = new Set([...group.tokens].filter(isPurposeVerb).map(actionClass));
      const actionMatches = [...actionClasses].filter(action => groupActions.has(action)).length;
      const subjectMatches = subjects.filter(token => group.tokens.has(token));
      const distinctiveMatches = subjectMatches.filter(token => subjectFrequency.get(token) === 1).length;
      const identityMatches = subjects.filter(token => group.identityTokens.has(token)).length;
      const symbolMatches = subjects.filter(token => group.symbolTokens.has(token)).length;
      return { group, actionMatches, subjectMatches: subjectMatches.length, distinctiveMatches, identityMatches, symbolMatches };
    }).filter(item => item.subjectMatches > 0)
      .sort((left, right) =>
        right.actionMatches - left.actionMatches ||
        right.distinctiveMatches - left.distinctiveMatches ||
        left.group.evidenceRank - right.group.evidenceRank ||
        left.group.aggregateRank - right.group.aggregateRank ||
        right.identityMatches - left.identityMatches ||
        right.symbolMatches - left.symbolMatches ||
        right.subjectMatches - left.subjectMatches ||
        left.group.id.localeCompare(right.group.id));
    const best = ranked[0];
    if (best && !selected.includes(best.group.id)) selected.push(best.group.id);
  }

  return selected.slice(0, 3);
}
