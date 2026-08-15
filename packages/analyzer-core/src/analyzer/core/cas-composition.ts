import type {
  CASDataEntity,
  CASEdge,
  CASNode,
  CASOutput,
  CASSystem,
  FlowConcept,
  FlowStep,
  SystemCapability,
} from '../../types/cas.types';
import { assertValidCasTree } from './recursive-cas';
import { buildCasTerminality } from './terminality';

export interface CASCompositionRelation {
  id?: string;
  source_cas_id: string;
  target_cas_id: string;
  type: string;
  confidence?: number;
  evidence?: string[];
  metadata?: Record<string, unknown>;
}

export interface CASCompositionInput {
  id: string;
  label: string;
  cas_version: string;
  analysis_id: string;
  analysis_timestamp: string;
  system: CASSystem;
  children: CASOutput[];
  relations?: CASCompositionRelation[];
  derive_comprehension: (context: CASCompositionContext) => CASComprehension;
  analyzer_build?: string;
  parser_fingerprint?: string;
  derived_fingerprint?: string;
}

export interface CASComprehension {
  capabilities: SystemCapability[];
  flows: FlowConcept[];
  steps: FlowStep[];
  entities: CASDataEntity[];
}

export interface CASCompositionContext {
  parent_id: string;
  children: ReadonlyArray<CASOutput>;
  relations: ReadonlyArray<CASCompositionRelation>;
  nodes: ReadonlyArray<CASNode>;
  edges: ReadonlyArray<CASEdge>;
}

function stableHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function relationKey(relation: CASCompositionRelation): string {
  return [relation.source_cas_id, relation.target_cas_id, relation.type].join('\u0000');
}

function assertUniqueIds(values: string[], section: keyof CASComprehension): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (!value) throw new Error(`CAS composition ${section} require stable ids.`);
    if (seen.has(value)) throw new Error(`CAS composition ${section} contain duplicate id ${value}.`);
    seen.add(value);
  }
}

function assertValidComprehension(comprehension: CASComprehension): void {
  assertUniqueIds(comprehension.capabilities.map(item => item.id), 'capabilities');
  assertUniqueIds(comprehension.flows.map(item => item.flow_id), 'flows');
  assertUniqueIds(comprehension.steps.map(item => item.step_id), 'steps');
  assertUniqueIds(comprehension.entities.map(item => item.id), 'entities');
  const flowStepIds = new Set(comprehension.flows.flatMap(flow => flow.steps.map(step => step.step_id)));
  const storedStepIds = new Set(comprehension.steps.map(step => step.step_id));
  if (flowStepIds.size !== storedStepIds.size || [...flowStepIds].some(id => !storedStepIds.has(id))) {
    throw new Error('CAS composition steps must exactly match the steps nested in composed flows.');
  }
}

export function composeCas(input: CASCompositionInput): CASOutput {
  if (input.children.length === 0) throw new Error('CAS composition requires at least one child.');
  const children = input.children.map(child => ({ ...child, parent_id: input.id }));
  const childIds = new Set(children.map(child => child.id));
  if (childIds.has(undefined)) throw new Error('CAS composition children require stable ids.');

  const relationMap = new Map<string, CASCompositionRelation>();
  for (const relation of input.relations || []) {
    if (!childIds.has(relation.source_cas_id) || !childIds.has(relation.target_cas_id)) {
      throw new Error(`CAS composition relation ${relation.type} references a child outside the composition.`);
    }
    relationMap.set(relationKey(relation), relation);
  }

  const nodes: CASNode[] = children.map(child => ({
    id: child.id!,
    name: child.label || child.system.name,
    type: 'cas',
    category: 'composition',
    metadata: { attributes: { cas_id: child.id, system_type: child.system.type } },
  }));
  const edges: CASEdge[] = [...relationMap.entries()].map(([key, relation]) => ({
    id: relation.id || `cas-relation:${stableHash(key)}`,
    source: relation.source_cas_id,
    target: relation.target_cas_id,
    type: relation.type,
    metadata: {
      confidence: relation.confidence,
      attributes: {
        ...(relation.metadata || {}),
        ...(relation.evidence ? { evidence: relation.evidence } : {}),
      },
    },
  }));
  const comprehension = input.derive_comprehension({
    parent_id: input.id,
    children,
    relations: [...relationMap.values()],
    nodes,
    edges,
  });
  assertValidComprehension(comprehension);
  const root: CASOutput = {
    id: input.id,
    parent_id: null,
    label: input.label,
    composition_mode: 'composed',
    children,
    cas_version: input.cas_version,
    analysis_id: input.analysis_id,
    analysis_timestamp: input.analysis_timestamp,
    system: input.system,
    nodes,
    edges,
    capabilities: comprehension.capabilities,
    flows: comprehension.flows,
    steps: comprehension.steps,
    entities: comprehension.entities,
    analyzer_contributions: [],
    progressive_levels: { total_levels: 0 },
    ...(input.analyzer_build ? { analyzer_build: input.analyzer_build } : {}),
    ...(input.parser_fingerprint ? { parser_fingerprint: input.parser_fingerprint } : {}),
    ...(input.derived_fingerprint ? { derived_fingerprint: input.derived_fingerprint } : {}),
  };
  root.terminality = buildCasTerminality(root);
  assertValidCasTree(root);
  return root;
}
