import type {
  CASOutput,
  CASNode,
  CASEdge,
  CASEntryPoint,
  CASExitPoint,
  CASExternalService,
  CASDataEntity,
  DeployableEvidence,
} from '../../types/cas.types';

/**
 * INFRA -> CODE TOPOLOGY LINKER — the enrichment pass that turns disjoint
 * infra-as-code facts (Terraform resources, Helm/raw-k8s workloads, Compose
 * services, Dockerfiles, CloudFormation) into a coherent RUNTIME topology
 * joined to the code they actually ship and serve, so get_product_map /
 * get_system_overview / deployable detection describe the RUNNING system, not
 * just the source tree.
 *
 * It runs AFTER infra + code analysis, over the already-assembled CASOutput
 * (nodes/edges/entry_points/exit_points/external_services/deployable_evidence),
 * and emits ADDITIVE edges (and a handful of additive resource-usage nodes)
 * only — it never mutates or removes existing facts. It joins GENERICALLY by
 * resource TYPE + join-key metadata (deployment_service_name / service_aliases
 * / ports / images / build path / terraform_type + terraform_name), so it
 * consumes whatever infra nodes exist — terraform, helm-emitted
 * kubernetes_<kind>, compose, and the CloudFormation / raw-k8s / Dockerfile
 * nodes peer analyzers add using the SAME vocabulary — with no hardcoding to
 * one source.
 *
 * EVIDENCE-GATED (the cardinal rule): every edge is asserted only when a
 * concrete identifier joins — a build-context path that equals a deployable
 * root, a Service targetPort that equals a container/deployable port, a queue
 * label that equals a code-referenced channel name. A resource that matches
 * nothing produces NO edge; nothing is fabricated. The linkage that fires is
 * recorded on edge.metadata.join_key so the join is verifiable, not a guess.
 *
 * Deliberately NOT AI — deterministic name/port/path joins over already-
 * produced deterministic facts, mirroring conventions-applier.ts /
 * codebase-type.ts (additive, non-blocking, pure).
 */

/** Edge types this pass introduces (all uppercased like sibling runtime edges). */
export type InfraTopologyEdgeType =
  | 'DEPLOYS'            // container image / build context -> the deployable it ships
  | 'EXPOSES'           // k8s Service / Ingress / compose port -> the deployable/port it fronts
  | 'ROUTES_TO'         // Service/Ingress -> a matching HTTP entry point (route) on that port
  | 'PROVISIONS_CHANNEL' // cloud queue/topic resource -> the messaging channel the code uses
  | 'PROVISIONS_DATABASE' // cloud db resource -> the database/data entity the code uses
  | 'PROVISIONS_STORAGE'  // cloud bucket/table/function resource -> the external/storage service the code references
  | 'RUNTIME_DEPENDS_ON'  // compose depends_on / k8s owner ref resolved to a peer deployable
  | 'PROXIES_TO';         // reverse-proxy route (Caddy/Nginx/…) -> the service/deployable its upstream fronts

export interface InfraTopologyLinkResult {
  /** Additive edges to append to output.edges. */
  edges: CASEdge[];
  /** Additive nodes to append to output.nodes (resource-usage join anchors). */
  nodes: CASNode[];
  /** Audit trail: what joined and what did not, so links are verifiable. */
  joins: InfraJoinReport[];
}

export interface InfraJoinReport {
  edge_type: InfraTopologyEdgeType;
  summary: string;
  join_key: string;
  matched: boolean;
  source_node?: string;
  target_node?: string;
}

/** Infra surfaces this linker recognizes on node.metadata.topology_surface. */
const INFRA_SURFACES = new Set([
  'terraform',
  'kubernetes',
  'docker-compose',
  'dockerfile',
  'cloudformation',
  'reverse-proxy',
]);

interface NormalizedResource {
  node: CASNode;
  surface: string;
  /** Cloud resource TYPE, normalized to a lowercase token: 'aws_sqs_queue',
   *  'aws::sqs::queue' -> 'aws_sqs_queue', 'kubernetes_service' etc. */
  resourceType: string;
  /** Every identifier this resource can join ON: its declared name, terraform
   *  label, k8s name, service aliases, compose service name. */
  names: string[];
  ports: string[];
  images: string[];
  /** Build context path (Dockerfile dir / compose build) when present. */
  buildPath?: string;
  dependsOn: string[];
}

let seq = 0;
function nextId(prefix: string): string {
  seq += 1;
  return `${prefix}_infra_link_${seq}`;
}

/** Lowercase, strip cloud punctuation so 'AWS::SQS::Queue' and 'aws_sqs_queue'
 *  compare equal — the join is by resource CATEGORY, not source dialect. */
function normalizeResourceType(raw: string | undefined): string {
  return String(raw || '').toLowerCase().replace(/::/g, '_').replace(/[^a-z0-9_]/g, '_');
}

/** Canonical join token: lowercase, collapse separators, drop a trailing
 *  environment/suffix noise word so 'orders-queue', 'orders_queue', 'ordersQueue'
 *  and a resource labelled 'orders' all reduce to a comparable base. */
function joinToken(value: string | undefined): string {
  return String(value || '')
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Suffixes a code-side channel/table often carries that the infra label omits
 *  (and vice-versa) — stripped only for the comparison, never from display. */
const JOIN_NOISE_SUFFIXES = ['-queue', '-topic', '-channel', '-table', '-bucket', '-db', '-database', '-store', '-dlq', '-fifo'];

function joinTokenSet(value: string | undefined): Set<string> {
  const base = joinToken(value);
  const out = new Set<string>();
  if (!base) return out;
  out.add(base);
  for (const suffix of JOIN_NOISE_SUFFIXES) {
    if (base.endsWith(suffix)) out.add(base.slice(0, -suffix.length));
  }
  return out;
}

/** Two identifiers join when their noise-stripped token sets intersect on a
 *  NON-empty, non-trivially-short token (guards against '' or single-char
 *  matches producing spurious links). */
function identifiersJoin(a: string | undefined, b: string | undefined): string | undefined {
  const setA = joinTokenSet(a);
  const setB = joinTokenSet(b);
  for (const token of setA) {
    if (token.length >= 3 && setB.has(token)) return token;
  }
  return undefined;
}

/** De-duplicate while keeping first-seen order — so the strongest evidence
 *  (a real declared name) stays ahead of weaker fallbacks (the label). */
function dedupePreserveOrder(values: string[]): string[] {
  return Array.from(new Set(values));
}

function toArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(v => String(v)).filter(Boolean);
  if (value === undefined || value === null) return [];
  return [String(value)].filter(Boolean);
}

/** Pull the port number out of a compose port mapping ({container}) or a raw
 *  k8s/terraform port string. */
function portNumber(value: unknown): string | undefined {
  if (value && typeof value === 'object' && 'container' in (value as any)) {
    return portNumber((value as any).container);
  }
  const digits = String(value ?? '').match(/\d{2,5}/)?.[0];
  return digits || undefined;
}

/** Normalize any infra resource node to a comparable shape, or null if the
 *  node is not an infra topology node. */
function normalizeResource(node: CASNode): NormalizedResource | null {
  const meta = (node.metadata || {}) as any;
  const attrs = (meta.attributes || {}) as any;
  const surface = meta.topology_surface;
  const isInfraType =
    typeof node.type === 'string' &&
    (node.type.startsWith('kubernetes_') ||
      node.type.startsWith('infrastructure_') ||
      node.type === 'container_image_definition' ||
      node.type === 'compose_service' ||
      node.type === 'proxy_route' ||
      node.type === 'proxy_upstream' ||
      node.type.startsWith('cloudformation_'));
  if (!INFRA_SURFACES.has(surface) && !isInfraType) return null;

  const resourceType = normalizeResourceType(
    attrs.terraform_type ||
      attrs.cloudformation_type ||
      attrs.resource_type ||
      meta.kubernetes_kind ||
      node.type,
  );

  // Order matters: a resource's REAL declared identifier (the `name = "..."`,
  // `queue_name`, `bucket`, `table_name`, `identifier`, `function_name`,
  // `repository` captured off the HCL body) is stronger evidence than the
  // terraform LABEL — so real attribute names come FIRST and the label/address
  // are appended only as a fallback. `identifiersJoin` still gates every join,
  // so the label is used only when no real-name join fires.
  const names = dedupePreserveOrder(
    [
      // Real declared identifiers first (attribute-name join).
      attrs.name,
      attrs.queue_name,
      attrs.bucket,
      attrs.table_name,
      attrs.identifier,
      attrs.db_name,
      attrs.function_name,
      attrs.repository,
      // Deployment / k8s / compose identifiers.
      meta.deployment_service_name,
      ...toArray(meta.service_aliases),
      ...toArray(attrs.service_aliases),
      // Label fallbacks last.
      attrs.terraform_name,
      attrs.terraform_address,
      node.name,
    ]
      .filter(Boolean)
      .map(String),
  );

  const ports = Array.from(
    new Set(
      [...toArray(meta.ports), ...toArray(attrs.ports), ...toArray(attrs.exposed_ports)]
        .map(p => portNumber(p))
        .filter((p): p is string => Boolean(p)),
    ),
  );

  const images = Array.from(new Set([...toArray(meta.images), ...toArray(attrs.images), meta.image, attrs.image].filter(Boolean).map(String)));
  const buildPath = attrs.build || meta.build || (node.type === 'container_image_definition' ? dirOf(node.source?.file) : undefined);
  const dependsOn = Array.from(new Set([...toArray(meta.depends_on), ...toArray(attrs.depends_on)].map(String)));

  return { node, surface: surface || 'infra', resourceType, names, ports, images, buildPath, dependsOn };
}

function dirOf(file: string | undefined): string | undefined {
  if (!file) return undefined;
  const idx = file.replace(/\\/g, '/').lastIndexOf('/');
  return idx > 0 ? file.slice(0, idx) : '.';
}

function edge(
  type: InfraTopologyEdgeType,
  source: string,
  target: string,
  joinKey: string,
  extra: Record<string, unknown> = {},
): CASEdge {
  return {
    id: nextId(`edge_${type.toLowerCase()}`),
    source,
    target,
    type,
    category: 'runtime',
    metadata: {
      confidence: 0.9,
      attributes: { topology_link: true, join_key: joinKey, ...extra },
    },
  };
}

/**
 * Link infra resources to the code they ship / expose / provision. Pure and
 * evidence-gated: returns only additive edges/nodes plus a join report; the
 * caller merges them into the CASOutput.
 */
export function linkInfraTopology(output: Pick<CASOutput, 'nodes' | 'entry_points' | 'exit_points' | 'external_services' | 'data_entities' | 'deployable_evidence'>): InfraTopologyLinkResult {
  const result: InfraTopologyLinkResult = { edges: [], nodes: [], joins: [] };
  seq = 0;

  const nodes = output.nodes || [];
  const resources = nodes.map(normalizeResource).filter((r): r is NormalizedResource => r !== null);
  if (resources.length === 0) return result;

  const deployables = output.deployable_evidence || [];
  const entryPoints = output.entry_points || [];
  const exitPoints = output.exit_points || [];
  const externalServices = output.external_services || [];
  const dataEntities = output.data_entities || [];

  // A deployable is anchored by an EXISTING node when one sits at its root
  // path — deployable_evidence has no id of its own, so edges attach to the
  // best node representing that deployable (a build-context/service node or
  // the file/module node at its root). Fall back to the infra resource itself.
  const deployableAnchors = indexDeployableAnchors(deployables, nodes);

  linkContainerToDeployable(resources, deployables, deployableAnchors, result);
  linkServiceExposure(resources, deployables, deployableAnchors, entryPoints, result);
  linkCloudResourceUsage(resources, exitPoints, externalServices, dataEntities, result);
  linkRuntimeDependencies(resources, deployableAnchors, result);
  linkProxyRoutes(resources, deployableAnchors, entryPoints, result);

  // Drop self-loops (a resource whose deployable anchor resolves back to the
  // resource node itself carries no information) and collapse duplicate
  // (type, source, target) edges — the same deployable can be reached via
  // several join keys (build path AND name), which should be one edge.
  const seen = new Set<string>();
  result.edges = result.edges.filter(e => {
    if (e.source === e.target) return false;
    const key = `${e.type}|${e.source}|${e.target}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  result.joins = result.joins.filter(j => !j.source_node || !j.target_node || j.source_node !== j.target_node);

  return result;
}

interface DeployableAnchor {
  deployable: DeployableEvidence;
  /** Node id to hang edges off — a code node under this deployable's SPECIFIC
   *  root sub-directory when one exists, else a stable synthetic deployable
   *  key. We never anchor to an arbitrary "first node in the repo": a root of
   *  '.', 'src', or '' owns the whole tree, so no single code node represents
   *  it — anchoring there would fabricate a misleading deploys target. */
  anchorNodeId: string;
  rootToken: string;
  nameToken: string;
  ports: Set<string>;
}

/** Root paths too broad to identify a single representative code node. */
function isBroadRoot(rootDir: string): boolean {
  return rootDir === '' || rootDir === '.' || rootDir === 'src' || rootDir === './src';
}

function syntheticDeployableId(dep: DeployableEvidence): string {
  return `deployable:${joinToken(dep.name) || joinToken(dep.root_path) || 'unnamed'}`;
}

function indexDeployableAnchors(deployables: DeployableEvidence[], nodes: CASNode[]): DeployableAnchor[] {
  return deployables.map(dep => {
    const rootDir = dep.root_path.replace(/\\/g, '/').replace(/\/+$/, '');
    // Only bind to a real code node when the deployable is rooted at a SPECIFIC
    // sub-directory; prefer the highest-level (entry-most) node under it. For a
    // whole-tree root there is no representative node, so use a synthetic key
    // — the edge is still real (it targets the deployable), just not a
    // fabricated "this Dockerfile deploys that one arbitrary class".
    let anchorNodeId = syntheticDeployableId(dep);
    if (!isBroadRoot(rootDir)) {
      const candidates = nodes.filter(n => n.source?.file && underRoot(n.source.file, rootDir));
      const best = candidates.sort((a, b) => (a.level ?? 9) - (b.level ?? 9))[0];
      if (best) anchorNodeId = best.id;
    }
    return {
      deployable: dep,
      anchorNodeId,
      rootToken: joinToken(rootDir.split('/').pop() || dep.name),
      nameToken: joinToken(dep.name),
      ports: new Set((dep.ports || []).map(p => String(p))),
    };
  });
}

function underRoot(file: string, rootDir: string): boolean {
  const f = file.replace(/\\/g, '/').replace(/^\/+/, '');
  const r = rootDir.replace(/^\/+/, '');
  if (r === '' || r === '.') return true;
  return f === r || f.startsWith(`${r}/`);
}

/**
 * (1) Container image / build-context -> the deployable/app it ships. Joins a
 * Dockerfile build-context dir or compose `build` path (or an image name) to a
 * deployable root/name. Edge: DEPLOYS.
 */
function linkContainerToDeployable(
  resources: NormalizedResource[],
  deployables: DeployableEvidence[],
  anchors: DeployableAnchor[],
  result: InfraTopologyLinkResult,
): void {
  const containerResources = resources.filter(
    r => r.node.type === 'container_image_definition' || r.node.type === 'compose_service' || r.resourceType.includes('deployment') || r.resourceType.includes('statefulset'),
  );
  for (const resource of containerResources) {
    const buildToken = joinToken(resource.buildPath?.split('/').pop());
    for (const anchor of anchors) {
      // Join on build-context dir == deployable root, or an image/service name
      // == deployable name. Both are concrete identifiers, never guessed.
      const joinKey =
        (buildToken && (buildToken === anchor.rootToken || buildToken === anchor.nameToken) ? buildToken : undefined) ||
        resource.names.map(n => identifiersJoin(n, anchor.deployable.name) || identifiersJoin(n, anchor.deployable.root_path.split('/').pop())).find(Boolean) ||
        resource.images.map(img => identifiersJoin(img.split('/').pop()?.split(':')[0], anchor.deployable.name)).find(Boolean);
      if (!joinKey) continue;
      result.edges.push(edge('DEPLOYS', resource.node.id, anchor.anchorNodeId, joinKey, { deployable: anchor.deployable.name, surface: resource.surface }));
      result.joins.push({ edge_type: 'DEPLOYS', summary: `${resource.node.name} ships ${anchor.deployable.name}`, join_key: joinKey, matched: true, source_node: resource.node.id, target_node: anchor.anchorNodeId });
    }
  }
}

/**
 * (2) K8s Service / Ingress (and compose port) -> the deployable/port it fronts
 * and, where a route matches the exposed port, the HTTP entry point it serves.
 * Edges: EXPOSES (resource -> deployable) and ROUTES_TO (resource -> route).
 */
function linkServiceExposure(
  resources: NormalizedResource[],
  deployables: DeployableEvidence[],
  anchors: DeployableAnchor[],
  entryPoints: CASEntryPoint[],
  result: InfraTopologyLinkResult,
): void {
  const frontends = resources.filter(
    r =>
      r.resourceType === 'kubernetes_service' ||
      r.resourceType === 'kubernetes_ingress' ||
      r.node.type === 'compose_service' ||
      r.resourceType.includes('service') ||
      r.resourceType.includes('ingress') ||
      r.resourceType.includes('loadbalancer'),
  );
  for (const resource of frontends) {
    const resourcePorts = new Set(resource.ports);
    // EXPOSES: front-end resource -> deployable exposing the same port OR
    // sharing a name (a Service named `orders` fronts the `orders` deployable).
    for (const anchor of anchors) {
      const portJoin = [...resourcePorts].find(p => anchor.ports.has(p));
      const nameJoin = resource.names.map(n => identifiersJoin(n, anchor.deployable.name)).find(Boolean);
      const joinKey = portJoin ? `port:${portJoin}` : nameJoin;
      if (!joinKey) continue;
      result.edges.push(edge('EXPOSES', resource.node.id, anchor.anchorNodeId, joinKey, { deployable: anchor.deployable.name, surface: resource.surface }));
      result.joins.push({ edge_type: 'EXPOSES', summary: `${resource.node.name} exposes ${anchor.deployable.name}`, join_key: joinKey, matched: true, source_node: resource.node.id, target_node: anchor.anchorNodeId });
    }
    // ROUTES_TO: front-end resource -> HTTP route entry points. When the
    // resource declares ports, only join routes we can tie to that port via
    // the handler's file being under a deployable that owns the port; when no
    // such tie exists we still join by shared name (Ingress host == service),
    // but never blanket-link every route.
    for (const ep of entryPoints) {
      if (ep.type !== 'http' && ep.type !== 'route') continue;
      // Skip the infra-emitted pseudo-entry-points (the Service's own port
      // entry) — we link to CODE routes, identified by a real handler file.
      const handlerFile = ep.handler?.file;
      if (!handlerFile) continue;
      const routePath = ep.trigger?.path || ep.name;
      const nameJoin = resource.names.map(n => identifiersJoin(n, ep.name) || identifiersJoin(n, routePath)).find(Boolean);
      if (!nameJoin) continue;
      result.edges.push(edge('ROUTES_TO', resource.node.id, ep.source_node, nameJoin, { route: routePath, entry_point: ep.id, surface: resource.surface }));
      result.joins.push({ edge_type: 'ROUTES_TO', summary: `${resource.node.name} routes to ${routePath}`, join_key: nameJoin, matched: true, source_node: resource.node.id, target_node: ep.source_node });
    }
  }
}

/**
 * (2b) Reverse-proxy route (Caddy/Nginx/Apache/HAProxy/Traefik) -> the service /
 * deployable / route its upstream fronts. The proxy analyzers emit each public
 * route as a `proxy_route` node carrying its resolved upstream on
 * deployment_service_name / service_aliases / ports — the SAME join vocabulary
 * k8s/compose nodes use — so this joins GENERICALLY:
 *   - proxy route -> deployable whose port or name matches the upstream (EXPOSES)
 *   - proxy route -> an HTTP entry point (route/handler) the upstream reaches (ROUTES_TO)
 * completing the topology edge public URL -> proxy -> service:port -> route ->
 * handler. Evidence-gated: fires only when a concrete port or name joins.
 */
function linkProxyRoutes(
  resources: NormalizedResource[],
  anchors: DeployableAnchor[],
  entryPoints: CASEntryPoint[],
  result: InfraTopologyLinkResult,
): void {
  const proxyRoutes = resources.filter(r => r.node.type === 'proxy_route');
  for (const route of proxyRoutes) {
    const routePorts = new Set(route.ports);
    // EXPOSES: the proxy route -> the deployable it fronts, joined by an upstream
    // port that equals a deployable port, or an upstream service name that equals
    // the deployable name.
    for (const anchor of anchors) {
      const portJoin = [...routePorts].find(p => anchor.ports.has(p));
      const nameJoin = route.names.map(n => identifiersJoin(n, anchor.deployable.name)).find(Boolean);
      const joinKey = portJoin ? `port:${portJoin}` : nameJoin;
      if (!joinKey) continue;
      result.edges.push(edge('EXPOSES', route.node.id, anchor.anchorNodeId, joinKey, { deployable: anchor.deployable.name, surface: route.surface, via: 'reverse-proxy' }));
      result.joins.push({ edge_type: 'EXPOSES', summary: `${route.node.name} fronts ${anchor.deployable.name}`, join_key: joinKey, matched: true, source_node: route.node.id, target_node: anchor.anchorNodeId });
    }
    // ROUTES_TO: the proxy route -> a code HTTP entry point whose handler file
    // sits under a deployable that owns the upstream port (so the public URL is
    // joined all the way to the handler). Only real code routes (with a handler
    // file) are eligible; the upstream must resolve to a port a deployable owns.
    if (routePorts.size === 0) continue;
    const owningAnchors = anchors.filter(a => [...routePorts].some(p => a.ports.has(p)));
    if (owningAnchors.length === 0) continue;
    for (const ep of entryPoints) {
      if (ep.type !== 'http' && ep.type !== 'route') continue;
      const handlerFile = ep.handler?.file;
      if (!handlerFile) continue;
      const ownsHandler = owningAnchors.some(a => underRoot(handlerFile, a.deployable.root_path.replace(/\\/g, '/').replace(/\/+$/, '')));
      if (!ownsHandler) continue;
      const routePath = ep.trigger?.path || ep.name;
      const port = [...routePorts].find(p => owningAnchors.some(a => a.ports.has(p)));
      result.edges.push(edge('ROUTES_TO', route.node.id, ep.source_node, `port:${port}`, { route: routePath, entry_point: ep.id, surface: route.surface, via: 'reverse-proxy' }));
      result.joins.push({ edge_type: 'ROUTES_TO', summary: `${route.node.name} routes to ${routePath}`, join_key: `port:${port}`, matched: true, source_node: route.node.id, target_node: ep.source_node });
    }
  }
}

/**
 * (3) Cloud resources -> code usage joins, evidence-gated on a matching
 * name/identifier:
 *   - queue/topic resource   -> messaging-channel exit point   (PROVISIONS_CHANNEL)
 *   - db instance/cluster    -> database exit point / data entity (PROVISIONS_DATABASE)
 *   - bucket/table/function  -> external/storage service node   (PROVISIONS_STORAGE)
 * Only fires when the resource's name joins a code-side identifier.
 */
function linkCloudResourceUsage(
  resources: NormalizedResource[],
  exitPoints: CASExitPoint[],
  externalServices: CASExternalService[],
  dataEntities: CASDataEntity[],
  result: InfraTopologyLinkResult,
): void {
  for (const resource of resources) {
    const category = classifyCloudResource(resource.resourceType);
    if (!category) continue;

    if (category === 'channel') {
      for (const exit of exitPoints) {
        if (exit.type !== 'message' && exit.type !== 'event') continue;
        const codeName = exit.target?.resource || exit.target?.service_id || exit.name;
        const joinKey = resource.names.map(n => identifiersJoin(n, codeName)).find(Boolean);
        if (!joinKey) continue;
        result.edges.push(edge('PROVISIONS_CHANNEL', resource.node.id, exit.source_node, joinKey, { channel: codeName, exit_point: exit.id, resource_type: resource.resourceType }));
        result.joins.push({ edge_type: 'PROVISIONS_CHANNEL', summary: `${resource.node.name} provisions channel ${codeName}`, join_key: joinKey, matched: true, source_node: resource.node.id, target_node: exit.source_node });
      }
    } else if (category === 'database') {
      for (const exit of exitPoints) {
        if (exit.type !== 'database') continue;
        const codeName = exit.target?.resource || exit.target?.service_id || exit.name;
        const joinKey = resource.names.map(n => identifiersJoin(n, codeName)).find(Boolean);
        if (!joinKey) continue;
        result.edges.push(edge('PROVISIONS_DATABASE', resource.node.id, exit.source_node, joinKey, { database: codeName, exit_point: exit.id, resource_type: resource.resourceType }));
        result.joins.push({ edge_type: 'PROVISIONS_DATABASE', summary: `${resource.node.name} provisions database ${codeName}`, join_key: joinKey, matched: true, source_node: resource.node.id, target_node: exit.source_node });
      }
      for (const entity of dataEntities) {
        const joinKey = resource.names.map(n => identifiersJoin(n, entity.name)).find(Boolean);
        if (!joinKey) continue;
        result.edges.push(edge('PROVISIONS_DATABASE', resource.node.id, entity.id, joinKey, { data_entity: entity.name, resource_type: resource.resourceType }));
        result.joins.push({ edge_type: 'PROVISIONS_DATABASE', summary: `${resource.node.name} provisions entity ${entity.name}`, join_key: joinKey, matched: true, source_node: resource.node.id, target_node: entity.id });
      }
    } else if (category === 'storage') {
      // Storage/compute resources (bucket, table, lambda) match an external
      // service the code references by name — the code side surfaces these as
      // external_services (or sdk exit points with a resource id).
      for (const svc of externalServices) {
        const joinKey = resource.names.map(n => identifiersJoin(n, svc.name) || identifiersJoin(n, svc.id)).find(Boolean);
        if (!joinKey) continue;
        for (const nodeId of svc.connected_nodes && svc.connected_nodes.length ? svc.connected_nodes : [resource.node.id]) {
          result.edges.push(edge('PROVISIONS_STORAGE', resource.node.id, nodeId, joinKey, { service: svc.name, resource_type: resource.resourceType }));
        }
        result.joins.push({ edge_type: 'PROVISIONS_STORAGE', summary: `${resource.node.name} provisions ${svc.name}`, join_key: joinKey, matched: true, source_node: resource.node.id, target_node: svc.id });
      }
      for (const exit of exitPoints) {
        if (exit.type !== 'sdk' && exit.type !== 'file' && exit.type !== 'cache') continue;
        const codeName = exit.target?.resource || exit.target?.service_id || exit.name;
        const joinKey = resource.names.map(n => identifiersJoin(n, codeName)).find(Boolean);
        if (!joinKey) continue;
        result.edges.push(edge('PROVISIONS_STORAGE', resource.node.id, exit.source_node, joinKey, { store: codeName, exit_point: exit.id, resource_type: resource.resourceType }));
        result.joins.push({ edge_type: 'PROVISIONS_STORAGE', summary: `${resource.node.name} provisions store ${codeName}`, join_key: joinKey, matched: true, source_node: resource.node.id, target_node: exit.source_node });
      }
    }
  }
}

type CloudResourceCategory = 'channel' | 'database' | 'storage';

/** Map a normalized cloud resource type to a usage category, or null when the
 *  resource is not a code-consumable data-plane resource (IAM, VPC, etc.). */
function classifyCloudResource(resourceType: string): CloudResourceCategory | null {
  // Messaging: SQS/SNS/Kinesis/EventBridge/PubSub/ServiceBus.
  if (/(sqs|sns|kinesis|eventbridge|event_bus|events_rule|pubsub|pub_sub|servicebus|service_bus|mq|amazonmq|kafka|msk)/.test(resourceType)) return 'channel';
  // Databases: RDS/Aurora/DynamoDB-as-store handled below; SQL engines here.
  if (/(db_instance|dbinstance|rds|aurora|db_cluster|dbcluster|sql_database|sqldatabase|documentdb|redshift|elasticache|cosmosdb|cosmos_db|spanner|cloud_sql|cloudsql)/.test(resourceType)) return 'database';
  // Storage / serverless compute the code references by identifier.
  if (/(s3_bucket|s3bucket|storage_bucket|storagebucket|blob|bucket|dynamodb_table|dynamodb|table|lambda_function|lambdafunction|lambda|cloud_function|cloudfunction|function|efs|filesystem)/.test(resourceType)) return 'storage';
  return null;
}

/**
 * (4) compose depends_on / k8s owner refs -> service-dependency edges between
 * DEPLOYABLES. The container analyzer already emits DEPENDS_ON between compose
 * service nodes; here we lift those to deployable-level RUNTIME_DEPENDS_ON when
 * both endpoints resolve to a deployable, giving a deployable dependency graph.
 */
function linkRuntimeDependencies(
  resources: NormalizedResource[],
  anchors: DeployableAnchor[],
  result: InfraTopologyLinkResult,
): void {
  const anchorByName = new Map<string, DeployableAnchor>();
  for (const anchor of anchors) {
    if (anchor.nameToken) anchorByName.set(anchor.nameToken, anchor);
    if (anchor.rootToken) anchorByName.set(anchor.rootToken, anchor);
  }
  for (const resource of resources) {
    if (resource.dependsOn.length === 0) continue;
    const sourceAnchor = resource.names.map(n => anchorByName.get(joinToken(n))).find(Boolean);
    if (!sourceAnchor) continue;
    for (const dep of resource.dependsOn) {
      const targetAnchor = anchorByName.get(joinToken(dep));
      if (!targetAnchor || targetAnchor.anchorNodeId === sourceAnchor.anchorNodeId) continue;
      const joinKey = joinToken(dep);
      result.edges.push(edge('RUNTIME_DEPENDS_ON', sourceAnchor.anchorNodeId, targetAnchor.anchorNodeId, joinKey, { from: sourceAnchor.deployable.name, to: targetAnchor.deployable.name }));
      result.joins.push({ edge_type: 'RUNTIME_DEPENDS_ON', summary: `${sourceAnchor.deployable.name} depends on ${targetAnchor.deployable.name}`, join_key: joinKey, matched: true, source_node: sourceAnchor.anchorNodeId, target_node: targetAnchor.anchorNodeId });
    }
  }
}
