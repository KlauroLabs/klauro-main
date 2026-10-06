import { createHash } from 'crypto';
import { databaseSchemaOf } from './tier-stack-schema';
import { factsWithin, injectionEdgesOf, securityFactNodesOf } from './tier-stack-facts';
import { conformanceOf, namedPatternsOf, patternsOf, projectsOfFound, violationsOf } from './tier-stack-structure';
import * as path from 'path';
import { seamsOf } from './tier-stack-seams';
import { effectsByFlow } from './tier-stack-links';
import { temporalStabilityOf } from './tier-stack-history';
import { analysisFactsOf, idiomsOf, invariantsOf } from './tier-stack-evidence';
import { buildGraphValidation } from '../core/graph-validation';

import {
  CAS_VERSION,
  type CapabilityFlowRelationship,
  type FlowConcept,
  type FlowEffect,
  type FlowICELOTContract,
  type FlowStep,
  type FlowStepEdge,
  type FlowStepGraph,
  type CASDataEntity,
  type CASEdge,
  type CASEntryPoint,
  type CASExitPoint,
  type CASAnalyzerContribution,
  type CASComposedClaimProvenance,
  type CASArchitectureSummary,
  type CASNode,
  type CASOutput,
  type CASPrincipleViolation,
  type CASRouteTableEntry,
  type CASTestCase,
  type CASTestSuite,
  type CASTestSummary,
  type DeployableEvidence,
  type CASSystem,
  type CASSystemCatalogEntry,
} from '../../types/cas.types';
import type {
  TierStackCapability,
  TierStackShipDeclaration,
  TierStackDeclaration,
  TierStackEdge,
  TierStackEntryPoint,
  TierStackExitPoint,
  TierStackFlow,
  TierStackIndex,
  TierStackLogicalStep,
  TierStackNode,
  TierStackSubProject,
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
  has_field: 'has_property',
};

const EDGE_ENVELOPE = new Set(['source', 'target', 'kind', 'via']);
const EDGE_METADATA_NUMBERS = ['weight', 'confidence', 'occurrences'] as const;
const EDGE_METADATA_FLAGS = ['bidirectional', 'transitive', 'async', 'conditional'] as const;

const ENTRY_ENVELOPE = new Set(['id', 'kind', 'name', 'method', 'path', 'handler', 'file', 'line', 'registrar', 'guards', 'unshipped']);
const EXIT_ENVELOPE = new Set([
  'id', 'kind', 'name', 'source', 'target', 'operation', 'file', 'line', 'awaited', 'addressed', 'service', 'endpoint', 'url', 'method',
]);

const CARRIED_SECTIONS: Record<string, keyof CASOutput> = {
  architectural_conflicts: 'architectural_conflicts',
  crossings: 'crossings',
  libraries: 'libraries',
  type_shapes: 'type_shapes',
};

function carriedBeyond(held: object, envelope: Set<string>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(held).filter(([key, value]) => !envelope.has(key) && value !== undefined));
}

function carriedLayeringViolations(index: TierStackIndex): CASPrincipleViolation[] {
  const held = index.layering_violations;
  return Array.isArray(held) ? (held as CASPrincipleViolation[]) : [];
}

function carriedSectionsOf(index: TierStackIndex): Partial<CASOutput> {
  const carried: Record<string, unknown> = {};
  for (const [section, key] of Object.entries(CARRIED_SECTIONS)) {
    const held = index[section];
    if (Array.isArray(held) && held.length > 0) carried[key] = held;
  }
  return carried as Partial<CASOutput>;
}

export const TIER_STACK_ANALYZER = 'tier-stack';

function shapeOf(index: TierStackIndex): CASSystem['type'] {
  const shape = index.architecture?.shape ?? '';
  if (shape.includes('monorepo')) return 'monorepo';
  const launched = (index.scope?.deployables ?? []).some(held => held.category !== 'library');
  if (shape.includes('no served surface') && !launched) return 'library';
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

function importNodesOf(index: TierStackIndex, depth: Map<string, number>): CASNode[] {
  return (index.imports ?? [])
    .filter(held => !held.specifier.startsWith('.') && index.files[held.file] !== undefined)
    .map(held => {
      const file = index.files[held.file];
      return {
        id: `${file.path}:import:${held.line}:${held.specifier}`,
        name: held.specifier,
        type: 'import',
        parent: file.path,
        level: (depth.get(file.path) ?? 1) + 1,
        analyzers: [TIER_STACK_ANALYZER],
        primaryAnalyzer: TIER_STACK_ANALYZER,
        source: { file: file.path, line: held.line },
        metadata: {
          language: file.language,
          source: held.specifier,
          specifiers: (held.names ?? []).map(name => ({
            name: name.local,
            imported: name.namespace ? '*' : name.imported ?? name.local,
          })),
          ...(held.type_only ? { type_only: true } : {}),
          ...(held.resolved === undefined ? {} : { attributes: { resolved: held.resolved } }),
        },
      };
    }) as CASNode[];
}

function nodesOf(index: TierStackIndex): CASNode[] {
  const depth = depths(index.nodes);
  const dead = new Map((index.dead ?? []).map(held => [held.node, held]));
  const declared = index.nodes.map(node => ({
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
    ...(node.signature === undefined ? {} : { signature: signatureOf(node.signature) }),
    metadata: {
      language: index.files[node.file]?.language,
      ...(node.modifiers?.exported ? { is_exported: true } : {}),
      ...(node.modifiers?.private_member ? { access_modifier: 'private' as const } : {}),
      ...(node.modifiers?.protected_member ? { access_modifier: 'protected' as const } : {}),
      ...(dead.has(node.id) ? { attributes: { dead_code: dead.get(node.id) } } : {}),
    },
  }));
  return [...declared, ...importNodesOf(index, depth), ...securityFactNodesOf(index)];
}

function signatureOf(signature: NonNullable<TierStackNode['signature']>): NonNullable<CASNode['signature']> {
  return {
    parameters: (signature.parameters ?? []).map(parameter => ({
      name: parameter.name,
      ...(parameter.type_annotation === undefined ? {} : { type: parameter.type_annotation }),
      ...(parameter.optional ? { optional: true } : {}),
      ...(parameter.default_value === undefined ? {} : { default_value: parameter.default_value }),
    })),
    ...(signature.return_type === undefined ? {} : { return_type: signature.return_type }),
    ...((signature.type_parameters ?? []).length === 0 ? {} : { type_parameters: signature.type_parameters }),
  };
}

function edgeMetadataOf(edge: TierStackEdge): CASEdge['metadata'] | undefined {
  const promoted: Record<string, unknown> = {};
  for (const key of EDGE_METADATA_NUMBERS) if (typeof edge[key] === 'number') promoted[key] = edge[key];
  for (const key of EDGE_METADATA_FLAGS) if (typeof edge[key] === 'boolean') promoted[key] = edge[key];
  const attributes = {
    ...(edge.via === undefined ? {} : { via: edge.via }),
    ...carriedBeyond(edge, new Set([...EDGE_ENVELOPE, ...EDGE_METADATA_NUMBERS, ...EDGE_METADATA_FLAGS])),
  };
  const metadata = { ...promoted, ...(Object.keys(attributes).length === 0 ? {} : { attributes }) };
  return Object.keys(metadata).length === 0 ? undefined : metadata;
}

function edgesOf(index: TierStackIndex): CASEdge[] {
  const structural = index.edges.map((edge, at) => {
    const metadata = edgeMetadataOf(edge);
    return {
      id: `edge:${at}`,
      source: edge.source,
      target: edge.target,
      type: EDGE_TYPES[edge.kind] ?? edge.kind,
      ...(metadata === undefined ? {} : { metadata }),
    };
  });
  return [...structural, ...injectionEdgesOf(index, structural.length)];
}

function enforcingGuards(entry: TierStackEntryPoint) {
  return (entry.guards ?? []).filter(guard => guard.kind !== 'open');
}

function entryPointsOf(index: TierStackIndex): CASEntryPoint[] {
  const named = new Map(index.nodes.map(node => [node.id, node.name]));
  return (index.entry_points ?? []).map(entry => ({
    id: entry.id,
    source_node: entry.handler,
    source_analyzer: TIER_STACK_ANALYZER,
    type: entry.kind,
    name: entry.name,
    handler: {
      node_id: entry.handler,
      method_name: named.get(entry.handler) ?? entry.name,
      file: index.files[entry.file]?.path,
      line: entry.line,
    },
    ...(enforcingGuards(entry).length === 0 ? {} : {
      security: {
        authenticated: true,
        guards: enforcingGuards(entry).map(guard => guard.name),
        enforcement: 'enforced' as const,
      },
    }),
    trigger: {
      method: entry.method,
      path: entry.path,
      ...(entry.kind === 'event' ? { event: entry.name } : {}),
      ...(entry.kind === 'schedule' ? { schedule: entry.name } : {}),
    },
    metadata: {
      registrar: entry.registrar,
      ...(entry.unshipped ? { unshipped: entry.unshipped } : {}),
      ...carriedBeyond(entry, ENTRY_ENVELOPE),
    },
  })) as CASEntryPoint[];
}

const HTTP_VERBS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);

function exitMethodOf(exit: TierStackExitPoint): string | undefined {
  if (exit.method !== undefined) return exit.method.toUpperCase();
  const verb = exit.operation?.toLowerCase();
  return exit.kind === 'api' && verb !== undefined && HTTP_VERBS.has(verb) ? verb.toUpperCase() : undefined;
}

function exitPointsOf(index: TierStackIndex): CASExitPoint[] {
  return (index.exit_points ?? []).map(exit => {
    const endpoint = exit.endpoint ?? exit.url ?? exit.addressed;
    const method = exitMethodOf(exit);
    const reachesOut = exit.kind === 'api' || exit.kind === 'webhook';
    return {
      id: exit.id,
      source_node: exit.source,
      type: exit.kind,
      name: reachesOut && endpoint !== undefined && exit.operation !== undefined
        ? `${exit.operation.toUpperCase()} ${endpoint}`
        : exit.name ?? exit.target,
      target: {
        ...(exit.service === undefined ? {} : { service_id: exit.service }),
        ...(endpoint === undefined ? {} : { endpoint }),
        ...(exit.target === '' ? {} : reachesOut ? { sdk: exit.target } : { resource: exit.target }),
      },
      operation: {
        ...(exit.operation === undefined ? {} : { action: exit.operation }),
        ...(method === undefined ? {} : { method }),
        ...(exit.awaited === undefined ? {} : { async: exit.awaited }),
      },
      metadata: {
        file: index.files[exit.file]?.path,
        line: exit.line,
        ...carriedBeyond(exit, EXIT_ENVELOPE),
      },
    };
  }) as CASExitPoint[];
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

const STEP_CHANGES = new Set(['change', 'create', 'remove']);
const STEP_REACHES_OUT = new Set(['call', 'hand_off', 'raise', 'keep']);

function stepContractOf(step: TierStackLogicalStep): FlowICELOTContract {
  const object = step.object === undefined ? [] : [step.object];
  return {
    input: step.kind === 'read' ? object : [],
    logic: step.doing ?? step.label,
    side_effects: {
      state_changes: STEP_CHANGES.has(step.kind) ? object : [],
      external_integrations: STEP_REACHES_OUT.has(step.kind) ? object : [],
    },
    output: step.kind === 'respond' ? object : [],
    constraints: step.kind === 'check'
      ? step.regions.slice(0, 1).map(region => ({
          kind: 'validation' as const,
          rule: step.label,
          evidence: `${region.unit}:${region.start_line}`,
        }))
      : [],
  };
}

function stepsOf(flow: TierStackFlow): FlowStep[] {
  return (flow.steps ?? []).map((step, at) => ({
    step_id: `${flow.id}:${step.id}`,
    order: at + 1,
    name: step.label,
    description: step.description ?? step.label,
    description_source: step.description === undefined ? ('deterministic-label' as const) : ('ai' as const),
    contract: stepContractOf(step),
    functions: step.regions.map(region => ({
      function_id: region.unit,
      section: { start_line: region.start_line, end_line: region.end_line, label: step.kind },
    })),
    entities: step.object === undefined ? [] : [step.object],
  }));
}

const STEP_EDGE_KINDS: Record<string, FlowStepEdge['kind']> = {
  then: 'sequence',
  when: 'branch',
  on_failure: 'error',
};

function stepGraphOf(flow: TierStackFlow): FlowStepGraph | undefined {
  const edges = (flow.step_edges ?? []).map(edge => ({
    from_step_id: `${flow.id}:${edge.from}`,
    to_step_id: `${flow.id}:${edge.to}`,
    kind: STEP_EDGE_KINDS[edge.kind] ?? 'sequence',
  }));
  return edges.length === 0 ? undefined : { edges };
}

const END_TO_END = /(^|\/)(e2e|playwright|cypress)(\/|\.|$)/i;

function testSuitesOf(index: TierStackIndex): CASTestSuite[] {
  const byFile = new Map<string, CASTestCase[]>();
  for (const held of index.verification?.cases ?? []) {
    const file = index.files[held.file]?.path ?? '';
    const cases = byFile.get(file) ?? [];
    cases.push({
      id: held.id,
      name: held.name,
      test_type: END_TO_END.test(file) ? 'e2e' : 'unit',
      status: { skipped: false, focused: false, flaky: false },
    });
    byFile.set(file, cases);
  }
  return [...byFile].map(([file, tests]) => ({
    id: `suite:${file}`,
    name: path.basename(file),
    file_path: file,
    test_type: END_TO_END.test(file) ? 'e2e' : 'unit',
    framework: '',
    tests,
  }));
}

function testSummaryOf(suites: CASTestSuite[]): CASTestSummary {
  const cases = suites.flatMap(suite => suite.tests);
  const endToEnd = cases.filter(held => held.test_type === 'e2e').length;
  return {
    total_tests: cases.length,
    by_type: { unit: cases.length - endToEnd, integration: 0, e2e: endToEnd, acceptance: 0, bdd: 0, other: 0 },
    by_status: { passing: 0, failing: 0, skipped: 0, flaky: 0, unknown: cases.length },
    execution: { status: 'not-run', source: 'static-analysis', observed_tests: 0 },
    coverage: { status: 'not-measured' },
    mocks: { total: 0 },
    fixtures: { total: 0 },
  };
}

function effectsOf(held: FlowEffect[] | undefined): Pick<FlowConcept, 'effects' | 'terminus'> {
  return held === undefined ? {} : { effects: held, terminus: held[held.length - 1] };
}

function flowsOf(index: TierStackIndex): CASOutput['flows'] {
  const serving = servingByFlow(index);
  const effects = effectsByFlow(index);
  return (index.comprehension?.flows ?? []).map(flow => ({
    flow_id: flow.id,
    name: flow.name ?? flow.operation,
    intent: flow.operation,
    description: flow.description,
    entry_point: flow.entry_point,
    standing: flow.standing,
    ...(flow.confidence === undefined ? {} : { confidence: flow.confidence }),
    ...(flow.unsettled === undefined ? {} : { unsettled: flow.unsettled }),
    ...(flow.open === undefined ? {} : { open: flow.open }),
    ...(flow.cut === undefined ? {} : { cut: flow.cut }),
    entities: [...(flow.writes ?? []), ...(flow.reads ?? [])],
    contract: contractOf(flow),
    steps: stepsOf(flow),
    step_graph: stepGraphOf(flow),
    capability_relationships: serving.get(flow.id) ?? [],
    ...effectsOf(effects.get(flow.id)),
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

const SENSITIVE = /(password|passwd|passcode|passphrase|secret|token|api_?key|private_?key|ssn|social_?security|card_?number|cardnum|cvv|cvc|security_?(number|code)|iban|account_?number|routing_?number|(^|_)pin($|_)|(^|_)dob($|_)|date_?of_?birth)/i;

function isSensitive(name: string): boolean {
  return SENSITIVE.test(name.replace(/^_+/, ''));
}

function entitiesOf(index: TierStackIndex): CASDataEntity[] {
  return (index.comprehension?.entities ?? []).map(entity => ({
    id: entity.id,
    name: entity.name ?? entity.declared_as,
    schema_source: entity.declared_in,
    description: entity.description,
    description_source: entity.description ? ('ai' as const) : undefined,
    ...(entity.persisted_by === undefined
      ? {}
      : { kind: 'persisted-entity' as const, kind_source: 'framework-evidence' as const, kind_evidence: entity.persisted_by }),
    fields: (entity.named_fields ?? []).map(field => ({
      name: field.name,
      type: field.declared_as ?? '',
      is_sensitive: isSensitive(field.name),
      is_relation: (entity.references ?? []).some(held => held.field === field.name),
    })),
    relations: (entity.references ?? []).map(reference => ({
      target_name: reference.entity,
      relation_type: 'references',
      kind: 'data' as const,
      cardinality: reference.cardinality ?? (reference.many ? ('1:N' as const) : ('N:1' as const)),
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

function capabilitiesOf(index: TierStackIndex, name: string): CASOutput['capabilities'] {
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
  const childCapabilities = new Map(
    (index.comprehension?.capabilities ?? [])
      .filter(held => held.project !== undefined && held.project !== null)
      .map(held => [`${held.project}\u0001${held.id}`, held]),
  );
  const flowEntries = new Map((index.comprehension?.flows ?? []).map(flow => [flow.id, flow.entry_point]));
  const handlers = new Map((index.entry_points ?? []).map(entry => [entry.id, entry.handler]));
  const provenanceOf = (capability: TierStackCapability): CASComposedClaimProvenance[] =>
    (capability.composition_provenance ?? []).map(claim => {
      const source = childCapabilities.get(`${claim.source_child}\u0001${claim.source_capability_id}`);
      const flows = source?.flows ?? [];
      const nodes = flows.flatMap(flow => {
        const handler = handlers.get(flowEntries.get(flow) ?? '');
        return handler === undefined ? [] : [handler];
      });
      return {
        source_child_id: casIdOf(name, claim.source_child),
        source_capability_id: claim.source_capability_id,
        source_node_ids: [...new Set(nodes)],
        source_flow_ids: flows,
        relation_path: [],
        confidence: claim.weight ?? 1,
        disposition: claim.disposition,
      };
    });
  return whatTheSystemDelivers(index).map(capability => {
    const provenance = provenanceOf(capability);
    return {
      id: capability.id,
      name: capability.name ?? capability.id,
      name_source: 'ai' as const,
      description: capability.description ?? '',
      description_source: 'ai' as const,
      category: capability.terminality === 'proximal' ? ('supporting' as const) : ('core' as const),
      operations: operationsOf(capability.surfaces ?? []),
      related_entities: capability.touches ?? capability.records ?? [],
      related_domains: capability.audience === undefined ? [] : [capability.audience],
      criticality: (capability.changes ?? []).length > 0 ? ('high' as const) : ('medium' as const),
      criticality_factors: (capability.changes ?? []).map(held => `changes ${held}`),
      ...(capability.confidence === undefined ? {} : { confidence: capability.confidence }),
      ...(capability.unsettled === undefined ? {} : { unsettled: capability.unsettled }),
      ...(provenance.length === 0 ? {} : { composition_provenance: provenance }),
      ...(capability.parent_originated === undefined ? {} : { parent_originated: capability.parent_originated }),
      evidence_role: 'product-outcome' as const,
      evidence_role_reasons: reasonsFor(capability),
    };
  });
}

function reasonsFor(capability: TierStackCapability): string[] {
  return [
    ...(capability.changes ?? []).map(record => `changes ${record}`),
    ...(capability.surfaces ?? []).slice(0, REASONS_SURFACES).map(surface => `reached through ${surface}`),
  ];
}

const REASONS_SURFACES = 3;

const SHIPS_AS: Record<string, { tier: 1 | 2 | 3; kind: DeployableEvidence['kind'] }> = {
  'container': { tier: 1, kind: 'container' },
  'compose-service': { tier: 1, kind: 'compose-service' },
  'installer': { tier: 1, kind: 'installer' },
  'package-bin': { tier: 2, kind: 'bin' },
  'cargo-bin': { tier: 2, kind: 'bin' },
  'start-script': { tier: 2, kind: 'bin' },
  'dotnet-executable': { tier: 2, kind: 'bin' },
  'gradle-application': { tier: 2, kind: 'bin' },
  'maven-artifact': { tier: 2, kind: 'bin' },
  'android-application': { tier: 2, kind: 'bin' },
  'runnable-module': { tier: 2, kind: 'server-entry' },
  'package-identity': { tier: 3, kind: 'package' },
};

const TIER_OF_DECLARATION: Record<string, 1 | 2 | 3> = { ship: 1, run: 2, identity: 3 };

function shipsAs(declared: TierStackShipDeclaration): { tier: 1 | 2 | 3; kind: DeployableEvidence['kind'] } {
  const known = SHIPS_AS[declared.kind];
  const tier = TIER_OF_DECLARATION[declared.declares] ?? known?.tier ?? 3;
  return { tier, kind: known?.kind ?? (tier === 1 ? 'bin' : 'package') };
}

function deployablesOf(index: TierStackIndex): DeployableEvidence[] {
  const partAt = new Map((index.partition?.sub_projects ?? []).map(part => [part.root, part.id]));
  const offeredBy = (root: string) => (index.comprehension?.capabilities ?? [])
    .filter(capability => capability.project !== undefined && capability.project === partAt.get(root))
    .map(capability => capability.name ?? capability.id);
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
      ...(offeredBy(deployable.root).length ? { capabilities: offeredBy(deployable.root) } : {}),
    }];
  });
}

function purposeOf(index: TierStackIndex): CASOutput['enhanced_system_purpose'] {
  const comprehension = index.comprehension;
  if (comprehension === undefined) return undefined;
  const capabilities = whatTheSystemDelivers(index);
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
      actual_publishable_capabilities: capabilities.length,
      status: capabilities.length === 0 ? 'unavailable' : 'accepted',
    },
  };
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
    .map(entry => {
      const enforcing = enforcingGuards(entry);
      return {
        method: entry.method ?? 'ANY',
        path: entry.path as string,
        controller: holder.get(entry.handler)?.parent ?? index.files[entry.file]?.path ?? '',
        handler: holder.get(entry.handler)?.name ?? entry.handler,
        auth: enforcing.length > 0 || guarded.has(entry.handler),
        ...(enforcing.length > 0 ? { guards: enforcing.map(guard => guard.name) } : {}),
        source_node: entry.handler,
      };
    });
}

const NOT_BUILT_WITH = new Set(['test', 'observability', 'standard']);

const BUILT_WITH_SHOWN = 12;

function builtWith(index: TierStackIndex, displayName?: string): Array<{ name: string }> {
  const own = displayName ? `${displayName.toLowerCase()}.` : undefined;
  const candidates = (index.dependencies?.dependencies ?? [])
    .filter(held => held.role === 'framework' || (held.role === 'library' && (held.imports ?? 0) > 0 && !NOT_BUILT_WITH.has(held.category ?? '')))
    .filter(held => own === undefined || !held.name.toLowerCase().startsWith(own))
    .sort((left, right) => (right.role === 'framework' ? 1 : 0) - (left.role === 'framework' ? 1 : 0) || (right.imports ?? 0) - (left.imports ?? 0) || left.name.length - right.name.length);
  const kept: string[] = [];
  for (const held of candidates) {
    if (kept.some(name => held.name.startsWith(`${name}.`))) continue;
    kept.push(held.name);
  }
  return kept.slice(0, BUILT_WITH_SHOWN).map(name => ({ name }));
}

function technologiesOf(index: TierStackIndex, displayName?: string): CASSystem['technologies'] {
  const counted = new Map<string, number>();
  for (const file of index.files) {
    if (file.language === undefined) continue;
    counted.set(file.language, (counted.get(file.language) ?? 0) + 1);
  }
  const services = index.services ?? [];
  return {
    languages: [...counted]
      .sort(([, left], [, right]) => right - left)
      .map(([name, files]) => ({ name, files })),
    frameworks: builtWith(index, displayName),
    databases: services.filter(held => held.kind === 'database').map(held => held.name),
    infrastructure: services.filter(held => held.kind !== 'database').map(held => held.name),
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
  const ownFiles = new Set(nodes.map(node => node.file));
  return {
    ...index,
    files: index.files.map((file, at) => (ownFiles.has(at) ? file : { ...file, language: undefined })),
    nodes,
    imports: (index.imports ?? []).filter(held => ownFiles.has(held.file)),
    dependencies: index.dependencies === undefined ? undefined : {
      ...index.dependencies,
      dependencies: (index.dependencies.dependencies ?? []).filter(held => (held.projects ?? []).includes(project)),
    },
    services: (index.services ?? []).filter(held => (held.projects ?? []).includes(project)),
    patterns: {
      found: (index.patterns?.found ?? []).filter(found => projectsOfFound(found, index).has(project)),
      conformance: (index.patterns?.conformance ?? []).filter(held => held.project === project),
    },
    principles: {
      solid: [],
      anti_patterns: (index.principles?.anti_patterns ?? []).map(anti => ({
        ...anti,
        examples: (anti.examples ?? []).filter(example => held.has(example.split(' (')[0].trim())),
      })),
    },
    conformance: { conventions: [] },
    edges: (index.edges ?? []).filter(edge => held.has(edge.source) && held.has(edge.target)),
    ...factsWithin(index, held, ownFiles),
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

function catalogOf(part: TierStackSubProject): CASSystemCatalogEntry | undefined {
  const dependsOn = part.depends_on ?? [];
  if (part.owner === undefined && part.system === undefined && dependsOn.length === 0) return undefined;
  return {
    ...(part.owner === undefined ? {} : { owner: part.owner }),
    ...(part.system === undefined ? {} : { system: part.system }),
    ...(dependsOn.length === 0 ? {} : { depends_on: dependsOn }),
  };
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
    const catalog = catalogOf(part);
    if (catalog) child.system.catalog = catalog;
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
  const suites = testSuitesOf(index);
  const stable = temporalStabilityOf(index, new Set(nodes.filter(node => node.type === 'file').map(node => node.id)));
  const analysis_id = createHash('sha256')
    .update(`${index.root}:${nodes.length}:${edges.length}`)
    .digest('hex')
    .slice(0, 16);

  const exit_points = exitPointsOf(index);
  const entities = entitiesOf(index);
  const database_schema = databaseSchemaOf(entities);
  const capabilities = capabilitiesOf(index, name);
  const paradigm_conformance = conformanceOf(index);
  const analysis_facts = analysisFactsOf({ nodes, entryPoints: entry_points, exitPoints: exit_points, capabilities: capabilities ?? [] });
  const idioms = idiomsOf(paradigm_conformance);
  const invariants = invariantsOf({ conformance: paradigm_conformance, entities });

  return {
    cas_version: CAS_VERSION,
    analysis_id,
    analysis_timestamp: new Date().toISOString(),
    system: {
      id: `system:${name}`,
      name,
      type: shapeOf(index),
      root_path: index.root,
      technologies: technologiesOf(index, path.basename(index.root)),
    },
    architecture_summary: { ...architectureOf(index, nodes), architectural_patterns: patternsOf(index) },
    patterns: namedPatternsOf(index),
    paradigm_conformance,
    ...carriedSectionsOf(index),
    principle_violations: [...violationsOf(index), ...carriedLayeringViolations(index)],
    route_table: routesOf(index),
    nodes,
    edges,
    entry_points,
    exit_points,
    entities,
    ...(database_schema === undefined ? {} : { database_schema }),
    capabilities,
    deployable_evidence: deployablesOf(index),
    enhanced_system_purpose: purposeOf(index),
    flows: flowsOf(index),
    communication_seams: seamsOf(index),
    test_suites: suites,
    test_summary: testSummaryOf(suites),
    ...(stable.stability.length === 0 ? {} : { temporal_stability: stable.stability, stability_summary: stable.summary }),
    dependencies: dependenciesOf(index),
    analyzer_contributions: [contributionOf(index, nodes, edges, entry_points)],
    progressive_levels: levelsOf(nodes),
    analysis_facts,
    validation: buildGraphValidation(nodes, edges, entry_points, exit_points, [], analysis_facts),
    ...(idioms.idioms.length === 0 ? {} : {
      codebase_idioms: idioms.idioms,
      idiom_summary: idioms.summary,
      ...(idioms.violations.length === 0 ? {} : { idiom_violations: idioms.violations }),
    }),
    ...(invariants.invariants.length === 0 ? {} : {
      behavioral_invariants: invariants.invariants,
      behavioral_invariant_summary: invariants.summary,
    }),
  };
}
