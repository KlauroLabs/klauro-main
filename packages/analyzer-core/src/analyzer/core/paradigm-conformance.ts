import {
  CASNode,
  CASEdge,
  CASEntryPoint,
  CASExitPoint,
  CASParadigmConformance,
  CASParadigmDeviation
} from '../../types/cas.types';

export interface ParadigmConformanceInput {
  nodes: CASNode[];
  edges: CASEdge[];
  entryPoints: CASEntryPoint[];
  exitPoints: CASExitPoint[];
}

const NORM_THRESHOLD = 0.7;
const MIN_COMPARABLE = 4;
const MIN_FOLLOWING = 3;
const MIN_COMPARABLE_ENTITIES = 3;
const MAX_EVIDENCE_FILES = 5;

const CALL_EDGE_TYPES = new Set(['calls', 'invokes', 'executes', 'uses', 'depends_on', 'injects', 'queries']);
const WRITE_EDGE_TYPES = new Set(['writes', 'creates', 'updates', 'deletes', 'persists', 'saves', 'mutates']);
const CONTAINMENT_EDGE_TYPES = new Set(['contains', 'has_method', 'declares']);
const GUARD_EDGE_TYPES = new Set(['guarded_by', 'protected_by', 'guards', 'authorizes', 'middleware', 'intercepts', 'before_action']);

const ENTRY_LAYER_TYPE = /(^|[_\s])(controller|gateway|resolver|handler|api_route|endpoint)([_\s]|$)/;
const SERVICE_LAYER_TYPE = /(^|[_\s])(service|use_case|usecase|interactor|application_service|workflow)([_\s]|$)/;
const REPOSITORY_LAYER_TYPE = /(^|[_\s])(repository|repo|dao|data_mapper)([_\s]|$)/;
const ENTITY_TYPE = /(^|[_\s])(entity|model)([_\s]|$)/;

const ENTRY_LAYER_NAME = /(Controller|Resolver|Gateway)$/;
const SERVICE_LAYER_NAME = /(Service|UseCase|Interactor)$/;
const REPOSITORY_LAYER_NAME = /(Repository|Repo|DAO|Dao)$/;

const PUBLIC_ENTRY_PATTERN = /(login|logout|sign[-_]?in|sign[-_]?up|register|auth|session|health|status|ping|version|metrics|public|webhook|callback|forgot|reset[-_]?password|confirm|verify|docs|swagger|openapi)/i;

const GENERIC_LEAF_DIRS = new Set([
  'entities', 'entity', 'models', 'model', 'repositories', 'repository',
  'controllers', 'controller', 'services', 'service', 'dto', 'dtos',
  'schemas', 'schema', 'db', 'database', 'domain', 'data', 'lib', 'src', 'app'
]);

function nodeFile(node: CASNode | undefined): string | undefined {
  return node?.source?.file;
}

function isEntryLayer(node: CASNode): boolean {
  return ENTRY_LAYER_TYPE.test(node.type) || ENTRY_LAYER_NAME.test(node.name);
}

function isServiceLayer(node: CASNode): boolean {
  if (ENTRY_LAYER_TYPE.test(node.type) || ENTRY_LAYER_NAME.test(node.name)) return false;
  return SERVICE_LAYER_TYPE.test(node.type) || SERVICE_LAYER_NAME.test(node.name);
}

function isRepositoryLayer(node: CASNode): boolean {
  return REPOSITORY_LAYER_TYPE.test(node.type) || REPOSITORY_LAYER_NAME.test(node.name);
}

function isEntityNode(node: CASNode): boolean {
  return ENTITY_TYPE.test(node.type);
}

function moduleOf(file: string): string {
  const segments = file.split('/').filter(Boolean);
  segments.pop();
  while (segments.length > 1 && GENERIC_LEAF_DIRS.has(segments[segments.length - 1].toLowerCase())) {
    segments.pop();
  }
  return segments.join('/');
}

interface GraphIndex {
  nodesById: Map<string, CASNode>;
  callTargetsBySource: Map<string, string[]>;
  writeTargetsBySource: Map<string, string[]>;
  containedBySource: Map<string, string[]>;
  ownerByChild: Map<string, string>;
  guardedNodeIds: Set<string>;
  dbExitsBySource: Map<string, CASExitPoint[]>;
}

function buildIndex(input: ParadigmConformanceInput): GraphIndex {
  const nodesById = new Map<string, CASNode>();
  for (const node of input.nodes) nodesById.set(node.id, node);

  const callTargetsBySource = new Map<string, string[]>();
  const writeTargetsBySource = new Map<string, string[]>();
  const containedBySource = new Map<string, string[]>();
  const ownerByChild = new Map<string, string>();
  const guardedNodeIds = new Set<string>();

  for (const edge of input.edges) {
    if (CALL_EDGE_TYPES.has(edge.type)) {
      const list = callTargetsBySource.get(edge.source) || [];
      list.push(edge.target);
      callTargetsBySource.set(edge.source, list);
    }
    if (WRITE_EDGE_TYPES.has(edge.type)) {
      const list = writeTargetsBySource.get(edge.source) || [];
      list.push(edge.target);
      writeTargetsBySource.set(edge.source, list);
    }
    if (CONTAINMENT_EDGE_TYPES.has(edge.type)) {
      const list = containedBySource.get(edge.source) || [];
      list.push(edge.target);
      containedBySource.set(edge.source, list);
      if (!ownerByChild.has(edge.target)) ownerByChild.set(edge.target, edge.source);
    }
    if (GUARD_EDGE_TYPES.has(edge.type)) {
      guardedNodeIds.add(edge.source);
    }
  }

  const dbExitsBySource = new Map<string, CASExitPoint[]>();
  for (const exit of input.exitPoints) {
    if (exit.type !== 'database') continue;
    const list = dbExitsBySource.get(exit.source_node) || [];
    list.push(exit);
    dbExitsBySource.set(exit.source_node, list);
  }

  return { nodesById, callTargetsBySource, writeTargetsBySource, containedBySource, ownerByChild, guardedNodeIds, dbExitsBySource };
}

function memberScope(nodeId: string, index: GraphIndex): string[] {
  const scope = [nodeId];
  const contained = index.containedBySource.get(nodeId) || [];
  for (const childId of contained) scope.push(childId);
  return scope;
}

interface EntryDataProfile {
  node: CASNode;
  callsService: boolean;
  repoCallTargets: CASNode[];
  directDbExits: CASExitPoint[];
  directEntityWrites: CASNode[];
}

function profileEntryNode(node: CASNode, index: GraphIndex): EntryDataProfile {
  const scope = memberScope(node.id, index);
  let callsService = false;
  const repoCallTargets: CASNode[] = [];
  const directDbExits: CASExitPoint[] = [];
  const directEntityWrites: CASNode[] = [];
  const seenRepos = new Set<string>();
  const seenEntities = new Set<string>();

  for (const memberId of scope) {
    for (const exit of index.dbExitsBySource.get(memberId) || []) {
      directDbExits.push(exit);
    }
    for (const targetId of index.callTargetsBySource.get(memberId) || []) {
      const target = index.nodesById.get(targetId);
      if (!target) continue;
      const resolvedOwnerId = index.ownerByChild.get(targetId);
      const owner = resolvedOwnerId ? index.nodesById.get(resolvedOwnerId) : undefined;
      if (isServiceLayer(target) || (owner && isServiceLayer(owner))) {
        callsService = true;
      }
      const repoNode = isRepositoryLayer(target) ? target : owner && isRepositoryLayer(owner) ? owner : undefined;
      if (repoNode && !seenRepos.has(repoNode.id)) {
        seenRepos.add(repoNode.id);
        repoCallTargets.push(repoNode);
      }
    }
    for (const targetId of index.writeTargetsBySource.get(memberId) || []) {
      const target = index.nodesById.get(targetId);
      if (target && isEntityNode(target) && !seenEntities.has(target.id)) {
        seenEntities.add(target.id);
        directEntityWrites.push(target);
      }
    }
  }

  return { node, callsService, repoCallTargets, directDbExits, directEntityWrites };
}

function evidenceFiles(nodes: CASNode[]): string[] {
  const files: string[] = [];
  for (const node of nodes) {
    const file = nodeFile(node);
    if (file && !files.includes(file)) files.push(file);
    if (files.length >= MAX_EVIDENCE_FILES) break;
  }
  return files;
}

function normHolds(followingCount: number, comparableCount: number, minComparable = MIN_COMPARABLE): boolean {
  return (
    comparableCount >= minComparable &&
    followingCount >= MIN_FOLLOWING &&
    followingCount / comparableCount >= NORM_THRESHOLD
  );
}

function detectServiceMediatedDataAccess(profiles: EntryDataProfile[]): CASParadigmConformance | undefined {
  const comparable = profiles.filter(
    profile => profile.callsService || profile.directDbExits.length > 0 || profile.directEntityWrites.length > 0
  );
  const followers = comparable.filter(
    profile => profile.callsService && profile.directDbExits.length === 0 && profile.directEntityWrites.length === 0
  );
  const deviants = comparable.filter(
    profile => profile.directDbExits.length > 0 || profile.directEntityWrites.length > 0
  );
  if (!normHolds(followers.length, comparable.length)) return undefined;

  const deviations: CASParadigmDeviation[] = deviants.map(profile => {
    const evidence: string[] = [];
    for (const exit of profile.directDbExits.slice(0, 2)) evidence.push(`database exit: ${exit.name}`);
    for (const entity of profile.directEntityWrites.slice(0, 2)) evidence.push(`writes entity ${entity.name}`);
    return {
      file: nodeFile(profile.node) || '',
      node_id: profile.node.id,
      kind: 'direct-data-access',
      detail: `${profile.node.name} accesses data directly (${evidence.join('; ')}) while ${followers.length} of ${comparable.length} comparable entry handlers delegate through the service layer`,
      severity: 'warning',
    };
  });

  return {
    paradigm: 'service-mediated-data-access',
    description: 'Entry-layer handlers delegate data access to the service layer instead of touching the database or entities directly',
    adoption: {
      following_count: followers.length,
      comparable_count: comparable.length,
      adoption_rate: Number((followers.length / comparable.length).toFixed(2)),
      evidence_files: evidenceFiles(followers.map(profile => profile.node)),
    },
    deviations,
  };
}

function detectServiceLayerHop(profiles: EntryDataProfile[]): CASParadigmConformance | undefined {
  const comparable = profiles.filter(profile => profile.callsService || profile.repoCallTargets.length > 0);
  const followers = comparable.filter(profile => profile.callsService && profile.repoCallTargets.length === 0);
  const deviants = comparable.filter(profile => profile.repoCallTargets.length > 0);
  if (!normHolds(followers.length, comparable.length)) return undefined;

  const deviations: CASParadigmDeviation[] = deviants.map(profile => {
    const repoNames = profile.repoCallTargets.slice(0, 3).map(repo => repo.name).join(', ');
    return {
      file: nodeFile(profile.node) || '',
      node_id: profile.node.id,
      kind: 'layer-skipping-call',
      detail: `${profile.node.name} calls ${repoNames} directly, skipping the service layer used by ${followers.length} of ${comparable.length} comparable entry handlers`,
      severity: 'warning',
    };
  });

  return {
    paradigm: 'entry-service-repository-layering',
    description: 'Entry-layer handlers reach repositories through a service-layer hop rather than calling repositories directly',
    adoption: {
      following_count: followers.length,
      comparable_count: comparable.length,
      adoption_rate: Number((followers.length / comparable.length).toFixed(2)),
      evidence_files: evidenceFiles(followers.map(profile => profile.node)),
    },
    deviations,
  };
}

function entryIsGuarded(entry: CASEntryPoint, index: GraphIndex): boolean {
  const security = entry.security;
  if (security) {
    if (security.authenticated) return true;
    if (security.guards && security.guards.length > 0) return true;
    if (security.roles && security.roles.length > 0) return true;
    if (security.authorized_roles && security.authorized_roles.length > 0) return true;
    if (security.permissions && security.permissions.length > 0) return true;
  }
  const guardCarriers = [entry.source_node, entry.handler?.node_id].filter(Boolean) as string[];
  for (const nodeId of guardCarriers) {
    if (index.guardedNodeIds.has(nodeId)) return true;
    const ownerId = index.ownerByChild.get(nodeId);
    if (ownerId && index.guardedNodeIds.has(ownerId)) return true;
  }
  return false;
}

function detectGuardedEntries(entryPoints: CASEntryPoint[], index: GraphIndex): CASParadigmConformance | undefined {
  const comparable = entryPoints.filter(entry => {
    if (entry.type !== 'http' && entry.type !== 'route') return false;
    const surface = `${entry.name} ${entry.trigger?.path || ''}`;
    return !PUBLIC_ENTRY_PATTERN.test(surface);
  });
  const followers = comparable.filter(entry => entryIsGuarded(entry, index));
  const deviants = comparable.filter(entry => !entryIsGuarded(entry, index));
  if (!normHolds(followers.length, comparable.length)) return undefined;

  const deviations: CASParadigmDeviation[] = deviants.map(entry => {
    const node = index.nodesById.get(entry.source_node);
    const file = entry.handler?.file || nodeFile(node) || '';
    return {
      file,
      node_id: entry.handler?.node_id || entry.source_node,
      kind: 'unguarded-entry-point',
      detail: `${entry.name} has no authentication guard while ${followers.length} of ${comparable.length} comparable HTTP entry points are guarded`,
      severity: 'error',
    };
  });

  const followerNodes = followers
    .map(entry => index.nodesById.get(entry.source_node))
    .filter((node): node is CASNode => Boolean(node));

  return {
    paradigm: 'guarded-http-entry-points',
    description: 'HTTP entry points are protected by authentication or authorization guards',
    adoption: {
      following_count: followers.length,
      comparable_count: comparable.length,
      adoption_rate: Number((followers.length / comparable.length).toFixed(2)),
      evidence_files: evidenceFiles(followerNodes),
    },
    deviations,
  };
}

function detectSingleOwnerEntityWrites(input: ParadigmConformanceInput, index: GraphIndex): CASParadigmConformance | undefined {
  const writersByEntity = new Map<string, CASNode[]>();
  for (const edge of input.edges) {
    if (!WRITE_EDGE_TYPES.has(edge.type)) continue;
    const target = index.nodesById.get(edge.target);
    const source = index.nodesById.get(edge.source);
    if (!target || !source || !isEntityNode(target)) continue;
    const sourceFile = nodeFile(source);
    if (!sourceFile || !nodeFile(target)) continue;
    const list = writersByEntity.get(target.id) || [];
    if (!list.some(existing => existing.id === source.id)) list.push(source);
    writersByEntity.set(target.id, list);
  }

  interface EntityOwnership {
    entity: CASNode;
    ownerModule: string;
    outsideWriters: CASNode[];
  }

  const comparable: EntityOwnership[] = [];
  for (const [entityId, writers] of writersByEntity) {
    const entity = index.nodesById.get(entityId);
    if (!entity) continue;
    const ownerModule = moduleOf(nodeFile(entity)!);
    const outsideWriters = writers.filter(writer => {
      const writerModule = moduleOf(nodeFile(writer)!);
      return writerModule !== ownerModule && !writerModule.startsWith(`${ownerModule}/`) && !ownerModule.startsWith(`${writerModule}/`);
    });
    comparable.push({ entity, ownerModule, outsideWriters });
  }

  const followers = comparable.filter(item => item.outsideWriters.length === 0);
  const deviants = comparable.filter(item => item.outsideWriters.length > 0);
  if (comparable.length < MIN_COMPARABLE_ENTITIES) return undefined;
  if (followers.length < MIN_FOLLOWING || followers.length / comparable.length < NORM_THRESHOLD) return undefined;

  const deviations: CASParadigmDeviation[] = [];
  for (const item of deviants) {
    for (const writer of item.outsideWriters) {
      deviations.push({
        file: nodeFile(writer) || '',
        node_id: writer.id,
        kind: 'parallel-implementation',
        detail: `${writer.name} writes entity ${item.entity.name} from outside its owner module (${item.ownerModule}) while ${followers.length} of ${comparable.length} entities are written only by their own module`,
        severity: 'warning',
      });
    }
  }

  return {
    paradigm: 'single-owner-entity-writes',
    description: 'Each data entity is written only from code within its owner module',
    adoption: {
      following_count: followers.length,
      comparable_count: comparable.length,
      adoption_rate: Number((followers.length / comparable.length).toFixed(2)),
      evidence_files: evidenceFiles(followers.map(item => item.entity)),
    },
    deviations,
  };
}

export function buildParadigmConformance(input: ParadigmConformanceInput): CASParadigmConformance[] {
  const index = buildIndex(input);
  const entryNodes = input.nodes.filter(isEntryLayer);
  const profiles = entryNodes.map(node => profileEntryNode(node, index));

  const paradigms: CASParadigmConformance[] = [];
  const serviceMediated = detectServiceMediatedDataAccess(profiles);
  if (serviceMediated) paradigms.push(serviceMediated);
  const layerHop = detectServiceLayerHop(profiles);
  if (layerHop) paradigms.push(layerHop);
  const guarded = detectGuardedEntries(input.entryPoints, index);
  if (guarded) paradigms.push(guarded);
  const singleOwner = detectSingleOwnerEntityWrites(input, index);
  if (singleOwner) paradigms.push(singleOwner);

  return paradigms;
}
