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

































export type InfraTopologyEdgeType =
  | 'DEPLOYS'
  | 'EXPOSES'
  | 'ROUTES_TO'
  | 'PROVISIONS_CHANNEL'
  | 'PROVISIONS_DATABASE'
  | 'PROVISIONS_STORAGE'
  | 'RUNTIME_DEPENDS_ON'
  | 'PROXIES_TO';

export interface InfraTopologyLinkResult {

  edges: CASEdge[];

  nodes: CASNode[];

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


  resourceType: string;


  names: string[];
  ports: string[];
  images: string[];

  buildPath?: string;
  dependsOn: string[];
}

let seq = 0;
function nextId(prefix: string): string {
  seq += 1;
  return `${prefix}_infra_link_${seq}`;
}



function normalizeResourceType(raw: string | undefined): string {
  return String(raw || '').toLowerCase().replace(/::/g, '_').replace(/[^a-z0-9_]/g, '_');
}




function joinToken(value: string | undefined): string {
  return String(value || '')
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}



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




function identifiersJoin(a: string | undefined, b: string | undefined): string | undefined {
  const setA = joinTokenSet(a);
  const setB = joinTokenSet(b);
  for (const token of setA) {
    if (token.length >= 3 && setB.has(token)) return token;
  }
  return undefined;
}



function dedupePreserveOrder(values: string[]): string[] {
  return Array.from(new Set(values));
}

function toArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(v => String(v)).filter(Boolean);
  if (value === undefined || value === null) return [];
  return [String(value)].filter(Boolean);
}



function portNumber(value: unknown): string | undefined {
  if (value && typeof value === 'object' && 'container' in (value as any)) {
    return portNumber((value as any).container);
  }
  const digits = String(value ?? '').match(/\d{2,5}/)?.[0];
  return digits || undefined;
}



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







  const names = dedupePreserveOrder(
    [

      attrs.name,
      attrs.queue_name,
      attrs.bucket,
      attrs.table_name,
      attrs.identifier,
      attrs.db_name,
      attrs.function_name,
      attrs.repository,

      meta.deployment_service_name,
      ...toArray(meta.service_aliases),
      ...toArray(attrs.service_aliases),

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






export function linkInfraTopology(output: Pick<CASOutput, 'nodes' | 'entry_points' | 'exit_points' | 'external_services' | 'entities' | 'deployable_evidence'>): InfraTopologyLinkResult {
  const result: InfraTopologyLinkResult = { edges: [], nodes: [], joins: [] };
  seq = 0;

  const nodes = output.nodes || [];
  const resources = nodes.map(normalizeResource).filter((r): r is NormalizedResource => r !== null);
  if (resources.length === 0) return result;

  const deployables = output.deployable_evidence || [];
  const entryPoints = output.entry_points || [];
  const exitPoints = output.exit_points || [];
  const externalServices = output.external_services || [];
  const dataEntities = output.entities || [];





  const deployableAnchors = indexDeployableAnchors(deployables);

  linkContainerToDeployable(resources, deployables, deployableAnchors, result);
  linkServiceExposure(resources, deployables, deployableAnchors, entryPoints, result);
  linkCloudResourceUsage(resources, exitPoints, externalServices, dataEntities, result);
  linkRuntimeDependencies(resources, deployableAnchors, result);
  linkProxyRoutes(resources, deployableAnchors, entryPoints, result);





  const seen = new Set<string>();
  result.edges = result.edges.filter(e => {
    if (e.source === e.target) return false;
    const key = `${e.type}|${e.source}|${e.target}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  result.joins = result.joins.filter(j => !j.source_node || !j.target_node || j.source_node !== j.target_node);






  const referencedSyntheticIds = new Set<string>();
  for (const e of result.edges) {
    for (const endpoint of [e.source, e.target]) {
      if (endpoint.startsWith('deployable:')) referencedSyntheticIds.add(endpoint);
    }
  }
  const emittedSyntheticIds = new Set<string>();
  for (const anchor of deployableAnchors) {
    if (!referencedSyntheticIds.has(anchor.anchorNodeId) || emittedSyntheticIds.has(anchor.anchorNodeId)) continue;
    emittedSyntheticIds.add(anchor.anchorNodeId);
    result.nodes.push({
      id: anchor.anchorNodeId,
      name: anchor.deployable.name,
      type: 'deployable_unit',
      level: 1,
      level_name: 'system',
      analyzers: ['infra-topology-linker'],
      metadata: {
        deployable_name: anchor.deployable.name,
        deployable_root: anchor.deployable.root_path,
        deployable_kind: anchor.deployable.kind,
        synthetic_anchor: true,
        topology_surface: 'deployable',
      },
    } as CASNode);
  }

  return result;
}

interface DeployableAnchor {
  deployable: DeployableEvidence;





  anchorNodeId: string;
  rootToken: string;
  nameToken: string;
  ports: Set<string>;
}


function syntheticDeployableId(dep: DeployableEvidence): string {
  return `deployable:${joinToken(dep.name) || joinToken(dep.root_path) || 'unnamed'}`;
}

function indexDeployableAnchors(deployables: DeployableEvidence[]): DeployableAnchor[] {
  return deployables.map(dep => {
    const rootDir = dep.root_path.replace(/\\/g, '/').replace(/\/+$/, '');
    return {
      deployable: dep,
      anchorNodeId: syntheticDeployableId(dep),
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


    for (const anchor of anchors) {
      const portJoin = [...resourcePorts].find(p => anchor.ports.has(p));
      const nameJoin = resource.names.map(n => identifiersJoin(n, anchor.deployable.name)).find(Boolean);
      const joinKey = portJoin ? `port:${portJoin}` : nameJoin;
      if (!joinKey) continue;
      result.edges.push(edge('EXPOSES', resource.node.id, anchor.anchorNodeId, joinKey, { deployable: anchor.deployable.name, surface: resource.surface }));
      result.joins.push({ edge_type: 'EXPOSES', summary: `${resource.node.name} exposes ${anchor.deployable.name}`, join_key: joinKey, matched: true, source_node: resource.node.id, target_node: anchor.anchorNodeId });
    }





    for (const ep of entryPoints) {
      if (ep.type !== 'http' && ep.type !== 'route') continue;


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












function linkProxyRoutes(
  resources: NormalizedResource[],
  anchors: DeployableAnchor[],
  entryPoints: CASEntryPoint[],
  result: InfraTopologyLinkResult,
): void {
  const proxyRoutes = resources.filter(r => r.node.type === 'proxy_route');
  for (const route of proxyRoutes) {
    const routePorts = new Set(route.ports);



    for (const anchor of anchors) {
      const portJoin = [...routePorts].find(p => anchor.ports.has(p));
      const nameJoin = route.names.map(n => identifiersJoin(n, anchor.deployable.name)).find(Boolean);
      const joinKey = portJoin ? `port:${portJoin}` : nameJoin;
      if (!joinKey) continue;
      result.edges.push(edge('EXPOSES', route.node.id, anchor.anchorNodeId, joinKey, { deployable: anchor.deployable.name, surface: route.surface, via: 'reverse-proxy' }));
      result.joins.push({ edge_type: 'EXPOSES', summary: `${route.node.name} fronts ${anchor.deployable.name}`, join_key: joinKey, matched: true, source_node: route.node.id, target_node: anchor.anchorNodeId });
    }




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



function classifyCloudResource(resourceType: string): CloudResourceCategory | null {

  if (/(sqs|sns|kinesis|eventbridge|event_bus|events_rule|pubsub|pub_sub|servicebus|service_bus|mq|amazonmq|kafka|msk)/.test(resourceType)) return 'channel';

  if (/(db_instance|dbinstance|rds|aurora|db_cluster|dbcluster|sql_database|sqldatabase|documentdb|redshift|elasticache|cosmosdb|cosmos_db|spanner|cloud_sql|cloudsql)/.test(resourceType)) return 'database';

  if (/(s3_bucket|s3bucket|storage_bucket|storagebucket|blob|bucket|dynamodb_table|dynamodb|table|lambda_function|lambdafunction|lambda|cloud_function|cloudfunction|function|efs|filesystem)/.test(resourceType)) return 'storage';
  return null;
}







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
