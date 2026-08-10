import { CASNode, CASEdge, CASEntryPoint, CASExitPoint, CASNodeRole } from '../../types/cas.types';
import { classifyGuardKind, isAuthenticationGuardName } from './guard-classification';

/**
 * Tier 2 GAP FIX (docs/SPEC-ABSTRACTION-TIERS.md, tier 2 group 2:
 * "framework-conferred node roles"): assigns the closed NODE_ROLES vocabulary
 * to CASNode.role from TIER-1 FACTS ONLY (nodes, edges, entry_points,
 * exit_points — never capabilities/flows/steps/entities, per the tier
 * dependency rule). This is the single writer of CASNode.role/role_source/
 * role_evidence.
 *
 * THE CENTRAL REQUIREMENT this file exists to satisfy: every role must be
 * reachable two ways —
 *
 *   1. framework-conferred: a real decorator/annotation/interface/base-class
 *      a framework analyzer already recorded on the node, OR an
 *      already-typed node a framework analyzer emits directly (NestJS
 *      `gateway`, Rails/Laravel `*_migration`).
 *   2. structural, with NO framework present: a wrapping position in a
 *      request chain (guard-classification.ts, already used generically
 *      across ~25 framework AND framework-less analyzers including Go
 *      net/http-family routers), a directory+filename convention
 *      (migrations), an entry-point-type fact that already exists
 *      generically (`schedule`/`event`/`graphql` — see ENTRY_POINT_TYPES),
 *      or a grouping shape (N route handlers owned by one file/class/struct
 *      — the controller shape, satisfied identically by `@Controller` and a
 *      Go file full of `http.HandleFunc` registrations).
 *
 * `route-handler` and `persisted-entity` are NOT assigned here — they
 * already have a home (CASEntryPoint['type'] and CASDataEntityKind).
 *
 * Every assignment cites the fact that produced it in `role_evidence`. No
 * assignment is made from a node's own name or casing — see the per-role
 * comments below for exactly which fact is read.
 */

export interface NodeRolesInput {
  nodes: CASNode[];
  edges: CASEdge[];
  entry_points?: CASEntryPoint[];
  exit_points?: CASExitPoint[];
}

const CONTAINMENT_EDGE_TYPES = new Set(['contains', 'has_method', 'declares']);

/** Node.type/category values framework analyzers already emit directly for a
 *  role — see the sites cited inline. Reusing them (rather than re-deriving
 *  from scratch) avoids a second implementation of the same fact and keeps
 *  this pass additive over what analyzers already know. */
const DIRECT_TYPE_TO_ROLE: Partial<Record<string, CASNodeRole>> = {
  // NestJS @WebSocketGateway — frameworks/web/nestjs-analyzer.ts.
  gateway: 'gateway',
  // NestJS CanActivate-implementing / @Injectable *Guard classes, and the
  // TypeScript/JS class-type classifier's own 'guard' determination —
  // languages/typescript-javascript-analyzer.ts determineClassType.
  guard: 'guard',
  // Express registered middleware, NestJS middleware — frameworks/web/
  // express-analyzer.ts, typescript-javascript-analyzer.ts.
  middleware: 'middleware',
  // Spring @Controller/@RestController, Express controller grouping, NestJS
  // @Controller, Angular routed component controllers, etc.
  controller: 'controller',
};

/** node.type values that are themselves the citable framework evidence (the
 *  analyzer that produced them already required a real convention to fire —
 *  see the migration node-creation sites in rails-analyzer.ts /
 *  laravel-analyzer.ts, both gated on a real ORM migration file, never a
 *  bare directory listing). */
const MIGRATION_NODE_TYPES = new Set(['rails_migration', 'laravel_migration']);

/** Decorator/annotation/interface names that, when present on a node, are
 *  citable framework evidence for the DIRECT_TYPE_TO_ROLE assignment above.
 *  Kept intentionally narrow: real ecosystem identifiers (a decorator, an
 *  interface name), not a business-vocabulary list. Absence of a match here
 *  does not block the role — it only changes role_source from
 *  framework-evidence to structural-evidence (the node.type itself still
 *  came from a real analyzer, just one that fell through to a path/suffix
 *  rule for this particular node — see typescript-javascript-analyzer.ts
 *  determineClassType).
 */
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
  // First cited fact wins — do not let a later, weaker rule overwrite an
  // already-cited role for the same node (e.g. a node already assigned
  // `resolver` from a real GraphQL entry point must not be downgraded back
  // to the generic `controller` tag a framework analyzer also left on it).
  if (node.role) return;
  node.role = role;
  node.role_source = source;
  node.role_evidence = evidence;
}

/** Rule 1 — direct framework-analyzer node types (controller/guard/
 *  middleware/gateway already-typed nodes, migration-typed nodes). */
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

/** Rule 2 — entry-point-type facts that are ALREADY framework-agnostic tier-1
 *  facts (ENTRY_POINT_TYPES 'schedule' / 'event' / 'graphql' — the cron
 *  analyzer, messaging analyzer, and GraphQL entry-point emitters all fire
 *  identically whether or not the surrounding code uses a "framework"). The
 *  handler node of such an entry point IS structurally that role — no
 *  framework check needed because the entry-point type itself already
 *  encodes the structural registration shape (a timer/cron registration, an
 *  event-subscription registration, a schema-backed dispatch).
 */
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
    // A resolver overriding a prior generic 'controller' tag is the one
    // deliberate exception to setRole's first-wins rule: some framework
    // analyzers (e.g. a `@Resolver()` class) fold GraphQL resolvers into the
    // same 'controller' node.type as REST controllers, which is exactly the
    // ambiguity a closed vocabulary exists to remove. The entry point's own
    // type ('graphql') is a stronger, more specific fact than the coarse
    // node.type it was tagged with, so it wins here specifically.
    if (role === 'resolver' && node.role === 'controller') {
      node.role = undefined;
      node.role_source = undefined;
      node.role_evidence = undefined;
    }
    const evidence = `entry_point ${ep.id} type=${ep.type}` + (ep.trigger?.schedule ? ` schedule="${ep.trigger.schedule}"` : ep.trigger?.event ? ` event="${ep.trigger.event}"` : '');
    setRole(node, role, 'structural-evidence', evidence);
  }
}

/** Rule 3 — guard/middleware from wrapping-chain evidence
 *  (CASEntryPoint.security.guards, already populated by ~25 framework AND
 *  framework-less analyzers — see guard-classification.ts's import sites,
 *  which include Go's net/http-family routers alongside Express/NestJS/
 *  Spring/etc). classifyGuardKind is itself already-existing, already
 *  cross-ecosystem infrastructure (not a new vocabulary table introduced by
 *  this pass) that reads what the wrapper NAME structurally indicates it
 *  protects. A guard name resolved to a same-file node becomes `guard` when
 *  its classified purpose is authentication/authorization, else `middleware`
 *  (rate-limiting/validation/unknown wrapping — still a request-chain
 *  wrapping position, just not an access-control one).
 */
function assignFromGuardEvidence(nodes: CASNode[], entryPoints: CASEntryPoint[]): void {
  const byName = new Map<string, CASNode[]>();
  for (const n of nodes) {
    if (n.type !== 'function' && n.type !== 'method' && n.type !== 'class') continue;
    const list = byName.get(n.name) || [];
    list.push(n);
    byName.set(n.name, list);
  }
  const handlerFile = new Map<string, string | undefined>();
  for (const ep of entryPoints) {
    const nodeId = resolveHandlerNodeId(ep);
    if (!nodeId) continue;
    const node = nodes.find(n => n.id === nodeId);
    handlerFile.set(ep.id, node?.source?.file);
  }

  for (const ep of entryPoints) {
    const guardNames = ep.security?.guards;
    if (!guardNames?.length) continue;
    const epFile = handlerFile.get(ep.id);
    for (const guardName of guardNames) {
      const candidates = byName.get(guardName);
      if (!candidates?.length) continue;
      // Prefer a candidate declared in the same file as the handler (the
      // common case: an auth middleware/guard function local to that
      // router file); fall back to the sole candidate if there is exactly
      // one in the whole graph.
      const node = candidates.find(c => c.source?.file === epFile) ?? (candidates.length === 1 ? candidates[0] : undefined);
      if (!node || node.role) continue;
      const kind = classifyGuardKind(guardName);
      const role: CASNodeRole = isAuthenticationGuardName(guardName) || kind === 'authorization' ? 'guard' : 'middleware';
      setRole(node, role, 'structural-evidence', `wraps entry_point ${ep.id} (security.guards="${guardName}", classified ${kind})`);
    }
  }
}

/** Rule 4 — migration, framework-less path: directory convention (a
 *  `migrations`/`migrate`-shaped path — an ecosystem-standard artifact
 *  location used by golang-migrate, Flyway, dbmate, Prisma, TypeORM, Knex,
 *  Rails, Laravel, Django alike, not a single framework's brand) PLUS a
 *  version-prefixed filename (the operation-ordering convention every one of
 *  those tools shares) — never directory alone, and never a business word.
 */
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

/** Rule 5 — controller, framework-less path: a class/struct/file that owns
 *  (via a `contains` edge, or `node.parent`) two or more distinct entry
 *  points whose type is a route/API kind. This is the literal structural
 *  shape a `@Controller` class and a Go file full of `http.HandleFunc`
 *  registrations both satisfy — see docs/SPEC-ABSTRACTION-TIERS.md's own
 *  framing: "`@Controller` and Go's `http.HandleFunc` must resolve to the
 *  same role." No name is read; only the grouping shape.
 */
const ROUTE_ENTRY_TYPES = new Set(['http', 'route', 'api', 'rpc']);
const MIN_HANDLERS_FOR_CONTROLLER = 2;

function ownerOf(nodeId: string, nodesById: Map<string, CASNode>, edges: CASEdge[]): string | undefined {
  const node = nodesById.get(nodeId);
  if (node?.parent) return node.parent;
  const containing = edges.find(e => CONTAINMENT_EDGE_TYPES.has(e.type) && e.target === nodeId);
  return containing?.source;
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

/** Rule 6 — gateway, framework-less path: a node that is itself the handler
 *  of an inbound route/API entry point, emits an outbound `api`/`webhook`
 *  exit point of its own, and emits NO `database`/`file`/`cache` exit point
 *  — i.e. it forwards rather than does business/storage work. That is the
 *  structural shape of a gateway (receive-and-forward) regardless of
 *  whether the code is a NestJS `@WebSocketGateway`, a hand-rolled Go
 *  reverse-proxy handler, or a plain Express route that only calls another
 *  service and returns its response.
 */
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

/**
 * Runs all role-assignment rules over a tier-1 CASOutput slice (nodes, edges,
 * entry_points, exit_points ONLY — see NodeRolesInput). Mutates `nodes` in
 * place, additive to whatever tier-1/framework analyzers already recorded.
 * Order matters: direct framework-analyzer types first (cheapest, most
 * specific), then entry-point-type facts (may override a coarse
 * 'controller'->'resolver' mistag), then guard/middleware wrapping evidence,
 * then the two framework-less structural fallbacks (migration path
 * convention, controller grouping) last, so a framework signal always wins
 * over a bare structural one when both are present on the same node.
 */
export function assignNodeRoles(input: NodeRolesInput): void {
  const { nodes, edges, entry_points = [], exit_points = [] } = input;
  if (!nodes.length) return;
  assignFromDirectNodeTypes(nodes);
  assignFromEntryPointTypes(nodes, entry_points);
  assignFromGuardEvidence(nodes, entry_points);
  assignMigrationFromPathConvention(nodes);
  assignGatewayFromProxyShape(nodes, entry_points, exit_points);
  // Controller grouping runs LAST: it only claims a node with no role yet,
  // and a node that turned out to be a gateway (forwards) or guard/
  // middleware (wraps) must not also be swept into 'controller' by the
  // grouping fallback.
  assignControllerFromGrouping(nodes, edges, entry_points);
}
