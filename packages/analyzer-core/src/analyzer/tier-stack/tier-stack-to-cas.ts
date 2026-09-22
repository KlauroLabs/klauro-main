import { createHash } from 'crypto';
import * as path from 'path';

import {
  CAS_VERSION,
  type CapabilityFlowRelationship,
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
  type DeployableEvidence,
  type CASSystem,
} from '../../types/cas.types';
import type {
  TierStackCapability,
  TierStackShipDeclaration,
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
    trigger: {
      method: entry.method,
      path: entry.path,
      ...(entry.kind === 'event' ? { event: entry.name } : {}),
      ...(entry.kind === 'schedule' ? { schedule: entry.name } : {}),
    },
    metadata: { registrar: entry.registrar },
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
  const serving = servingByFlow(index);
  return (index.comprehension?.flows ?? []).map(flow => ({
    flow_id: flow.id,
    name: flow.name ?? flow.operation,
    intent: flow.operation,
    description: flow.description,
    entry_point: flow.entry_point,
    entities: [...(flow.writes ?? []), ...(flow.reads ?? [])],
    contract: contractOf(flow),
    steps: stepsOf(flow),
    capability_relationships: serving.get(flow.id) ?? [],
  }));
}

function whatTheSystemDelivers(index: TierStackIndex) {
  const held = index.comprehension?.capabilities ?? [];
  const whole = held.filter(capability => capability.project === undefined || capability.project === null);
  return whole.length > 0 ? whole : held;
}

function servingByFlow(index: TierStackIndex): Map<string, CapabilityFlowRelationship[]> {
  const serving = new Map<string, CapabilityFlowRelationship[]>();
  for (const capability of whatTheSystemDelivers(index)) {
    for (const delivery of capability.delivered ?? []) {
      const held = serving.get(delivery.flow) ?? [];
      held.push({
        capability_id: capability.id,
        role: delivery.role === 'primary' ? 'primary' : 'supporting',
        rationale: delivery.rationale,
      });
      serving.set(delivery.flow, held);
    }
  }
  return serving;
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
  return whatTheSystemDelivers(index).map(capability => {
    const published = capability.standing !== 'provisional';
    return {
      id: capability.id,
      name: capability.name ?? capability.id,
      name_source: 'ai' as const,
      description: capability.description ?? '',
      description_source: 'ai' as const,
      category: published ? ('core' as const) : ('supporting' as const),
      operations: operationsOf(capability.surfaces ?? []),
      related_entities: capability.touches ?? capability.records ?? [],
      related_domains: capability.audience === undefined ? [] : [capability.audience],
      criticality: (capability.changes ?? []).length > 0 ? ('high' as const) : ('medium' as const),
      criticality_factors: (capability.changes ?? []).map(held => `changes ${held}`),
      evidence_role: published ? ('product-outcome' as const) : ('supporting-mechanism' as const),
      evidence_role_reasons: reasonsFor(capability),
    };
  });
}

function reasonsFor(capability: TierStackCapability): string[] {
  const grounding = capability.grounding;
  if (grounding === undefined) return [];
  const reasons = [
    `supported ${grounding.supported.toFixed(2)}`,
    `invented ${grounding.invented.toFixed(2)}`,
    `reads as an outcome ${grounding.outcome.toFixed(2)}`,
  ];
  if (grounding.universal !== undefined) {
    reasons.push(`true of most systems ${grounding.universal.toFixed(2)}`);
  }
  return reasons;
}

const SHIPS_AS: Record<string, { tier: 1 | 2 | 3; kind: DeployableEvidence['kind'] }> = {
  'container': { tier: 1, kind: 'container' },
  'compose-service': { tier: 1, kind: 'compose-service' },
  'installer': { tier: 1, kind: 'installer' },
  'package-bin': { tier: 2, kind: 'bin' },
  'cargo-bin': { tier: 2, kind: 'bin' },
  'start-script': { tier: 2, kind: 'bin' },
  'runnable-module': { tier: 2, kind: 'server-entry' },
  'package-identity': { tier: 3, kind: 'package' },
};

function shipsAs(declared: TierStackShipDeclaration): { tier: 1 | 2 | 3; kind: DeployableEvidence['kind'] } {
  return SHIPS_AS[declared.kind] ?? { tier: 3, kind: 'package' };
}

function deployablesOf(index: TierStackIndex): DeployableEvidence[] {
  return (index.scope?.deployables ?? []).flatMap(deployable => {
    const declarations = deployable.declarations ?? [];
    const strongest = declarations
      .map(shipsAs)
      .sort((left, right) => left.tier - right.tier)[0];
    if (strongest === undefined) return [];
    return [{
      root_path: deployable.root,
      name: deployable.name,
      tier: strongest.tier,
      kind: strongest.kind,
      evidence: declarations.map(declared => `${declared.declares} ${declared.kind} at ${declared.at}`),
      ...(deployable.entered_at?.length ? { entry_files: deployable.entered_at } : {}),
      ...(deployable.ships?.length ? { ships_paths: deployable.ships } : {}),
      ...(deployable.bundled_into ? { bundled_into: deployable.bundled_into } : {}),
    }];
  });
}

function purposeOf(index: TierStackIndex): CASOutput['enhanced_system_purpose'] {
  const comprehension = index.comprehension;
  if (comprehension === undefined) return undefined;
  const capabilities = whatTheSystemDelivers(index);
  const published = capabilities.filter(capability => capability.standing !== 'provisional').length;
  const provisional = capabilities.length - published;
  const product = (comprehension.products ?? [])[0];
  return {
    primary_type: 'application',
    primary_domain: '',
    confidence: product?.grounding.supported ?? 0,
    evidence: capabilities.map(capability => capability.name ?? capability.id),
    inferred_description: product?.description ?? '',
    description_source: 'ai',
    core_concepts: (comprehension.entities ?? [])
      .map(entity => entity.name)
      .filter((name): name is string => name !== undefined),
    supporting_workflow_ids: capabilities.flatMap(capability => capability.flows ?? []),
    capability_catalog_coverage: {
      evidence_families: capabilities.length,
      published_capabilities: capabilities.length,
      actual_publishable_capabilities: published,
      status: coverageStatus(capabilities.length, published),
      ...(provisional > 0
        ? { reason: `${provisional} of ${capabilities.length} read as a mechanism rather than an outcome` }
        : {}),
    },
  };
}

function coverageStatus(
  total: number,
  published: number,
): NonNullable<NonNullable<CASOutput['enhanced_system_purpose']>['capability_catalog_coverage']>['status'] {
  if (total === 0) return 'unavailable';
  return published > 0 ? 'accepted' : 'partial';
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
  const eligible = index.files.filter(file => file.language !== undefined && file.generated !== true);
  const read = eligible.filter(file => file.extracted === true).length;
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
      files_eligible: eligible.length,
      files_analyzed: read,
      files_skipped: eligible.length - read,
      files_partial: 0,
      complete: read === eligible.length,
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

function within(index: TierStackIndex, project: string): TierStackIndex {
  const nodes = index.nodes.filter(node => node.project === project);
  const held = new Set(nodes.map(node => node.id));
  const comprehension = index.comprehension;
  return {
    ...index,
    nodes,
    edges: (index.edges ?? []).filter(edge => held.has(edge.source) && held.has(edge.target)),
    entry_points: (index.entry_points ?? []).filter(entry => held.has(entry.handler)),
    exit_points: (index.exit_points ?? []).filter(exit => held.has(exit.source)),
    ...(comprehension === undefined ? {} : {
      comprehension: {
        ...comprehension,
        products: (comprehension.products ?? []).filter(held => held.project === project),
        capabilities: (comprehension.capabilities ?? []).filter(held => held.project === project),
        flows: (comprehension.flows ?? []).filter(held => held.project === project),
        entities: (comprehension.entities ?? []).filter(held => held.project === project),
      },
    }),
  };
}

function heldWithin(held: string, owner: string): boolean {
  return owner !== '' && held !== owner && held.startsWith(`${owner}/`);
}

function casIdOf(name: string, part?: string): string {
  return part === undefined ? `cas:${name}` : `cas:${name}:${part}`;
}

function borneBy(index: TierStackIndex, name: string): CASOutput[] {
  const parts = index.partition?.sub_projects ?? [];
  if (parts.length < 2) return [];
  const built = new Map<string, CASOutput>();
  for (const part of parts) {
    const held = within(index, part.id);
    if (held.nodes.length === 0) continue;
    const child = casOf(held, part.name);
    child.system.root_path = part.root === '' ? index.root : `${index.root}/${part.root}`;
    child.id = casIdOf(name, part.id);
    built.set(part.root, child);
  }
  const roots = [...built.keys()];
  const borne: CASOutput[] = [];
  for (const [root, child] of built) {
    const owner = roots
      .filter(other => heldWithin(root, other))
      .sort((left, right) => right.length - left.length)[0];
    const holder = owner === undefined ? undefined : built.get(owner);
    if (holder === undefined) {
      borne.push(child);
      continue;
    }
    child.parent_id = holder.id;
    holder.children = [...(holder.children ?? []), child];
    holder.composition_mode = 'derived';
  }
  return borne;
}

export function tierStackToCas(index: TierStackIndex, displayName?: string): CASOutput {
  const name = displayName ?? path.basename(index.root);
  const whole = casOf(index, name);
  whole.id = casIdOf(name);
  whole.parent_id = null;
  const borne = borneBy(index, name);
  if (borne.length < 2) return whole;
  for (const child of borne) child.parent_id = whole.id;
  return { ...whole, children: borne, composition_mode: 'derived' };
}

function casOf(index: TierStackIndex, displayName?: string): CASOutput {
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
    deployable_evidence: deployablesOf(index),
    enhanced_system_purpose: purposeOf(index),
    flows: flowsOf(index),
    dependencies: dependenciesOf(index),
    analyzer_contributions: [contributionOf(index, nodes, edges, entry_points)],
    progressive_levels: levelsOf(nodes),
  };
}
