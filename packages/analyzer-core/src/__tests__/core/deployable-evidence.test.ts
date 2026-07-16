jest.unmock('fs-extra');
jest.unmock('fs');
jest.unmock('glob');

import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { collectDeployableEvidence } from '../../analyzer/core/deployable-evidence';
import type { CASEntryPoint, CASExitPoint, CASNode } from '../../types/cas.types';

function tempProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-deployable-evidence-'));
}

describe('collectDeployableEvidence', () => {
  let projectPath: string;

  afterEach(() => {
    if (projectPath) fs.removeSync(projectPath);
  });

  test('Tier 1: a Dockerfile with only a base image (no COPY members) yields a container candidate with NO ships_paths', () => {
    projectPath = tempProject();
    // A base-image FROM ref is NOT a bundle member. ships_paths must stay a pure
    // member list (bin/crate/service names), so a Dockerfile that ships nothing
    // parseable carries no ships_paths — the FROM ref remains only in `evidence`.
    fs.writeFileSync(
      path.join(projectPath, 'Dockerfile'),
      'FROM node:22-alpine\nEXPOSE 3000\nCMD ["node", "server.js"]\n'
    );
    const nodes: CASNode[] = [
      {
        id: 'dockerfile_1',
        name: 'Docker image definition: Dockerfile',
        type: 'container_image_definition',
        source: { file: 'Dockerfile', line: 1 },
        metadata: {
          topology_surface: 'dockerfile',
          base_images: ['node:22-alpine'],
          exposed_ports: ['3000'],
          command: 'node server.js',
        } as any,
      },
    ];

    const result = collectDeployableEvidence({ projectPath, nodes, entryPoints: [], exitPoints: [] });
    const container = result.find(item => item.kind === 'container');
    expect(container).toBeDefined();
    expect(container!.tier).toBe(1);
    // The base image no longer leaks into ships_paths (source-side fix).
    expect(container!.ships_paths).toBeUndefined();
    // But it is still recorded as human-readable evidence.
    expect(container!.evidence.some(e => e.includes('FROM node:22-alpine'))).toBe(true);
    expect(container!.ports).toEqual([3000]);
    expect(container!.evidence.some(e => e.includes('Dockerfile'))).toBe(true);
  });

  test('Tier 1: ships_paths contains only real bundled members, excluding base-image FROM refs and image lineage', () => {
    projectPath = tempProject();
    // Multi-stage build: a base-image FROM + a real COPY of a built binary.
    // Only the built member ("my-service") belongs in ships_paths; the FROM
    // refs (base + runtime images) must NOT leak in.
    fs.writeFileSync(
      path.join(projectPath, 'Dockerfile'),
      [
        'FROM rust:1.79 AS builder',
        'WORKDIR /app',
        'RUN cargo build --release -p my-service',
        'FROM debian:bookworm-slim',
        'COPY --from=builder /app/target/release/my-service /usr/local/bin/my-service',
        'ENTRYPOINT ["/usr/local/bin/my-service"]',
      ].join('\n') + '\n'
    );
    const nodes: CASNode[] = [
      {
        id: 'dockerfile_ms',
        name: 'Docker image definition: Dockerfile',
        type: 'container_image_definition',
        source: { file: 'Dockerfile', line: 1 },
        metadata: {
          topology_surface: 'dockerfile',
          base_images: ['rust:1.79', 'debian:bookworm-slim'],
        } as any,
      },
    ];

    const result = collectDeployableEvidence({ projectPath, nodes, entryPoints: [], exitPoints: [] });
    const container = result.find(item => item.kind === 'container');
    expect(container).toBeDefined();
    // Only the real bundled member survives — no base/runtime image refs.
    expect(container!.ships_paths).toEqual(['my-service']);
    expect(container!.ships_paths).not.toContain('rust:1.79');
    expect(container!.ships_paths).not.toContain('debian:bookworm-slim');
    expect(container!.entrypoint_member).toBe('my-service');
  });

  test('Tier 1: compose service node WITH a build context yields a compose-service candidate', () => {
    projectPath = tempProject();
    const nodes: CASNode[] = [
      {
        id: 'compose_service_1',
        name: 'Compose service: web',
        type: 'compose_service',
        source: { file: 'docker-compose.yml', line: 3 },
        metadata: {
          topology_surface: 'docker-compose',
          deployment_service_name: 'web',
          build: '.',
          ports: [{ host: '8080', container: '80' }],
        } as any,
      },
    ];

    const result = collectDeployableEvidence({ projectPath, nodes, entryPoints: [], exitPoints: [] });
    const compose = result.find(item => item.kind === 'compose-service');
    expect(compose).toBeDefined();
    expect(compose!.name).toBe('web');
    expect(compose!.ports).toEqual([80]);
  });

  // Defect class: over-splitting on image-only backing services (truckspy
  // prod repro — a 6-node Redis cluster + rabbitmq + a bare-image nginx
  // reported as 8 separate "deployables" of the repo that merely runs a
  // client against them). A compose service with no `build:` context ships
  // someone else's pre-built image; it is a runtime DEPENDENCY, not a
  // ship/run artifact of this workspace, and must never become Tier-1
  // DeployableEvidence (see SPEC-DEPLOYABLE-DETECTION.md §2 and
  // container-topology-analyzer.ts's own external-service exit-point
  // handling for the same class of node).
  test('Tier 1: image-only compose service (no build context) yields NO compose-service candidate', () => {
    projectPath = tempProject();
    const nodes: CASNode[] = [
      {
        id: 'compose_service_redis',
        name: 'Compose service: redis',
        type: 'compose_service',
        source: { file: 'docker-compose.yml', line: 10 },
        metadata: {
          topology_surface: 'docker-compose',
          deployment_service_name: 'redis',
          image: 'redis:7.4-alpine',
          ports: [{ host: '6379', container: '6379' }],
        } as any,
      },
    ];

    const result = collectDeployableEvidence({ projectPath, nodes, entryPoints: [], exitPoints: [] });
    expect(result.find(item => item.kind === 'compose-service')).toBeUndefined();
  });

  test('Tier 1: multiple image-only sibling services (redis cluster shape) yield ZERO compose-service candidates, not one-per-node', () => {
    projectPath = tempProject();
    const redisNode = (name: string, index: number): CASNode => ({
      id: `compose_service_${name}`,
      name: `Compose service: ${name}`,
      type: 'compose_service',
      source: { file: 'docker-compose.yml', line: 10 + index },
      metadata: {
        topology_surface: 'docker-compose',
        deployment_service_name: name,
        image: 'redis:7.4-alpine',
      } as any,
    });
    const nodes: CASNode[] = [
      redisNode('redis', 0),
      redisNode('redis-node-1', 1),
      redisNode('redis-node-2', 2),
      redisNode('redis-cluster-creator', 3),
    ];

    const result = collectDeployableEvidence({ projectPath, nodes, entryPoints: [], exitPoints: [] });
    expect(result.filter(item => item.kind === 'compose-service')).toHaveLength(0);
  });

  test('Tier 1: compose build context resolves relative to the compose FILE dir, not the project root', () => {
    projectPath = tempProject();
    const nodes: CASNode[] = [
      {
        id: 'compose_service_php',
        name: 'Compose service: php',
        type: 'compose_service',
        source: { file: 'app/compose.yml', line: 2 },
        metadata: {
          topology_surface: 'docker-compose',
          deployment_service_name: 'php',
          build: '.',
        } as any,
      },
    ];

    const result = collectDeployableEvidence({ projectPath, nodes, entryPoints: [], exitPoints: [] });
    const compose = result.find(item => item.kind === 'compose-service');
    expect(compose).toBeDefined();
    // `build: .` in app/compose.yml means "app/", not the repo root.
    expect(compose!.root_path).toBe('app');
  });

  test('Tier 1: distribution artifact (installer) node yields an installer candidate', () => {
    projectPath = tempProject();
    const nodes: CASNode[] = [
      {
        id: 'distribution_artifact_1',
        name: 'Installer: MyApp',
        type: 'distribution_installer',
        source: { file: 'build/installer.nsi', line: 1 },
        metadata: {
          topology_surface: 'distribution-artifacts',
          artifact_kind: 'installer',
          distribution_role: 'installer',
          product_name: 'MyApp',
          binary_names: ['myapp.exe'],
        } as any,
      },
    ];

    const result = collectDeployableEvidence({ projectPath, nodes, entryPoints: [], exitPoints: [] });
    const installer = result.find(item => item.kind === 'installer');
    expect(installer).toBeDefined();
    expect(installer!.name).toBe('MyApp');
    expect(installer!.ships_paths).toEqual(['myapp.exe']);
  });

  test('Tier 2: Cargo [[bin]] target is detected from Cargo.toml', () => {
    projectPath = tempProject();
    fs.writeFileSync(
      path.join(projectPath, 'Cargo.toml'),
      '[package]\nname = "myapp"\nversion = "0.1.0"\n\n[[bin]]\nname = "myapp-cli"\npath = "src/main.rs"\n'
    );

    const result = collectDeployableEvidence({ projectPath, nodes: [], entryPoints: [], exitPoints: [] });
    const bin = result.find(item => item.kind === 'bin' && item.name === 'myapp-cli');
    expect(bin).toBeDefined();
    expect(bin!.tier).toBe(2);
  });

  test('Tier 2: package.json bin field is detected', () => {
    projectPath = tempProject();
    fs.writeJsonSync(path.join(projectPath, 'package.json'), {
      name: 'my-cli',
      version: '1.0.0',
      bin: { 'my-cli': './bin/cli.js' },
    });

    const result = collectDeployableEvidence({ projectPath, nodes: [], entryPoints: [], exitPoints: [] });
    const bin = result.find(item => item.kind === 'bin' && item.name === 'my-cli');
    expect(bin).toBeDefined();
    expect(bin!.tier).toBe(2);
  });

  test('Tier 2: HTTP entry point yields a server-entry candidate', () => {
    projectPath = tempProject();
    const entryPoints: CASEntryPoint[] = [
      {
        id: 'entry_1',
        source_node: 'node_1',
        type: 'http',
        name: 'GET /health',
        trigger: { method: 'GET', path: '/health' },
        handler: { node_id: 'node_1', method_name: 'health', file: 'src/server.ts', line: 10 },
      },
    ];

    const result = collectDeployableEvidence({ projectPath, nodes: [], entryPoints, exitPoints: [] });
    const serverEntry = result.find(item => item.kind === 'server-entry');
    expect(serverEntry).toBeDefined();
    expect(serverEntry!.tier).toBe(2);
    expect(serverEntry!.root_path).toBe('src');
  });

  test('Tier 2: server-entry root_path is corrected to the full monorepo-relative path when handler.file was recorded relative to a sub-package scan root', () => {
    // Regression lock for the root_path truncation bug: a per-package
    // analysis pass can emit `entry.handler.file` relative to that
    // sub-package's own scan root (e.g. "src/routes/auth.ts") instead of the
    // full monorepo-relative path ("apps/billing-service/src/routes/auth.ts"),
    // while the corresponding CASNode.source.file for the SAME handler
    // carries the correctly-prefixed path (real observed case: an
    // "apps/mcp-server" analysis merged into a wider workspace CAS left
    // `deployable_evidence[].root_path` as a bare "src" instead of
    // "apps/mcp-server/src"). collectServerEntries must prefer the node's
    // evidence-grounded path when it is a proper prefix-superset of the
    // handler's recorded file, not the truncated one.
    projectPath = tempProject();
    const nodes: CASNode[] = [
      {
        id: 'node_1',
        name: 'GET /health',
        type: 'route',
        source: { file: 'apps/billing-service/src/routes/health.ts', line: 10 },
      },
    ];
    const entryPoints: CASEntryPoint[] = [
      {
        id: 'entry_1',
        source_node: 'node_1',
        type: 'http',
        name: 'GET /health',
        trigger: { method: 'GET', path: '/health' },
        // Truncated relative to the sub-package's own scan root, not the repo root.
        handler: { node_id: 'node_1', method_name: 'health', file: 'src/routes/health.ts', line: 10 },
      },
    ];

    const result = collectDeployableEvidence({ projectPath, nodes, entryPoints, exitPoints: [] });
    const serverEntry = result.find(item => item.kind === 'server-entry');
    expect(serverEntry).toBeDefined();
    // Corrected: apps/<app>/src, not a bare "src".
    expect(serverEntry!.root_path).toBe('apps/billing-service/src');
    expect(serverEntry!.name).toBe('src');
  });

  test('Tier 2: server-entry root_path is left as the handler.file dirname when no corroborating node path exists (no fabrication)', () => {
    // Same shape as above, but the node lookup misses (no node, or the node's
    // source.file doesn't agree with handler.file as a prefix superset) — the
    // fix must never fabricate a correction, only apply one it can evidence.
    projectPath = tempProject();
    const nodes: CASNode[] = [
      {
        id: 'node_1',
        name: 'GET /health',
        type: 'route',
        // Unrelated path — NOT a superset of handler.file — must not be used.
        source: { file: 'apps/unrelated-service/other.ts', line: 1 },
      },
    ];
    const entryPoints: CASEntryPoint[] = [
      {
        id: 'entry_1',
        source_node: 'node_1',
        type: 'http',
        name: 'GET /health',
        trigger: { method: 'GET', path: '/health' },
        handler: { node_id: 'node_1', method_name: 'health', file: 'src/routes/health.ts', line: 10 },
      },
    ];

    const result = collectDeployableEvidence({ projectPath, nodes, entryPoints, exitPoints: [] });
    const serverEntry = result.find(item => item.kind === 'server-entry');
    expect(serverEntry).toBeDefined();
    expect(serverEntry!.root_path).toBe('src');
  });

  test('Tier 2: a server with many HTTP routes yields ONE server-entry deployable, not one per route', () => {
    projectPath = tempProject();
    // Regression lock for the over-count bug: collectServerEntries used to
    // dedupe by `${rootPath}::${routePath}`, so every route on the same
    // server process became its own "deployable" (432 for ~4 real apps on
    // truckspy). A server that serves 400 routes is ONE deployable.
    const routeCount = 25;
    const entryPoints: CASEntryPoint[] = Array.from({ length: routeCount }, (_, i) => ({
      id: `entry_${i}`,
      source_node: `node_${i}`,
      type: 'http',
      name: `GET /route-${i}`,
      trigger: { method: 'GET', path: `/route-${i}` },
      handler: { node_id: `node_${i}`, method_name: `route${i}`, file: 'src/server.ts', line: 10 + i },
    }));

    const result = collectDeployableEvidence({ projectPath, nodes: [], entryPoints, exitPoints: [] });
    const serverEntries = result.filter(item => item.kind === 'server-entry');
    expect(serverEntries).toHaveLength(1);
    expect(serverEntries[0].root_path).toBe('src');
  });

  test('Tier 2: HTTP routes under different roots still yield separate server-entry deployables', () => {
    projectPath = tempProject();
    const entryPoints: CASEntryPoint[] = [
      {
        id: 'entry_a1',
        source_node: 'node_a1',
        type: 'http',
        name: 'GET /a/one',
        trigger: { method: 'GET', path: '/a/one' },
        handler: { node_id: 'node_a1', method_name: 'one', file: 'apps/api/src/server.ts', line: 1 },
      },
      {
        id: 'entry_a2',
        source_node: 'node_a2',
        type: 'http',
        name: 'GET /a/two',
        trigger: { method: 'GET', path: '/a/two' },
        handler: { node_id: 'node_a2', method_name: 'two', file: 'apps/api/src/server.ts', line: 2 },
      },
      {
        id: 'entry_b1',
        source_node: 'node_b1',
        type: 'http',
        name: 'GET /b/one',
        trigger: { method: 'GET', path: '/b/one' },
        handler: { node_id: 'node_b1', method_name: 'one', file: 'apps/web/src/server.ts', line: 1 },
      },
    ];

    const result = collectDeployableEvidence({ projectPath, nodes: [], entryPoints, exitPoints: [] });
    const serverEntries = result.filter(item => item.kind === 'server-entry');
    expect(serverEntries).toHaveLength(2);
    expect(new Set(serverEntries.map(e => e.root_path))).toEqual(new Set(['apps/api/src', 'apps/web/src']));
  });

  test('file-per-route layout collapses to ONE server-entry and NEVER names it after a route path', () => {
    projectPath = tempProject();
    // Next.js app-router file-per-route: each handler lives in its own per-route
    // dir (app/api/users/route.ts, app/api/orders/route.ts, ...). Previously each
    // produced its own "deployable" rooted at the route dir and named after the
    // route path — fragmenting one app into dozens of pseudo-components.
    const routes = ['users', 'orders', 'payments', 'invoices', 'auth', 'health'];
    const entryPoints: CASEntryPoint[] = routes.map((r, i) => ({
      id: `entry_${i}`,
      source_node: `node_${i}`,
      type: 'http',
      name: `GET /api/${r}`,
      trigger: { method: 'GET', path: `/api/${r}` },
      handler: { node_id: `node_${i}`, method_name: 'GET', file: `app/api/${r}/route.ts`, line: 1 },
    }));

    const result = collectDeployableEvidence({ projectPath, nodes: [], entryPoints, exitPoints: [] });
    const serverEntries = result.filter(item => item.kind === 'server-entry');
    // All six routes fold into a single server-entry, not one per route dir.
    expect(serverEntries).toHaveLength(1);
    // The route path must never leak into the deployable name.
    for (const se of serverEntries) {
      expect(se.name).not.toMatch(/^\s*(GET|POST|PUT|PATCH|DELETE|ALL)\b/i);
      expect(se.name).not.toContain('/');
    }
  });

  test('(a) no deployable name is an HTTP route path (method + path shape)', () => {
    projectPath = tempProject();
    const entryPoints: CASEntryPoint[] = [
      {
        id: 'e1', source_node: 'n1', type: 'http',
        name: 'POST /api/v1/users/:id',
        trigger: { method: 'POST', path: '/api/v1/users/:id' },
        handler: { node_id: 'n1', method_name: 'create', file: 'services/user-svc/routes/users.ts', line: 1 },
      },
      {
        id: 'e2', source_node: 'n2', type: 'http',
        name: 'GET /api/v1/orders',
        trigger: { method: 'GET', path: '/api/v1/orders' },
        handler: { node_id: 'n2', method_name: 'list', file: 'services/user-svc/routes/orders.ts', line: 1 },
      },
    ];
    const result = collectDeployableEvidence({ projectPath, nodes: [], entryPoints, exitPoints: [] });
    for (const dep of result) {
      // A method-prefixed name or a name containing a `/` route separator is a
      // leaked route path — the whole class this guards against.
      expect(dep.name).not.toMatch(/^\s*(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|ALL)\s+\//i);
      expect(dep.name).not.toContain('/');
    }
    // The routes-dir handlers collapse to the owning service, cleanly named.
    const serverEntries = result.filter(d => d.kind === 'server-entry');
    expect(serverEntries).toHaveLength(1);
    expect(serverEntries[0].root_path).toBe('services/user-svc');
    expect(serverEntries[0].name).toBe('user-svc');
  });

  test('(b) a Dockerfile deployable name is the clean build-context name, not the node display label', () => {
    projectPath = tempProject();
    const nodes: CASNode[] = [
      {
        id: 'dockerfile_admin',
        // The container-topology analyzer names these nodes with a display label.
        name: 'Docker image definition: apps/admin-api/Dockerfile',
        type: 'container_image_definition',
        source: { file: 'apps/admin-api/Dockerfile', line: 1 },
        metadata: {
          topology_surface: 'dockerfile',
          base_images: ['node:22-alpine'],
          service_aliases: ['admin-api'],
        } as any,
      },
    ];
    const result = collectDeployableEvidence({ projectPath, nodes, entryPoints: [], exitPoints: [] });
    const container = result.find(item => item.kind === 'container');
    expect(container).toBeDefined();
    // Clean build-context basename, NOT the "Docker image definition: ..." label.
    expect(container!.name).toBe('admin-api');
    expect(container!.name).not.toContain('Docker image definition');
    expect(container!.name).not.toContain(':');
  });

  test('Tier 3: package.json contributes package identity', () => {
    projectPath = tempProject();
    fs.writeJsonSync(path.join(projectPath, 'package.json'), { name: 'my-lib', version: '2.0.0' });

    const result = collectDeployableEvidence({ projectPath, nodes: [], entryPoints: [], exitPoints: [] });
    const pkg = result.find(item => item.kind === 'package' && item.name === 'my-lib');
    expect(pkg).toBeDefined();
    expect(pkg!.tier).toBe(3);
  });

  test('Tier 1: CI workflow with a deploy step is detected', () => {
    projectPath = tempProject();
    fs.mkdirpSync(path.join(projectPath, '.github', 'workflows'));
    fs.writeFileSync(
      path.join(projectPath, '.github', 'workflows', 'deploy.yml'),
      'name: Deploy\non: push\njobs:\n  deploy:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm publish\n'
    );

    const result = collectDeployableEvidence({ projectPath, nodes: [], entryPoints: [], exitPoints: [] });
    const ciDeploy = result.find(item => item.kind === 'ci-deploy');
    expect(ciDeploy).toBeDefined();
    expect(ciDeploy!.tier).toBe(1);
  });

  test('returns no candidates for an empty project', () => {
    projectPath = tempProject();
    const result = collectDeployableEvidence({ projectPath, nodes: [], entryPoints: [], exitPoints: [] });
    expect(result).toEqual([]);
  });

  test('multi-deployable: an installer bundles two named bins while a third bin stays independent (zerac/poc shape, SPEC §6/§7-case-1)', () => {
    // Evidence-first multi-deployable fixture per docs/SPEC-DEPLOYABLE-DETECTION.md
    // §6 (zerac/poc worked example) + §7 case 1 (bundle-via-installer), exercised at
    // the evidence-collection layer (deterministic, no cross-repo graph, no AI):
    //
    //   - 3 runnable Cargo [[bin]] targets (Tier 2): client, client-service, worker
    //   - 1 installer artifact (Tier 1) whose binary_names bundle EXACTLY
    //     client + client-service into one ship unit (ships_paths = those two).
    //
    // The installer is positive Tier-1 bundling evidence naming client &
    // client-service; `worker` is named by NOTHING, so it must remain a separate
    // candidate (the SPEC's "never merge on absence alone" rule). This asserts the
    // evidence layer emits the correct ships_paths membership — the input the
    // downstream resolver uses to set bundled_into — without silently merging worker.
    projectPath = tempProject();
    fs.writeFileSync(
      path.join(projectPath, 'Cargo.toml'),
      [
        '[package]',
        'name = "zerac-poc"',
        'version = "0.1.0"',
        '',
        '[[bin]]',
        'name = "client"',
        'path = "src/client/main.rs"',
        '',
        '[[bin]]',
        'name = "client-service"',
        'path = "src/client-service/main.rs"',
        '',
        '[[bin]]',
        'name = "worker"',
        'path = "src/worker/main.rs"',
        '',
      ].join('\n')
    );
    const nodes: CASNode[] = [
      {
        id: 'installer_zerac',
        name: 'Installer: ZeracClient',
        type: 'distribution_installer',
        source: { file: 'installer/install.sh', line: 1 },
        metadata: {
          topology_surface: 'distribution-artifacts',
          artifact_kind: 'installer',
          distribution_role: 'installer',
          product_name: 'ZeracClient',
          // The installer bundles exactly these two bins into one shipped product.
          binary_names: ['client', 'client-service'],
        } as any,
      },
    ];

    const result = collectDeployableEvidence({ projectPath, nodes, entryPoints: [], exitPoints: [] });

    // Three Tier-2 bins are discovered from Cargo.toml.
    const bins = result.filter(item => item.kind === 'bin');
    expect(new Set(bins.map(b => b.name))).toEqual(new Set(['client', 'client-service', 'worker']));
    for (const b of bins) expect(b.tier).toBe(2);

    // One Tier-1 installer, bundling exactly the two named members — this is the
    // ship-unit boundary evidence the resolver folds members into.
    const installer = result.find(item => item.kind === 'installer');
    expect(installer).toBeDefined();
    expect(installer!.tier).toBe(1);
    expect(installer!.name).toBe('ZeracClient');
    expect(installer!.ships_paths).toEqual(['client', 'client-service']);

    // `worker` is named by no ship artifact — it must NOT be swept into the
    // installer's membership. (Evidence layer: absence of it from any ships_paths.)
    const allShipsPaths = result.flatMap(item => item.ships_paths ?? []);
    expect(allShipsPaths).not.toContain('worker');
  });
});

// Defect class: K8s resource kinds treated as independent ship units. A
// Service/ServiceAccount/Ingress/ConfigMap/Secret/HPA is wiring, identity,
// routing, or config ATTACHED to a workload (Deployment/StatefulSet/
// DaemonSet/CronJob/Job) — it is evidence for that workload's boundary, not
// a ship unit of its own. Only workload kinds may become Tier-1
// DeployableEvidence for a plain (non-Helm) k8s manifest.
describe('collectDeployableEvidence — k8s resource-kind rollup', () => {
  let projectPath: string;

  afterEach(() => {
    if (projectPath) fs.removeSync(projectPath);
  });

  function k8sNode(kind: string, name: string, file = 'k8s/backend.yaml'): CASNode {
    return {
      id: `k8s_${kind.toLowerCase()}_${name}`,
      name: `${kind}: ${name}`,
      type: `kubernetes_${kind.toLowerCase()}`,
      source: { file, line: 1 },
      metadata: {
        topology_surface: 'kubernetes',
        kubernetes_kind: kind,
        deployment_service_name: name,
      } as any,
    };
  }

  test('a plain (non-Helm) Deployment is a Tier-1 k8s deployable', () => {
    projectPath = tempProject();
    const nodes = [k8sNode('Deployment', 'backend')];
    const result = collectDeployableEvidence({ projectPath, nodes, entryPoints: [], exitPoints: [] });
    const deployment = result.find(item => item.kind === 'k8s');
    expect(deployment).toBeDefined();
    expect(deployment!.name).toBe('backend');
  });

  test('Service/ServiceAccount/Ingress/ConfigMap/Secret/HPA siblings of a Deployment do NOT each become a separate deployable', () => {
    projectPath = tempProject();
    const nodes = [
      k8sNode('Deployment', 'backend'),
      k8sNode('Service', 'backend'),
      k8sNode('ServiceAccount', 'backend'),
      k8sNode('Ingress', 'backend'),
      k8sNode('ConfigMap', 'backend-config'),
      k8sNode('Secret', 'backend-secret'),
      k8sNode('HorizontalPodAutoscaler', 'backend'),
    ];
    const result = collectDeployableEvidence({ projectPath, nodes, entryPoints: [], exitPoints: [] });
    const k8sDeployables = result.filter(item => item.kind === 'k8s');
    // Exactly one ship unit — the workload — not seven.
    expect(k8sDeployables).toHaveLength(1);
    expect(k8sDeployables[0].name).toBe('backend');
    // The non-workload siblings are cited as attached evidence, not dropped silently.
    expect(k8sDeployables[0].evidence.some(e => e.includes('attached resources'))).toBe(true);
    expect(k8sDeployables[0].evidence.join(' ')).toContain('Service');
  });

  test('a Helm-origin kubernetes_* node contributes NO separate k8s deployable (the chart itself is the ship unit, via deploy-manifests.ts)', () => {
    projectPath = tempProject();
    const nodes: CASNode[] = [
      {
        id: 'helm_template_resource_1',
        name: 'Deployment: backend-deployment',
        type: 'kubernetes_deployment',
        source: { file: 'charts/backend/templates/deployment.yaml', line: 1 },
        metadata: {
          language: 'Helm',
          attributes: { topology_surface: 'helm', kubernetes_kind: 'Deployment', chart_name: 'backend' },
        } as any,
      },
    ];
    const result = collectDeployableEvidence({ projectPath, nodes, entryPoints: [], exitPoints: [] });
    expect(result.filter(item => item.kind === 'k8s')).toHaveLength(0);
  });
});
