import { createHash } from 'crypto';
import * as path from 'path';

import {
  CAS_VERSION,
  type CASDataEntity,
  type CASEdge,
  type CASEntryPoint,
  type CASExitPoint,
  type CASNode,
  type CASOutput,
  type CASSystem,
} from '../../types/cas.types';
import type { TierStackIndex, TierStackNode } from './read-tier-stack';

const NODE_TYPES: Record<string, string> = {
  module: 'file',
  class: 'class',
  interface: 'interface',
  type_alias: 'type',
  enum: 'enum',
  function: 'function',
  method: 'method',
  constructor: 'method',
  getter: 'method',
  setter: 'method',
  property: 'property',
  variable: 'variable',
  external: 'external',
};

const EDGE_TYPES: Record<string, string> = {
  contains: 'contains',
  calls: 'calls',
  imports: 'imports',
  extends: 'extends',
  implements: 'implements',
  instantiates: 'instantiates',
  has_field: 'has_property',
  has_method: 'has_method',
};

export const TIER_STACK_ANALYZER = 'tier-stack';

function shapeOf(index: TierStackIndex): CASSystem['type'] {
  const shape = index.architecture?.shape ?? '';
  if (shape.includes('monorepo')) return 'monorepo';
  if (shape.includes('no served surface')) return 'library';
  return 'application';
}

function sourceOf(index: TierStackIndex, node: TierStackNode): CASNode['source'] {
  return {
    file: index.files[node.file]?.path,
    line: node.span.line,
    end_line: node.span.end_line,
    column: node.span.column,
    end_column: node.span.end_column,
  };
}

function nodesOf(index: TierStackIndex): CASNode[] {
  return index.nodes.map(node => ({
    id: node.id,
    name: node.name,
    type: NODE_TYPES[node.kind] ?? node.kind,
    parent: node.parent,
    description: node.documentation,
    description_source: node.documentation ? ('deterministic' as const) : undefined,
    analyzers: [TIER_STACK_ANALYZER],
    primaryAnalyzer: TIER_STACK_ANALYZER,
    source: sourceOf(index, node),
    metadata: { language: index.files[node.file]?.language },
  }));
}

function edgesOf(index: TierStackIndex): CASEdge[] {
  return index.edges.map((edge, at) => ({
    id: `edge:${at}`,
    source: edge.source,
    target: edge.target,
    type: EDGE_TYPES[edge.kind] ?? edge.kind,
  }));
}

function entryPointsOf(index: TierStackIndex): CASEntryPoint[] {
  return (index.entry_points ?? []).map(entry => ({
    id: entry.id,
    source_node: entry.handler,
    source_analyzer: TIER_STACK_ANALYZER,
    type: entry.kind,
    name: entry.name,
    trigger: entry.registrar,
    metadata: { method: entry.method, path: entry.path },
  })) as CASEntryPoint[];
}

function exitPointsOf(index: TierStackIndex): CASExitPoint[] {
  return (index.exit_points ?? []).map(exit => ({
    id: exit.id,
    source_node: exit.source,
    type: exit.kind,
    name: exit.target,
    target: exit.target,
  })) as CASExitPoint[];
}

function flowsOf(index: TierStackIndex): CASOutput['flows'] {
  return (index.comprehension?.flows ?? []).map(flow => ({
    flow_id: flow.id,
    name: flow.name ?? flow.operation,
    intent: flow.operation,
    description: flow.description,
    entry_point: flow.entry_point,
    entities: [...(flow.writes ?? []), ...(flow.reads ?? [])],
    contract: {} as never,
    steps: [],
  })) as CASOutput['flows'];
}

function entitiesOf(index: TierStackIndex): CASDataEntity[] {
  return (index.comprehension?.entities ?? []).map(entity => ({
    id: entity.id,
    name: entity.name ?? entity.declared_as,
    lifecycle: {
      created_by: entity.written_by,
      read_by: entity.read_by,
    },
    description: entity.description,
    fields: (entity.named_fields ?? []).map(named => ({ name: named })),
    relationships: (entity.references ?? []).map(reference => ({
      field: reference.field,
      entity: reference.entity,
      cardinality: reference.many ? 'many' : 'one',
    })),
  })) as unknown as CASDataEntity[];
}

function dependenciesOf(index: TierStackIndex): CASOutput['dependencies'] {
  return {
    manager: 'declared',
    packages: (index.dependencies?.dependencies ?? []).map(held => ({
      name: held.name,
      version: '',
      direct: (held.imports ?? 0) > 0,
    })),
  };
}

export function tierStackToCas(index: TierStackIndex, displayName?: string): CASOutput {
  const name = displayName ?? path.basename(index.root);
  const nodes = nodesOf(index);
  const edges = edgesOf(index);
  const entry_points = entryPointsOf(index);
  const analysis_id = createHash('sha256')
    .update(`${index.root}:${nodes.length}:${edges.length}`)
    .digest('hex')
    .slice(0, 16);

  return {
    cas_version: CAS_VERSION,
    analysis_id,
    analysis_timestamp: new Date().toISOString(),
    system: {
      id: `system:${name}`,
      name,
      type: shapeOf(index),
      root_path: index.root,
    },
    nodes,
    edges,
    entry_points,
    exit_points: exitPointsOf(index),
    entities: entitiesOf(index),
    capabilities: (index.comprehension?.capabilities ?? []) as CASOutput['capabilities'],
    flows: flowsOf(index),
    dependencies: dependenciesOf(index),
    analyzer_contributions: [
      {
        analyzer_id: TIER_STACK_ANALYZER,
        analyzer_name: 'Tier stack',
        contribution_type: 'language',
        nodes_created: nodes.length,
        edges_created: edges.length,
      },
    ],
    progressive_levels: { total_levels: 0 },
  };
}
