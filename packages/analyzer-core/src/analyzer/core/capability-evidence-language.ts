import type { SystemCapability } from '../../types/cas.types';
import { CAPABILITY_PURPOSE_VERBS } from './capability-naming';

export interface CapabilityProductTextSignal {
  concepts?: string[];
  productDocTitle?: string;
  productDocSummary?: string;
  manifestDescription?: string;
  summary?: string;
}

export function normalizedSubjectTokens(value: string): Set<string> {
  const scaffolding = new Set(['management', 'capability', 'workflow', 'handling', 'operation', 'operations', 'mcp', 'tool', 'tools', 'surface']);
  return new Set(String(value || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(token => token.length >= 3 && !scaffolding.has(token))
    .map(token => token.length > 4 && token.endsWith('ies') ? `${token.slice(0, -3)}y` : token.length > 4 && token.endsWith('s') && !token.endsWith('ss') ? token.slice(0, -1) : token));
}

export function outcomeIdentityTokens(value: string): string[] {
  const ignored = new Set([
    'a', 'an', 'and', 'as', 'at', 'by', 'for', 'from', 'in', 'into', 'of', 'on', 'or', 'the', 'through', 'to', 'using', 'via', 'with',
    'ability', 'across', 'area', 'behavior', 'capability', 'entry', 'item', 'management', 'operation', 'operations', 'other', 'surface', 'tool', 'tools', 'workflow',
    'her', 'hers', 'him', 'his', 'its', 'our', 'ours', 'their', 'theirs', 'them', 'they', 'your', 'yours',
  ]);
  return String(value || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\b(?:log|sign)[ -]+in\b/gi, ' authenticate ')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(token => token.length >= 3)
    .map(token => token.length > 4 && token.endsWith('ies') ? `${token.slice(0, -3)}y` : token.length >= 4 && token.endsWith('s') && !token.endsWith('ss') ? token.slice(0, -1) : token)
    .map(token => /^stat(?:istic|istical)?$/.test(token) ? 'stat' : token)
    .map(token => /^(?:auth|authenticate|authentication|login|signin|signon)$/.test(token) ? 'authenticate' : token)
    .filter(token => !ignored.has(token));
}

export function outcomeTokenMatches(token: string, evidence: Set<string>): boolean {
  const equivalents: Record<string, string[]> = {
    adjust: ['change', 'edit', 'update'],
    change: ['adjust', 'edit', 'update'],
    edit: ['adjust', 'change', 'update'],
    update: ['adjust', 'change', 'edit'],
    code: ['codebase', 'software', 'source'],
    codebase: ['code', 'software', 'source'],
    collaborate: ['collaboration', 'coordinate'],
    collaboration: ['collaborate', 'coordinate'],
    coordinate: ['collaborate', 'collaboration'],
    collision: ['conflict', 'overlap'],
    conflict: ['collision', 'overlap'],
    evolution: ['change', 'history'],
    history: ['change', 'evolution'],
    overlap: ['collision', 'conflict'],
    overlapping: ['collision', 'conflict'],
    account: ['profile', 'user', 'username'],
    profile: ['account', 'user', 'username'],
    user: ['account', 'profile', 'username'],
    username: ['account', 'profile', 'user'],
  };
  if ((equivalents[token] || []).some(candidate => evidence.has(candidate))) return true;
  return evidence.has(token) || [...evidence].some(candidate =>
    Math.min(token.length, candidate.length) >= 5 &&
    (token.startsWith(candidate) || candidate.startsWith(token) || token.slice(0, 5) === candidate.slice(0, 5))
  );
}

function canonicalPurposeVerb(token: string): string | undefined {
  const lower = token.toLowerCase();
  const candidates = [
    lower,
    lower.endsWith('ies') ? `${lower.slice(0, -3)}y` : '',
    lower.endsWith('ing') ? lower.slice(0, -3) : '',
    lower.endsWith('ing') ? `${lower.slice(0, -3)}e` : '',
    lower.endsWith('ed') ? lower.slice(0, -2) : '',
    lower.endsWith('ed') ? `${lower.slice(0, -2)}e` : '',
    lower.endsWith('es') ? lower.slice(0, -1) : '',
    lower.endsWith('es') ? lower.slice(0, -2) : '',
    lower.endsWith('s') ? lower.slice(0, -1) : '',
  ].filter(Boolean);
  return candidates.find(candidate => CAPABILITY_PURPOSE_VERBS.has(candidate));
}

function inflectedActionBases(token: string): string[] {
  const lower = token.toLowerCase();
  if (lower.endsWith('ing') && lower.length > 5) {
    return [...new Set([lower.slice(0, -3), `${lower.slice(0, -3)}e`])];
  }
  if (lower.endsWith('ed') && lower.length > 4) {
    return [...new Set([lower.slice(0, -2), `${lower.slice(0, -2)}e`])];
  }
  return [];
}

export function productTextCorroboratesActionAndSubject(
  candidate: SystemCapability,
  signal?: CapabilityProductTextSignal,
): boolean {
  if (!signal) return false;
  const clauses = [
    signal.productDocTitle,
    signal.productDocSummary,
    signal.manifestDescription,
    signal.summary,
  ].filter(Boolean).join('\n').split(/(?:[.!?;]|\n)+/).filter(Boolean);
  const operationActions = (candidate.operations || [])
    .flatMap(operation => outcomeIdentityTokens(operation.action || ''))
    .map(canonicalPurposeVerb)
    .filter((token): token is string => Boolean(token));
  const leadingIdentityAction = canonicalPurposeVerb(
    outcomeIdentityTokens([candidate.name, candidate.structural_label].filter(Boolean).join(' '))[0] || '',
  );
  const actionTerms = new Set([...operationActions, ...(leadingIdentityAction ? [leadingIdentityAction] : [])]);
  const identityTerms = outcomeIdentityTokens([candidate.name, candidate.structural_label].filter(Boolean).join(' '));
  const subjectTerms = [...normalizedSubjectTokens([candidate.structural_label, candidate.name].filter(Boolean).join(' '))]
    .filter(token => !canonicalPurposeVerb(token));
  if ((actionTerms.size === 0 && identityTerms.length === 0) || subjectTerms.length === 0) return false;
  return clauses.some(clause => {
    const clauseTokens = outcomeIdentityTokens(clause);
    const clauseActions = new Set(clauseTokens.map(canonicalPurposeVerb).filter((token): token is string => Boolean(token)));
    const inflectedClauseActions = new Set(String(clause || '').toLowerCase().split(/[^a-z0-9]+/).flatMap(inflectedActionBases));
    const clauseEvidence = new Set(clauseTokens);
    const actionMatches = [...actionTerms].some(action => clauseActions.has(action)) ||
      identityTerms.some(action => inflectedClauseActions.has(action));
    const subjectMatches = subjectTerms.filter(subject => outcomeTokenMatches(subject, clauseEvidence)).length;
    return actionMatches && subjectMatches >= Math.min(2, subjectTerms.length);
  });
}
