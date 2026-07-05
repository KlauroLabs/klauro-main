import { linkInfraTopology } from '../../analyzer/core/infra-topology-linker';
import type {
  CASNode,
  CASEntryPoint,
  CASExitPoint,
  CASExternalService,
  DeployableEvidence,
  CASOutput,
} from '../../types/cas.types';

function node(overrides: Partial<CASNode> & { id: string; name: string; type: string }): CASNode {
  return {
    qualified_name: overrides.qualified_name ?? overrides.name,
    category: 'infrastructure',
    level: 3,
    source: { file: 'infra.yaml', line: 1 },
    ...overrides,
  } as CASNode;
}

/** A container/build-context node (Dockerfile) shipping the `orders` service. */
function dockerfileNode(): CASNode {
  return node({
    id: 'dockerfile_services_orders_Dockerfile',
    name: 'orders',
    type: 'container_image_definition',
    source: { file: 'services/orders/Dockerfile', line: 1 },
    metadata: {
      topology_surface: 'dockerfile',
      attributes: { base_images: ['node:20'], exposed_ports: ['3000'], service_aliases: ['orders'] },
    } as any,
  });
}

/** A compose service `orders` with build path + port + depends_on payments. */
function composeServiceNode(name: string, build: string, port: string, dependsOn: string[] = []): CASNode {
  return node({
    id: `compose_service_${name}`,
    name: `Compose service: ${name}`,
    type: 'compose_service',
    metadata: {
      topology_surface: 'docker-compose',
      deployment_service_name: name,
      service_aliases: [name],
      build,
      ports: [{ container: port }],
      depends_on: dependsOn,
    } as any,
  });
}

/** A k8s Service fronting port 3000. */
function k8sServiceNode(name: string, port: string): CASNode {
  return node({
    id: `k8s_service_${name}`,
    name: `Service: ${name}`,
    type: 'kubernetes_service',
    metadata: {
      topology_surface: 'kubernetes',
      kubernetes_kind: 'Service',
      deployment_service_name: name,
      service_aliases: [name],
      ports: [port],
    } as any,
  });
}

/** A terraform aws_sqs_queue labelled `orders`. */
function sqsQueueNode(label: string): CASNode {
  return node({
    id: `terraform_sqs_${label}`,
    name: `resource.aws_sqs_queue.${label}`,
    type: 'infrastructure_resource',
    level: 4,
    source: { file: 'infra/main.tf', line: 10 },
    metadata: {
      topology_surface: 'terraform',
      attributes: { block_kind: 'resource', terraform_type: 'aws_sqs_queue', terraform_name: label, provider: 'aws' },
    } as any,
  });
}

function messageExit(resource: string): CASExitPoint {
  return {
    id: `exit_msg_${resource}`,
    source_node: 'fn_enqueue',
    type: 'message',
    name: `Publish to ${resource}`,
    target: { resource, service_id: resource },
  } as CASExitPoint;
}

function httpEntry(name: string, path: string, handlerFile: string): CASEntryPoint {
  return {
    id: `entry_${name}`,
    source_node: `fn_${name}`,
    type: 'http',
    name,
    trigger: { method: 'GET', path },
    handler: { node_id: `fn_${name}`, method_name: name, file: handlerFile, line: 1 },
  } as CASEntryPoint;
}

function deployable(name: string, root: string, ports: number[]): DeployableEvidence {
  return { root_path: root, name, tier: 2, kind: 'server-entry', evidence: [`${root}/index.ts`], ports };
}

function base(partial: Partial<CASOutput>): Parameters<typeof linkInfraTopology>[0] {
  return {
    nodes: [],
    entry_points: [],
    exit_points: [],
    external_services: [],
    data_entities: [],
    deployable_evidence: [],
    ...partial,
  };
}

describe('linkInfraTopology', () => {
  test('no infra nodes -> no edges', () => {
    const result = linkInfraTopology(base({ nodes: [node({ id: 'fn', name: 'foo', type: 'function' })] }));
    expect(result.edges).toEqual([]);
    expect(result.nodes).toEqual([]);
  });

  test('Dockerfile + compose + k8s Service join the orders deployable (deploys / exposes / routes_to)', () => {
    // App: an orders deployable rooted at services/orders exposing port 3000,
    // with a code node so anchors land on real code, plus an HTTP route.
    const appNode = node({ id: 'mod_orders_index', name: 'index', type: 'module', level: 1, source: { file: 'services/orders/index.ts', line: 1 } });
    const route = httpEntry('orders', '/orders', 'services/orders/routes.ts');
    const result = linkInfraTopology(
      base({
        nodes: [dockerfileNode(), composeServiceNode('orders', 'services/orders', '3000'), k8sServiceNode('orders', '3000'), appNode],
        entry_points: [route],
        deployable_evidence: [deployable('orders', 'services/orders', [3000])],
      }),
    );

    const deploys = result.edges.filter(e => e.type === 'DEPLOYS');
    const exposes = result.edges.filter(e => e.type === 'EXPOSES');
    const routesTo = result.edges.filter(e => e.type === 'ROUTES_TO');

    // Dockerfile build-context AND compose build path both ship the deployable.
    expect(deploys.length).toBeGreaterThanOrEqual(1);
    // k8s Service (port 3000) and compose (port 3000) expose the deployable.
    expect(exposes.length).toBeGreaterThanOrEqual(1);
    expect(exposes.some(e => (e.metadata?.attributes as any)?.join_key === 'port:3000')).toBe(true);
    // Service `orders` routes to the /orders code route (joined by name).
    expect(routesTo.length).toBeGreaterThanOrEqual(1);
    expect(routesTo[0].target).toBe('fn_orders');
    // Every edge carries a concrete join_key (verifiable, not fabricated).
    for (const e of result.edges) expect((e.metadata?.attributes as any)?.join_key).toBeTruthy();
  });

  test('aws_sqs_queue joins the code channel of the same name (provisions_channel)', () => {
    const result = linkInfraTopology(
      base({
        nodes: [sqsQueueNode('orders')],
        exit_points: [messageExit('orders-queue')],
      }),
    );
    const channels = result.edges.filter(e => e.type === 'PROVISIONS_CHANNEL');
    expect(channels).toHaveLength(1);
    expect(channels[0].source).toBe('terraform_sqs_orders');
    expect(channels[0].target).toBe('fn_enqueue');
    // The join reduced `orders` (label) and `orders-queue` (code) to `orders`.
    expect((channels[0].metadata?.attributes as any)?.join_key).toBe('orders');
  });

  test('EVIDENCE-GATING: a queue whose name matches nothing produces no edge', () => {
    const result = linkInfraTopology(
      base({
        nodes: [sqsQueueNode('shipments')],
        exit_points: [messageExit('orders-queue')],
      }),
    );
    expect(result.edges.filter(e => e.type === 'PROVISIONS_CHANNEL')).toHaveLength(0);
    expect(result.edges).toHaveLength(0);
  });

  test('aws_db_instance and aws_s3_bucket join database exits and external services by name', () => {
    const dbNode = node({
      id: 'terraform_rds_orders',
      name: 'resource.aws_db_instance.orders',
      type: 'infrastructure_resource',
      metadata: { topology_surface: 'terraform', attributes: { terraform_type: 'aws_db_instance', terraform_name: 'orders' } } as any,
    });
    const bucketNode = node({
      id: 'terraform_s3_uploads',
      name: 'resource.aws_s3_bucket.uploads',
      type: 'infrastructure_resource',
      metadata: { topology_surface: 'terraform', attributes: { terraform_type: 'aws_s3_bucket', terraform_name: 'uploads' } } as any,
    });
    const dbExit: CASExitPoint = { id: 'exit_db', source_node: 'fn_repo', type: 'database', name: 'orders db', target: { resource: 'orders' } } as CASExitPoint;
    const svc: CASExternalService = { id: 'svc_uploads', name: 'uploads', type: 'storage', connected_nodes: ['fn_upload'] };

    const result = linkInfraTopology(
      base({ nodes: [dbNode, bucketNode], exit_points: [dbExit], external_services: [svc] }),
    );
    expect(result.edges.filter(e => e.type === 'PROVISIONS_DATABASE')).toHaveLength(1);
    const storage = result.edges.filter(e => e.type === 'PROVISIONS_STORAGE');
    expect(storage).toHaveLength(1);
    expect(storage[0].target).toBe('fn_upload');
  });

  test('CloudFormation resource type (AWS::SQS::Queue) joins the same as terraform (dialect-agnostic)', () => {
    const cfnQueue = node({
      id: 'cfn_OrdersQueue',
      name: 'OrdersQueue',
      type: 'cloudformation_resource',
      metadata: { topology_surface: 'cloudformation', attributes: { cloudformation_type: 'AWS::SQS::Queue', resource_type: 'AWS::SQS::Queue' } } as any,
    });
    const result = linkInfraTopology(base({ nodes: [cfnQueue], exit_points: [messageExit('orders')] }));
    expect(result.edges.filter(e => e.type === 'PROVISIONS_CHANNEL')).toHaveLength(1);
  });

  test('compose depends_on lifts to deployable-level RUNTIME_DEPENDS_ON', () => {
    const result = linkInfraTopology(
      base({
        nodes: [
          composeServiceNode('orders', 'services/orders', '3000', ['payments']),
          composeServiceNode('payments', 'services/payments', '4000'),
        ],
        deployable_evidence: [deployable('orders', 'services/orders', [3000]), deployable('payments', 'services/payments', [4000])],
      }),
    );
    const deps = result.edges.filter(e => e.type === 'RUNTIME_DEPENDS_ON');
    expect(deps).toHaveLength(1);
    expect((deps[0].metadata?.attributes as any)?.from).toBe('orders');
    expect((deps[0].metadata?.attributes as any)?.to).toBe('payments');
  });
});
