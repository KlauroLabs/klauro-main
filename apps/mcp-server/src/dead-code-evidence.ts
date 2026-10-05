import type { CASNode } from '../../../packages/analyzer-core/src/types/cas.types';

export interface DeadCodeFact {
  node: string;
  reason: string;
  callers: number;
  open?: string;
  unlinked?: number;
}

export interface DeadCodeFinding {
  name: string;
  type: string;
  file?: string;
  line?: number;
  status: 'dead' | 'possibly-dead';
  reason: string;
  evidence: string[];
}

const REASON_ORDER = ['no-inbound', 'exported-unused', 'only-from-dead-callers', 'only-from-tests'];

function reasonEvidence(fact: DeadCodeFact): string {
  switch (fact.reason) {
    case 'no-inbound':
      return 'no call reaches it and no entry point registers it';
    case 'exported-unused':
      return 'it is exported but no call reaches it inside this repository; a consumer outside the repository could still use it';
    case 'only-from-tests':
      return `${fact.callers} caller${fact.callers === 1 ? '' : 's'} reach it, and every route to it starts in a test; no entry point of the product reaches it`;
    case 'only-from-dead-callers':
      return `${fact.callers} caller${fact.callers === 1 ? '' : 's'} call it, and none of them is reachable from an entry point`;
    default:
      return fact.reason;
  }
}

function openEvidence(fact: DeadCodeFact, name: string): string | undefined {
  switch (fact.open) {
    case 'unlinked-calls':
      return `${fact.unlinked ?? 0} call${fact.unlinked === 1 ? '' : 's'} named '${name}' did not resolve to any declaration, so one may be a call to it`;
    case 'passed-as-value':
      return `its name is handed to a call as a value elsewhere, so it may be invoked through that value`;
    case 'dynamic-dispatch':
      return 'another type declares a method of the same name, or its type extends or implements another, so it may be called through dynamic dispatch';
    default:
      return undefined;
  }
}

export function deadCodeFinding(node: CASNode, fact: DeadCodeFact): DeadCodeFinding {
  const open = openEvidence(fact, node.name);
  return {
    name: node.name,
    type: node.type,
    file: node.source?.file,
    line: node.source?.line,
    status: open === undefined ? 'dead' : 'possibly-dead',
    reason: fact.reason,
    evidence: open === undefined ? [reasonEvidence(fact)] : [reasonEvidence(fact), open],
  };
}

export function ordered(findings: DeadCodeFinding[]): DeadCodeFinding[] {
  const rank = (finding: DeadCodeFinding) => (finding.status === 'dead' ? 0 : 100) + REASON_ORDER.indexOf(finding.reason);
  return [...findings].sort((left, right) => rank(left) - rank(right));
}

export function factOf(node: CASNode): DeadCodeFact | undefined {
  const held = node.metadata?.attributes?.dead_code as DeadCodeFact | undefined;
  return held === undefined ? undefined : held;
}
