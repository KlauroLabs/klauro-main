import type { CASEdge, CASNode } from '../../types/cas.types';
import type { TierStackIndex } from './read-tier-stack';

const TIER_STACK_ANALYZER = 'tier-stack';
const SECURITY_LEVEL_FUNCTION = 4;
const SECURITY_LEVEL_CONTRACT = 2;

interface TierStackInjection {
  source: string;
  target: string;
  dependency_type: string;
  through: string;
}

interface TierStackSecurityFact {
  fact: string;
  kind: string;
  contract: string;
  function?: string;
  file: number;
  line: number;
  end_line: number;
  description: string;
  [carried: string]: unknown;
}

interface Carried {
  injections?: TierStackInjection[];
  security?: TierStackSecurityFact[];
}

const FACT_ENVELOPE = new Set(['fact', 'kind', 'contract', 'function', 'file', 'line', 'end_line', 'description']);

export function injectionEdgesOf(index: TierStackIndex, first: number): CASEdge[] {
  const held = (index as unknown as Carried).injections ?? [];
  return held.map((injection, at) => ({
    id: `edge:${first + at}`,
    source: injection.source,
    target: injection.target,
    type: 'depends_on',
    metadata: { attributes: { dependency_type: injection.dependency_type, injected_through: injection.through } },
  }));
}

export function securityFactNodesOf(index: TierStackIndex): CASNode[] {
  const held = (index as unknown as Carried).security ?? [];
  return held.map(fact => {
    const file = index.files[fact.file]?.path ?? '';
    const atFunction = fact.function !== undefined;
    return {
      id: `${file}:security:${fact.contract}:${fact.fact}`,
      name: fact.fact,
      type: 'security-fact',
      description: fact.description,
      description_source: 'deterministic',
      category: 'security',
      subcategories: ['solidity-security', fact.kind],
      level: atFunction ? SECURITY_LEVEL_FUNCTION : SECURITY_LEVEL_CONTRACT,
      level_name: 'security-facts',
      analyzers: [TIER_STACK_ANALYZER],
      primaryAnalyzer: TIER_STACK_ANALYZER,
      tags: ['solidity-security-fact', `security-fact:${fact.kind}`],
      parent: file,
      source: { file, line: fact.line, end_line: fact.end_line },
      metadata: {
        attributes: {
          fact_kind: fact.kind,
          contract: fact.contract,
          file,
          ...(atFunction ? { function: fact.function } : {}),
          ...Object.fromEntries(Object.entries(fact).filter(([key, value]) => !FACT_ENVELOPE.has(key) && value !== undefined)),
        },
      },
    } as CASNode;
  });
}

export function factsWithin(index: TierStackIndex, nodes: Set<string>, files: Set<number>): Carried {
  const carried = index as unknown as Carried;
  return {
    injections: (carried.injections ?? []).filter(edge => nodes.has(edge.source) && nodes.has(edge.target)),
    security: (carried.security ?? []).filter(fact => files.has(fact.file)),
  };
}
