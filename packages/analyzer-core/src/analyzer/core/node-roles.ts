import { CASNode, CASEdge, CASEntryPoint, CASExitPoint, CASNodeRole } from '../../types/cas.types';
import { classifyGuardKind, isAuthenticationGuardName } from './guard-classification';


































export interface NodeRolesInput {
  nodes: CASNode[];
  edges: CASEdge[];
  entry_points?: CASEntryPoint[];
  exit_points?: CASExitPoint[];
  resetDerivedRoles?: boolean;
}

const CONTAINMENT_EDGE_TYPES = new Set(['contains', 'has_method', 'declares']);





const DIRECT_TYPE_TO_ROLE: Partial<Record<string, CASNodeRole>> = {

  gateway: 'gateway',



  guard: 'guard',


  middleware: 'middleware',


  controller: 'controller',
};






const MIGRATION_NODE_TYPES = new Set(['rails_migration', 'laravel_migration']);











const ROLE_FRAMEWORK_MARKERS: Record<string, RegExp> = {
  gateway: /websocketgateway|gateway/i,
  guard: /canactivate|@?guard\b|authguard/i,
  middleware: /@?middleware\b|nestmiddleware|use\(/i,
  controller: /@?(rest)?controller\b|@resolver\b/i,
};

function collectNodeMarkers(node: CASNode): string[] {
  const out: string[] = [];
  if (node.metadata?.annotations) out.push(...node.metadata.annotations);
  const decorators = (node.metadata?.attributes as Record<string, unknown> | undefined)?.decorators;
  if (Array.isArray(decorators)) out.push(...decorators.map(String));
  if (node.tags) out.push(...node.tags);
  return out;
}

function setRole(node: CASNode, role: CASNodeRole, source: 'framework-evidence' | 'structural-evidence', evidence: string): void {




  if (node.role) return;
  node.role = role;
  node.role_source = source;
  node.role_evidence = evidence;
}



function assignFromDirectNodeTypes(nodes: CASNode[]): void {
  for (const node of nodes) {
    if (node.role) continue;

    if (MIGRATION_NODE_TYPES.has(node.type) || node.category === 'migration') {
      const attrs = node.metadata?.attributes as Record<string, unknown> | undefined;
      const table = attrs?.table;
      const action = attrs?.action;
      const opEvidence = table || action
        ? `schema-change operation (table=${String(table ?? 'unknown')}, action=${String(action ?? 'unknown')})`
        : 'schema-change node';
      setRole(node, 'migration', 'framework-evidence', `node.type=${node.type} category=migration; ${opEvidence}`);
      continue;
    }

    const direct = DIRECT_TYPE_TO_ROLE[node.type] ?? (node.category ? DIRECT_TYPE_TO_ROLE[node.category] : undefined);
    if (!direct) continue;

    const markers = collectNodeMarkers(node);
    const marker = markers.find(m => ROLE_FRAMEWORK_MARKERS[direct]?.test(m));
    if (marker) {
      setRole(node, direct, 'framework-evidence', `decorator/annotation "${marker}" on node.type=${node.type}`);
    } else {
      setRole(node, direct, 'structural-evidence', `node.type=${node.type} (framework analyzer classification, no citable decorator on this node)`);
    }
  }
}










const ENTRY_TYPE_TO_ROLE: Partial<Record<string, CASNodeRole>> = {
  schedule: 'scheduled-job',
  event: 'event-listener',
  graphql: 'resolver',
};

function resolveHandlerNodeId(ep: CASEntryPoint): string | undefined {
  return ep.handler?.node_id || ep.source_node;
}

function assignFromEntryPointTypes(nodes: CASNode[], entryPoints: CASEntryPoint[]): void {
  const byId = new Map(nodes.map(n => [n.id, n] as const));
  for (const ep of entryPoints) {
    const role = ENTRY_TYPE_TO_ROLE[ep.type];
    if (!role) continue;
    const nodeId = resolveHandlerNodeId(ep);
    const node = nodeId ? byId.get(nodeId) : undefined;
    if (!node) continue;







    if (role === 'resolver' && node.role === 'controller') {
      node.role = undefined;
      node.role_source = undefined;
      node.role_evidence = undefined;
    }
    const evidence = `entry_point ${ep.id} type=${ep.type}` + (ep.trigger?.schedule ? ` schedule="${ep.trigger.schedule}"` : ep.trigger?.event ? ` event="${ep.trigger.event}"` : '');
    setRole(node, role, 'structural-evidence', evidence);
  }
}













function assignFromGuardEvidence(nodes: CASNode[], entryPoints: CASEntryPoint[]): void {
  const byName = new Map<string, CASNode[]>();
  for (const n of nodes) {
    if (n.type !== 'function' && n.type !== 'method' && n.type !== 'class') continue;
    const list = byName.get(n.name) || [];
    list.push(n);
    byName.set(n.name, list);
  }
  const nodeById = new Map<string, CASNode>();
  for (const n of nodes) {
    if (!nodeById.has(n.id)) nodeById.set(n.id, n);
  }
  const handlerFile = new Map<string, string | undefined>();
  for (const ep of entryPoints) {
    const nodeId = resolveHandlerNodeId(ep);
    if (!nodeId) continue;
    handlerFile.set(ep.id, nodeById.get(nodeId)?.source?.file);
  }

  for (const ep of entryPoints) {
    const guardNames = ep.security?.guards;
    if (!guardNames?.length) continue;
    const epFile = handlerFile.get(ep.id);
    for (const guardName of guardNames) {
      const candidates = byName.get(guardName);
      if (!candidates?.length) continue;




      const node = candidates.find(c => c.source?.file === epFile) ?? (candidates.length === 1 ? candidates[0] : undefined);
      if (!node || node.role) continue;
      const kind = classifyGuardKind(guardName);
      const role: CASNodeRole = isAuthenticationGuardName(guardName) || kind === 'authorization' ? 'guard' : 'middleware';
      setRole(node, role, 'structural-evidence', `wraps entry_point ${ep.id} (security.guards="${guardName}", classified ${kind})`);
    }
  }
}








const MIGRATION_DIR_RE = /(^|\/)(migrations?|db\/migrate)(\/|$)/i;
const MIGRATION_FILENAME_RE = /^(v?\d{1,14}[_-].+|\d+_.+\.(sql|go|py|rb|php|js|ts))$/i;

function assignMigrationFromPathConvention(nodes: CASNode[]): void {
  for (const node of nodes) {
    if (node.role) continue;
    const file = node.source?.file;
    if (!file) continue;
    if (!MIGRATION_DIR_RE.test(file)) continue;
    const base = file.split('/').pop() || '';
    if (!MIGRATION_FILENAME_RE.test(base)) continue;
    setRole(node, 'migration', 'structural-evidence', `file path "${file}" matches migration directory+version-prefixed-filename convention`);
  }
}









const ROUTE_ENTRY_TYPES = new Set(['http', 'route', 'api', 'rpc']);
const MIN_HANDLERS_FOR_CONTROLLER = 2;

function ownerOf(nodeId: string, nodesById: Map<string, CASNode>, edges: CASEdge[]): string | undefined {
  const node = nodesById.get(nodeId);
  if (node?.parent) return node.parent;
  const candidates = edges
    .filter(edge => CONTAINMENT_EDGE_TYPES.has(edge.type) && edge.target === nodeId)
    .map(edge => nodesById.get(edge.source))
    .filter((owner): owner is CASNode => Boolean(owner))
    .sort((left, right) => {
      const fileRank = Number(left.type === 'file') - Number(right.type === 'file');
      if (fileRank !== 0) return fileRank;
      const levelRank = (right.level || 0) - (left.level || 0);
      return levelRank || left.id.localeCompare(right.id);
    });
  return candidates[0]?.id;
}

function assignControllerFromGrouping(nodes: CASNode[], edges: CASEdge[], entryPoints: CASEntryPoint[]): void {
  const nodesById = new Map(nodes.map(n => [n.id, n] as const));
  const byOwner = new Map<string, Set<string>>();
  for (const ep of entryPoints) {
    if (!ROUTE_ENTRY_TYPES.has(ep.type)) continue;
    const handlerId = resolveHandlerNodeId(ep);
    if (!handlerId) continue;
    const owner = ownerOf(handlerId, nodesById, edges);
    if (!owner || owner === handlerId) continue;
    const set = byOwner.get(owner) || new Set<string>();
    set.add(ep.id);
    byOwner.set(owner, set);
  }
  for (const [ownerId, epIds] of byOwner) {
    if (epIds.size < MIN_HANDLERS_FOR_CONTROLLER) continue;
    const owner = nodesById.get(ownerId);
    if (!owner || owner.role) continue;
    setRole(
      owner,
      'controller',
      'structural-evidence',
      `owns ${epIds.size} route/API entry points (${[...epIds].slice(0, 5).join(', ')}${epIds.size > 5 ? ', ...' : ''}) via containment — no framework/name required`,
    );
  }
}










const FORWARDING_EXIT_TYPES = new Set(['api', 'webhook']);
const OWN_WORK_EXIT_TYPES = new Set(['database', 'file', 'cache']);

function assignGatewayFromProxyShape(nodes: CASNode[], entryPoints: CASEntryPoint[], exitPoints: CASExitPoint[]): void {
  const nodesById = new Map(nodes.map(n => [n.id, n] as const));
  const inboundHandlerIds = new Set<string>();
  for (const ep of entryPoints) {
    if (!ROUTE_ENTRY_TYPES.has(ep.type)) continue;
    const id = resolveHandlerNodeId(ep);
    if (id) inboundHandlerIds.add(id);
  }
  if (!inboundHandlerIds.size) return;

  const exitsByNode = new Map<string, CASExitPoint[]>();
  for (const xp of exitPoints) {
    const list = exitsByNode.get(xp.source_node) || [];
    list.push(xp);
    exitsByNode.set(xp.source_node, list);
  }

  for (const nodeId of inboundHandlerIds) {
    const node = nodesById.get(nodeId);
    if (!node || node.role) continue;
    const exits = exitsByNode.get(nodeId) || [];
    if (!exits.length) continue;
    const forwarding = exits.filter(x => FORWARDING_EXIT_TYPES.has(x.type));
    const ownWork = exits.filter(x => OWN_WORK_EXIT_TYPES.has(x.type));
    if (!forwarding.length || ownWork.length) continue;
    setRole(
      node,
      'gateway',
      'structural-evidence',
      `inbound route handler with only forwarding exit point(s) (${forwarding.map(f => f.id).join(', ')}), no database/file/cache exit point of its own`,
    );
  }
}












export function assignNodeRoles(input: NodeRolesInput): void {
  const { nodes, edges, entry_points = [], exit_points = [], resetDerivedRoles = false } = input;
  if (!nodes.length) return;
  if (resetDerivedRoles) {
    for (const node of nodes) {
      if (!node.role_source) continue;
      node.role = undefined;
      node.role_source = undefined;
      node.role_evidence = undefined;
    }
  }
  assignFromDirectNodeTypes(nodes);
  assignFromEntryPointTypes(nodes, entry_points);
  assignFromGuardEvidence(nodes, entry_points);
  assignMigrationFromPathConvention(nodes);
  assignGatewayFromProxyShape(nodes, entry_points, exit_points);




  assignControllerFromGrouping(nodes, edges, entry_points);
}
