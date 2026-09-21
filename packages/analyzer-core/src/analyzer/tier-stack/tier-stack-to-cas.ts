import { createHash } from 'crypto';
import * as path from 'path';

import {
  CAS_VERSION,
  type FlowICELOTContract,
  type FlowStep,
  type CASDataEntity,
  type CASEdge,
  type CASEntryPoint,
  type CASExitPoint,
  type CASAnalyzerContribution,
  type CASArchitectureSummary,
  type CASNode,
  type CASOutput,
  type CASRouteTableEntry,
  type CASSystem,
} from '../../types/cas.types';
import type {
  TierStackDeclaration,
  TierStackFlow,
  TierStackIndex,
  TierStackNode,
} from './read-tier-stack';

const EVIDENCE: Record<TierStackDeclaration, CASRelationEvidence> = {
  type: 'typed-composition',
  'foreign key': 'orm-declaration',
  decorator: 'orm-edge',
  call: 'orm-edge',
};

type CASRelationEvidence = 'orm-edge' | 'orm-declaration' | 'typed-composition' | 'structural-edge';

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

function depths(nodes: TierStackNode[]): Map<string, number> {
  const held = new Map(nodes.map(node => [node.id, node]));
  const found = new Map<string, number>();
  const depthOf = (node: TierStackNode, climbed: Set<string>): number => {
    const known = found.get(node.id);
    if (known !== undefined) return known;
    if (climbed.has(node.id)) return 1;
    climbed.add(node.id);
    const above = node.parent === undefined ? undefined : held.get(node.parent);
    const depth = above === undefined ? 1 : depthOf(above, climbed) + 1;
    found.set(node.id, depth);
    return depth;
  };
  for (const node of nodes) depthOf(node, new Set());
  return found;
}

function nodesOf(index: TierStackIndex): CASNode[] {
  const depth = depths(index.nodes);
  return index.nodes.map(node => ({
    id: node.id,
    name: node.name,
    type: NODE_TYPES[node.kind] ?? node.kind,
    parent: node.parent,
    level: depth.get(node.id),
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

function contractOf(flow: TierStackFlow): FlowICELOTContract {
  return {
    input: flow.reads ?? [],
    logic: flow.operation,
    side_effects: {
      state_changes: flow.writes ?? [],
      external_integrations: flow.changes ?? [],
    },
    output: flow.leads_into ?? [],
    constraints: [],
  };
}

function stepsOf(flow: TierStackFlow): FlowStep[] {
  return (flow.steps ?? []).map((step, at) => ({
    step_id: `${flow.id}:${at}`,
    order: at + 1,
    name: step.unit,
    description: `${flow.operation} reaches ${step.unit}`,
    description_source: 'deterministic-label' as const,
    contract: contractOf(flow),
    functions: [{ function_id: step.unit }],
    entities: step.leaves ?? [],
  }));
}

function flowsOf(index: TierStackIndex): CASOutput['flows'] {
  return (index.comprehension?.flows ?? []).map(flow => ({
    flow_id: flow.id,
    name: flow.name ?? flow.operation,
    intent: flow.operation,
    description: flow.description,
    entry_point: flow.entry_point,
    entities: [...(flow.writes ?? []), ...(flow.reads ?? [])],
    contract: contractOf(flow),
    steps: stepsOf(flow),
  }));
}

function entitiesOf(index: TierStackIndex): CASDataEntity[] {
  return (index.comprehension?.entities ?? []).map(entity => ({
    id: entity.id,
    name: entity.name ?? entity.declared_as,
    schema_source: entity.declared_in,
    description: entity.description,
    description_source: entity.description ? ('ai' as const) : undefined,
    fields: (entity.named_fields ?? []).map(field => ({
      name: field.name,
      type: field.declared_as ?? '',
      is_sensitive: false,
      is_relation: (entity.references ?? []).some(held => held.field === field.name),
    })),
    relations: (entity.references ?? []).map(reference => ({
      target_name: reference.entity,
      relation_type: 'references',
      kind: 'data' as const,
      cardinality: reference.many ? ('1:N' as const) : ('N:1' as const),
      field: reference.field,
      evidence_source: EVIDENCE[reference.declared_by],
      evidence: `${entity.declared_as}.${reference.field} names ${reference.entity} by ${reference.declared_by}`,
    })),
    lifecycle: {
      created_by: entity.written_by,
      read_by: entity.read_by,
      updated_by: entity.written_by,
      deleted_by: [],
    },
  }));
}

function capabilitiesOf(index: TierStackIndex): CASOutput['capabilities'] {
  const reached = new Map((index.entry_points ?? []).map(entry => [entry.id, entry]));
  const operationsOf = (surfaces: string[]) =>
    surfaces.flatMap(surface => {
      const entry = reached.get(surface);
      return entry === undefined
        ? []
        : [{
            entry_point_id: entry.id,
            entry_point_type: entry.kind,
            action: entry.name,
            path_or_command: entry.path,
            trigger: { method: entry.method, path: entry.path },
          }];
    });
  return (index.comprehension?.capabilities ?? []).map(capability => ({
    id: capability.id,
    name: capability.name ?? capability.id,
    description: capability.description ?? '',
    category: 'core' as const,
    operations: operationsOf(capability.surfaces ?? []),
    related_entities: capability.records ?? [],
    related_domains: capability.audience === undefined ? [] : [capability.audience],
    criticality: (capability.changes ?? []).length > 0 ? ('high' as const) : ('medium' as const),
    criticality_factors: (capability.changes ?? []).map(held => `changes ${held}`),
  }));
}

function levelsOf(nodes: CASNode[]): CASOutput['progressive_levels'] {
  const deepest = nodes.reduce((held, node) => Math.max(held, node.level ?? 0), 0);
  return {
    total_levels: deepest,
    level_definitions: Array.from({ length: deepest }, (_, at) => ({
      level: at + 1,
      node_count: nodes.filter(node => node.level === at + 1).length,
    })),
  };
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

function contributionOf(
  index: TierStackIndex,
  nodes: CASNode[],
  edges: CASEdge[],
  entry_points: CASEntryPoint[]
): CASAnalyzerContribution {
  const read = index.files.filter(file => file.extracted === true).length;
  return {
    analyzer_id: TIER_STACK_ANALYZER,
    analyzer_name: 'Tier stack',
    contribution_type: 'language',
    nodes_created: nodes.length,
    edges_created: edges.length,
    contributed_entry_points: entry_points.length,
    contributed_exit_points: (index.exit_points ?? []).length,
    analysis_scope: {
      applicability: 'file-coverage',
      files_eligible: index.files.length,
      files_analyzed: read,
      files_skipped: index.files.length - read,
      files_partial: 0,
      complete: read === index.files.length,
    },
  };
}

function routesOf(index: TierStackIndex): CASRouteTableEntry[] {
  const holder = new Map(index.nodes.map(node => [node.id, node]));
  const guarded = new Set(
    (index.roles?.roles ?? [])
      .filter(held => held.role === 'middleware')
      .map(held => held.node)
  );
  return (index.entry_points ?? [])
    .filter(entry => entry.path !== undefined)
    .map(entry => ({
      method: entry.method ?? 'ANY',
      path: entry.path as string,
      controller: holder.get(entry.handler)?.parent ?? index.files[entry.file]?.path ?? '',
      handler: holder.get(entry.handler)?.name ?? entry.handler,
      auth: guarded.has(entry.handler),
      source_node: entry.handler,
    }));
}

function technologiesOf(index: TierStackIndex): CASSystem['technologies'] {
  const counted = new Map<string, number>();
  for (const file of index.files) {
    if (file.language === undefined) continue;
    counted.set(file.language, (counted.get(file.language) ?? 0) + 1);
  }
  return {
    languages: [...counted]
      .sort(([, left], [, right]) => right - left)
      .map(([name, files]) => ({ name, files })),
    frameworks: (index.dependencies?.dependencies ?? [])
      .filter(held => held.role === 'framework')
      .map(held => ({ name: held.name })),
  };
}

function architectureOf(index: TierStackIndex, nodes: CASNode[]): CASArchitectureSummary {
  const serving = index.architecture?.serving ?? 0;
  return {
    system_type: index.architecture?.shape ?? 'unstated',
    total_files: index.files.length,
    layers: {
      presentation: { endpoints: index.architecture?.routes ?? 0, controllers: serving },
      business: { services: nodes.filter(node => node.type === 'class').length },
      data: { entities: (index.comprehension?.entities ?? []).length },
    },
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
      technologies: technologiesOf(index),
    },
    architecture_summary: architectureOf(index, nodes),
    route_table: routesOf(index),
    nodes,
    edges,
    entry_points,
    exit_points: exitPointsOf(index),
    entities: entitiesOf(index),
    capabilities: capabilitiesOf(index),
    flows: flowsOf(index),
    dependencies: dependenciesOf(index),
    analyzer_contributions: [contributionOf(index, nodes, edges, entry_points)],
    progressive_levels: levelsOf(nodes),
  };
}
