jest.unmock('fs-extra');
jest.unmock('fs');
jest.unmock('glob');

import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { collectDeployableEvidence } from '../../analyzer/core/deployable-evidence';
import type { CASEntryPoint, CASNode } from '../../types/cas.types';

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

  // --- Real-shape junk-identity regression coverage (2026-07 hosted
  // reanalysis of a Rust multi-binary workspace, installer-identity
  // iteration 2). Each case reproduces one of the observed junk installer
  // rows and asserts it no longer mints a standalone unit / is not named
  // after the junk value.

  function installerNode(overrides: Partial<Record<string, any>>, id = 'distribution_artifact_junk'): CASNode {
    return {
      id,
      name: 'Installer node',
      type: 'distribution_installer',
      source: { file: 'scripts/some-script.sh', line: 1 },
      metadata: {
        topology_surface: 'distribution-artifacts',
        artifact_kind: 'installer',
        distribution_role: 'installer',
        binary_names: [],
        ...overrides,
      } as any,
    } as CASNode;
  }

  test('an assignment/comparison scrape ("=") never mints a standalone installer unit', () => {
    projectPath = tempProject();
    const nodes = [installerNode({ product_name: '=' })];
    const result = collectDeployableEvidence({ projectPath, nodes, entryPoints: [], exitPoints: [] });
    expect(result.some(item => item.kind === 'installer')).toBe(false);
  });

  test('a verb-phrase productName ("resolve version") is rejected, not minted as an installer unit', () => {
    projectPath = tempProject();
    const nodes = [installerNode({ product_name: 'resolve version' })];
    const result = collectDeployableEvidence({ projectPath, nodes, entryPoints: [], exitPoints: [] });
    expect(result.some(item => item.kind === 'installer')).toBe(false);
  });

  test('a bare platform word ("windows") is rejected, not minted as an installer unit', () => {
    projectPath = tempProject();
    const nodes = [installerNode({ product_name: 'windows' })];
    const result = collectDeployableEvidence({ projectPath, nodes, entryPoints: [], exitPoints: [] });
    expect(result.some(item => item.kind === 'installer')).toBe(false);
  });

  test('a platform word qualified only by a build-shape word ("windows prebuilt") is rejected', () => {
    projectPath = tempProject();
    const nodes = [installerNode({ product_name: 'windows prebuilt' })];
    const result = collectDeployableEvidence({ projectPath, nodes, entryPoints: [], exitPoints: [] });
    expect(result.some(item => item.kind === 'installer')).toBe(false);
  });

  test('a bare build-shape word ("local") is rejected, not minted as an installer unit', () => {
    projectPath = tempProject();
    const nodes = [installerNode({ product_name: 'local' })];
    const result = collectDeployableEvidence({ projectPath, nodes, entryPoints: [], exitPoints: [] });
    expect(result.some(item => item.kind === 'installer')).toBe(false);
  });

  test('an unresolved $VAR template remnant in product_name never mints a standalone installer unit (belt-and-suspenders)', () => {
    // Belt half of the template-var-guard fix: even if a candidate product_name
    // still carrying an unresolved shell/NSIS variable reaches this layer
    // (bypassing the extraction-layer resolveTemplateVar rejection in
    // distribution-artifact-analyzer.ts), isRealProductNameToken must fail
    // closed rather than mint a unit identified by e.g. "Zerac $BINARY_NAME".
    projectPath = tempProject();
    const nodes = [installerNode({ product_name: 'Zerac $BINARY_NAME' })];
    const result = collectDeployableEvidence({ projectPath, nodes, entryPoints: [], exitPoints: [] });
    expect(result.some(item => item.kind === 'installer')).toBe(false);
  });

  test('an unresolved ${VAR}-braced remnant in product_name never mints a standalone installer unit', () => {
    projectPath = tempProject();
    const nodes = [installerNode({ product_name: 'Zerac ${BINARY_NAME}' })];
    const result = collectDeployableEvidence({ projectPath, nodes, entryPoints: [], exitPoints: [] });
    expect(result.some(item => item.kind === 'installer')).toBe(false);
  });

  test('a genuine product name is still accepted (positive control)', () => {
    projectPath = tempProject();
    const nodes = [installerNode({ product_name: 'Zerac', binary_names: ['Zerac.exe'], platforms: ['windows'] })];
    const result = collectDeployableEvidence({ projectPath, nodes, entryPoints: [], exitPoints: [] });
    const installer = result.find(item => item.kind === 'installer');
    expect(installer).toBeDefined();
    expect(installer!.name).toBe('Zerac');
  });

  test('a distinct-platform ship artifact filename is still accepted even with no productName (positive control)', () => {
    projectPath = tempProject();
    const nodes = [installerNode({ binary_names: ['MyApp.dmg'] })];
    const result = collectDeployableEvidence({ projectPath, nodes, entryPoints: [], exitPoints: [] });
    const installer = result.find(item => item.kind === 'installer');
    expect(installer).toBeDefined();
    expect(installer!.name).toBe('MyApp.dmg');
  });

  test('script-basename echoes ("build-windows-installer-prebuilt.sh") collapse into a clean platform-named unit, not their raw filename', () => {
    projectPath = tempProject();
    fs.writeFileSync(
      path.join(projectPath, 'build-windows-installer-prebuilt.sh'),
      '#!/bin/bash\ncargo build --release -p client\ncp target/release/client dist/\n'
    );

    const result = collectDeployableEvidence({ projectPath, nodes: [], entryPoints: [], exitPoints: [] });
    const installer = result.find(item => item.kind === 'installer');
    expect(installer).toBeDefined();
    expect(installer!.name).toBe('Windows Installer');
    expect(installer!.name).not.toBe('build-windows-installer-prebuilt');
  });

  test('script-basename echo ("build-mac-installer.sh") collapses to "Mac Installer"', () => {
    projectPath = tempProject();
    fs.writeFileSync(
      path.join(projectPath, 'build-mac-installer.sh'),
      '#!/bin/bash\ncargo build --release -p client\ncp target/release/client dist/\n'
    );

    const result = collectDeployableEvidence({ projectPath, nodes: [], entryPoints: [], exitPoints: [] });
    const installer = result.find(item => item.kind === 'installer');
    expect(installer).toBeDefined();
    expect(installer!.name).toBe('Mac Installer');
  });

  test('two scripts building the SAME platform (windows) converge on one merged unit, not two', () => {
    projectPath = tempProject();
    fs.writeFileSync(
      path.join(projectPath, 'build-windows-installer.sh'),
      '#!/bin/bash\ncargo build --release -p client\ncp target/release/client dist/\n'
    );
    fs.writeFileSync(
      path.join(projectPath, 'build-windows-installer-prebuilt.sh'),
      '#!/bin/bash\ncargo build --release -p daemon\ncp target/release/daemon dist/\n'
    );

    const result = collectDeployableEvidence({ projectPath, nodes: [], entryPoints: [], exitPoints: [] });
    const installers = result.filter(item => item.kind === 'installer' && item.name === 'Windows Installer');
    expect(installers).toHaveLength(1);
    expect(installers[0].ships_paths).toEqual(expect.arrayContaining(['client', 'daemon']));
  });

  test('root-container display name never leaks a project/storage hash id (prj_... shape)', () => {
    projectPath = tempProject();
    // Root-level plain Dockerfile with no named stem, no dir-derived identity
    // (project root itself), and no service_aliases -- falls back to the
    // displayName/basename path exercised by dockerfileDeployableName.
    fs.writeFileSync(path.join(projectPath, 'Dockerfile'), 'FROM rust:1.75\nCOPY target/release/coordinator /usr/local/bin/\nENTRYPOINT ["/usr/local/bin/coordinator"]\n');

    const result = collectDeployableEvidence({
      projectPath,
      nodes: [
        {
          id: 'dockerfile_root',
          name: 'Dockerfile',
          type: 'container_image_definition',
          source: { file: 'Dockerfile', line: 1 },
          metadata: { base_images: ['rust:1.75'], command: 'coordinator' } as any,
        } as CASNode,
      ],
      entryPoints: [],
      exitPoints: [],
      displayName: 'prj_wbW33m-wfETn1N41',
    });
    const container = result.find(item => item.kind === 'container');
    expect(container).toBeDefined();
    expect(container!.name).not.toBe('prj_wbW33m-wfETn1N41');
    expect(container!.name).not.toMatch(/^prj_/);
    // A hash/storage-id-shaped displayName has no honest name to fall through
    // to, so it lands on the stable placeholder.
    expect(container!.name).toBe('unnamed-service');
  });

  test('root-container display name uses the RESOLVED system name, not "unnamed-service" (#46)', () => {
    projectPath = tempProject();
    // Same shape as the prior test (root Dockerfile, no named stem, no
    // service_aliases) but with a resolved product-title-like displayName —
    // the kind resolveSystemDisplayName produces from a README/manifest name,
    // as opposed to a raw checkout-folder basename or storage id. This must
    // pass straight through safeDeployableName and NOT collapse to the
    // 'unnamed-service' last-resort placeholder.
    fs.writeFileSync(path.join(projectPath, 'Dockerfile'), 'FROM rust:1.75\nCOPY target/release/coordinator /usr/local/bin/\nENTRYPOINT ["/usr/local/bin/coordinator"]\n');

    const result = collectDeployableEvidence({
      projectPath,
      nodes: [
        {
          id: 'dockerfile_root',
          name: 'Dockerfile',
          type: 'container_image_definition',
          source: { file: 'Dockerfile', line: 1 },
          metadata: { base_images: ['rust:1.75'], command: 'coordinator' } as any,
        } as CASNode,
      ],
      entryPoints: [],
      exitPoints: [],
      displayName: 'Acme Scientific',
    });
    const container = result.find(item => item.kind === 'container');
    expect(container).toBeDefined();
    expect(container!.name).toBe('Acme Scientific');
    expect(container!.name).not.toBe('unnamed-service');
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

  test('Tier 2: absolute and relative provider evidence for one server is merged', () => {
    projectPath = tempProject();
    fs.ensureDirSync(path.join(projectPath, 'python'));
    fs.writeFileSync(
      path.join(projectPath, 'python', 'api.py'),
      'from fastapi import FastAPI\napp = FastAPI()\n'
    );
    const entryPoints: CASEntryPoint[] = [{
      id: 'python_route',
      source_node: 'python_handler',
      type: 'http',
      name: 'GET /orders/{id}',
      trigger: { method: 'GET', path: '/orders/{id}' },
      handler: {
        node_id: 'python_handler',
        method_name: 'get_order',
        file: path.join(projectPath, 'python', 'api.py'),
      },
    }];

    const result = collectDeployableEvidence({ projectPath, nodes: [], entryPoints, exitPoints: [] });
    const pythonServers = result.filter(item =>
      item.kind === 'server-entry' && item.root_path === 'python' && item.name === 'python'
    );
    expect(pythonServers).toHaveLength(1);
    expect(pythonServers[0].evidence).toEqual(expect.arrayContaining([
      expect.stringContaining('HTTP entry point'),
      expect.stringContaining('FastAPI app instantiation'),
    ]));
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
    // Bare-noun guard (isGenericStructuralDirName): "src" names no real unit,
    // so the deployable name walks up to the nearest real identity-bearing
    // segment, "billing-service" — not the meaningless "src" this used to
    // ship as (see bin-targets.ts's rootName).
    expect(serverEntry!.name).toBe('billing-service');
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

  test('Tier 1: CI workflow that deploys to a runtime target is detected', () => {
    projectPath = tempProject();
    fs.mkdirpSync(path.join(projectPath, '.github', 'workflows'));
    fs.writeFileSync(
      path.join(projectPath, '.github', 'workflows', 'deploy.yml'),
      'name: Deploy\non: push\njobs:\n  deploy:\n    runs-on: ubuntu-latest\n    steps:\n      - run: kubectl apply -f k8s/\n'
    );

    const result = collectDeployableEvidence({ projectPath, nodes: [], entryPoints: [], exitPoints: [] });
    const ciDeploy = result.find(item => item.kind === 'ci-deploy');
    expect(ciDeploy).toBeDefined();
    expect(ciDeploy!.tier).toBe(1);
  });

  // Real hosted defect: a release-automation workflow that BUILDS and
  // PUBLISHES a distributable artifact (a docker push, an `npm publish`, a
  // "Publish Packages" job that uploads a .deb/.rpm) is a packaging pipeline
  // for a product some OTHER evidence row (its container/bin/installer row)
  // already represents — it never puts a workload on a running target, so it
  // must not surface as an independent ship unit. Three such workflows for
  // the SAME single-binary product (build+push a Docker image, build+publish
  // a .deb, build+publish an .rpm) previously surfaced as three EXTRA
  // "deployable" ship units alongside the actual container/bin evidence.
  test('CI workflow that only builds/publishes a release artifact is NOT a ship unit', () => {
    projectPath = tempProject();
    fs.mkdirpSync(path.join(projectPath, '.github', 'workflows'));
    fs.writeFileSync(
      path.join(projectPath, '.github', 'workflows', 'docker.yml'),
      'name: Docker\non: push\njobs:\n  docker-images:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: docker/build-push-action@v6\n'
    );
    fs.writeFileSync(
      path.join(projectPath, '.github', 'workflows', 'debian_packages.yml'),
      'name: Debian Packages\non: push\njobs:\n  publish-packages:\n    name: Publish Packages\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm publish\n'
    );

    const result = collectDeployableEvidence({ projectPath, nodes: [], entryPoints: [], exitPoints: [] });
    expect(result.filter(item => item.kind === 'ci-deploy')).toHaveLength(0);
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

  test('bundling inherits the template-var-guard: an unresolved $VAR product name mints no unit, so the bins it would have named stay independent', () => {
    // Same shape as the zerac/poc worked example above, except the installer's
    // product_name still carries an unresolved shell variable (the observed
    // live defect: "Zerac $BINARY_NAME"). Because installerArtifactIdentity/
    // isRealProductNameToken now rejects that as an identity, NO installer unit
    // is minted at all — and since a rejected identity mints no unit, it has no
    // ships_paths to bundle client/client-service into. Both bins must surface
    // as independent Tier-2 candidates rather than disappearing into a phantom
    // "Zerac $BINARY_NAME" unit.
    projectPath = tempProject();
    fs.writeFileSync(
      path.join(projectPath, 'Cargo.toml'),
      [
        '[package]',
        'name = "some-poc"',
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
      ].join('\n')
    );
    const nodes: CASNode[] = [
      {
        id: 'installer_tainted',
        name: 'Installer: Tainted',
        type: 'distribution_installer',
        source: { file: 'installer/install.sh', line: 1 },
        metadata: {
          topology_surface: 'distribution-artifacts',
          artifact_kind: 'installer',
          distribution_role: 'installer',
          product_name: 'Zerac $BINARY_NAME',
          binary_names: ['client', 'client-service'],
        } as any,
      },
    ];

    const result = collectDeployableEvidence({ projectPath, nodes, entryPoints: [], exitPoints: [] });

    // No installer unit minted at all — the identity was rejected outright.
    expect(result.some(item => item.kind === 'installer')).toBe(false);

    // Both bins remain independent Tier-2 candidates, un-bundled.
    const bins = result.filter(item => item.kind === 'bin');
    expect(new Set(bins.map(b => b.name))).toEqual(new Set(['client', 'client-service']));
    for (const bin of bins) expect(bin.bundled_into).toBeUndefined();
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

describe('collectDeployableEvidence: evidence-gated bundling resolution (SPEC-DEPLOYABLE-DETECTION.md acceptance case)', () => {
  let projectPath: string;

  afterEach(() => {
    if (projectPath) fs.removeSync(projectPath);
  });

  test('a client app whose installer bundles a background client-service binary resolves to ONE ship unit with the service bundled_into it', () => {
    // The spec's own acceptance case (§6 worked example / §7 fixture 1): a
    // Rust multi-binary workspace with two [[bin]] crates (client,
    // client-service) and a build-installer.sh that builds+ships both. Before
    // this fix, deployable_evidence rows for "client" and "client-service"
    // were both Tier-2 `bin` candidates with no cross-reference to the
    // installer's ships_paths at all — bundled_into never populated on ANY
    // row, regardless of how positive the ships_paths signal was upstream.
    projectPath = tempProject();
    fs.writeFileSync(
      path.join(projectPath, 'Cargo.toml'),
      [
        '[workspace]',
        'members = ["client", "client-service"]',
        '',
        '[[bin]]',
        'name = "client"',
        'path = "client/src/main.rs"',
        '',
        '[[bin]]',
        'name = "client-service"',
        'path = "client-service/src/main.rs"',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(projectPath, 'build-installer.sh'),
      [
        '#!/bin/bash',
        'cargo build --release -p client',
        'cargo build --release -p client-service',
        'cp target/release/client dist/',
        'cp target/release/client-service dist/',
      ].join('\n') + '\n',
    );

    const result = collectDeployableEvidence({ projectPath, nodes: [], entryPoints: [], exitPoints: [] });

    const installer = result.find(item => item.kind === 'installer');
    expect(installer).toBeDefined();
    expect(installer!.tier).toBe(1);
    expect(installer!.ships_paths).toEqual(expect.arrayContaining(['client', 'client-service']));

    const clientBin = result.find(item => item.kind === 'bin' && item.name === 'client');
    const clientServiceBin = result.find(item => item.kind === 'bin' && item.name === 'client-service');
    expect(clientBin).toBeDefined();
    expect(clientServiceBin).toBeDefined();

    // ONE ship unit (the installer); client-service resolves as a MEMBER
    // bundled into it — never a second standalone deployable.
    expect(clientServiceBin!.bundled_into).toBe(installer!.name);
    expect(clientServiceBin!.evidence.some(e => e.includes('bundled-into'))).toBe(true);
    // "client" itself is also a member of the same installer unit; whichever
    // of the two members is chosen as PRIMARY is a downstream (workspace-
    // resolver) concern, not this collector's — the collector's job is only
    // to surface the positive bundling evidence per row.
    expect(clientBin!.bundled_into).toBe(installer!.name);
  });

  // --- installer ships_paths robustness (spec #91b): the original scrape
  // only recognized a bare `cp target/(release|debug)/<name>` on its own
  // line. Real packaging scripts use `install` and `mv` too, put multiple
  // source tokens on one invocation, and quote paths.
  describe('installer ships_paths: robust shell-token scraping', () => {
    test('`install` (not just `cp`) naming a target/release source is read as a member', () => {
      projectPath = tempProject();
      fs.writeFileSync(
        path.join(projectPath, 'Cargo.toml'),
        ['[workspace]', 'members = ["agent"]', '', '[[bin]]', 'name = "agent"', 'path = "agent/src/main.rs"', ''].join('\n'),
      );
      fs.writeFileSync(
        path.join(projectPath, 'build-installer.sh'),
        [
          '#!/bin/bash',
          'cargo build --release -p agent',
          'install -Dm755 target/release/agent "$pkgdir"/usr/bin/agent',
        ].join('\n') + '\n',
      );

      const result = collectDeployableEvidence({ projectPath, nodes: [], entryPoints: [], exitPoints: [] });
      const installer = result.find(item => item.kind === 'installer');
      expect(installer).toBeDefined();
      expect(installer!.ships_paths).toEqual(expect.arrayContaining(['agent']));
    });

    test('`mv` naming a target/debug source is read as a member', () => {
      projectPath = tempProject();
      fs.writeFileSync(
        path.join(projectPath, 'Cargo.toml'),
        ['[workspace]', 'members = ["watcher"]', '', '[[bin]]', 'name = "watcher"', 'path = "watcher/src/main.rs"', ''].join('\n'),
      );
      fs.writeFileSync(
        path.join(projectPath, 'build-installer.sh'),
        ['#!/bin/bash', 'cargo build -p watcher', 'mv target/debug/watcher dist/watcher'].join('\n') + '\n',
      );

      const result = collectDeployableEvidence({ projectPath, nodes: [], entryPoints: [], exitPoints: [] });
      const installer = result.find(item => item.kind === 'installer');
      expect(installer).toBeDefined();
      expect(installer!.ships_paths).toEqual(expect.arrayContaining(['watcher']));
    });

    test('multiple target/release source tokens on ONE cp invocation are all read as members', () => {
      projectPath = tempProject();
      fs.writeFileSync(
        path.join(projectPath, 'Cargo.toml'),
        [
          '[workspace]',
          'members = ["client", "client-service"]',
          '',
          '[[bin]]',
          'name = "client"',
          'path = "client/src/main.rs"',
          '',
          '[[bin]]',
          'name = "client-service"',
          'path = "client-service/src/main.rs"',
          '',
        ].join('\n'),
      );
      fs.writeFileSync(
        path.join(projectPath, 'build-installer.sh'),
        [
          '#!/bin/bash',
          'cargo build --release -p client',
          'cargo build --release -p client-service',
          'cp target/release/client target/release/client-service dist/',
        ].join('\n') + '\n',
      );

      const result = collectDeployableEvidence({ projectPath, nodes: [], entryPoints: [], exitPoints: [] });
      const installer = result.find(item => item.kind === 'installer');
      expect(installer).toBeDefined();
      expect(installer!.ships_paths).toEqual(expect.arrayContaining(['client', 'client-service']));
    });

    test('a quoted target/release path is read as a member, quotes stripped', () => {
      projectPath = tempProject();
      fs.writeFileSync(
        path.join(projectPath, 'Cargo.toml'),
        ['[workspace]', 'members = ["agent"]', '', '[[bin]]', 'name = "agent"', 'path = "agent/src/main.rs"', ''].join('\n'),
      );
      fs.writeFileSync(
        path.join(projectPath, 'build-installer.sh'),
        ['#!/bin/bash', 'cargo build --release -p agent', 'cp "target/release/agent" "dist/agent"'].join('\n') + '\n',
      );

      const result = collectDeployableEvidence({ projectPath, nodes: [], entryPoints: [], exitPoints: [] });
      const installer = result.find(item => item.kind === 'installer');
      expect(installer).toBeDefined();
      expect(installer!.ships_paths).toEqual(['agent']);
    });

    test('an unresolved shell variable in the source path is NOT captured as a fabricated member name', () => {
      projectPath = tempProject();
      fs.writeFileSync(
        path.join(projectPath, 'Cargo.toml'),
        ['[workspace]', 'members = ["agent"]', '', '[[bin]]', 'name = "agent"', 'path = "agent/src/main.rs"', ''].join('\n'),
      );
      fs.writeFileSync(
        path.join(projectPath, 'build-installer.sh'),
        ['#!/bin/bash', 'cargo build --release -p agent', 'cp "target/release/${BIN}" dist/'].join('\n') + '\n',
      );

      const result = collectDeployableEvidence({ projectPath, nodes: [], entryPoints: [], exitPoints: [] });
      const installer = result.find(item => item.kind === 'installer');
      // Only the resolvable `cargo build -p agent` evidence should surface a
      // member; the unresolved `${BIN}` token must never become a literal
      // "${BIN}" (or "BIN") ships_paths entry.
      expect(installer).toBeDefined();
      expect(installer!.ships_paths).toEqual(['agent']);
      expect(installer!.ships_paths).not.toEqual(expect.arrayContaining([expect.stringContaining('BIN')]));
    });
  });

  test('negative case: two sibling bin candidates with NO installer/Dockerfile referencing either stay separate (no merge on absence of evidence)', () => {
    projectPath = tempProject();
    fs.writeFileSync(
      path.join(projectPath, 'Cargo.toml'),
      [
        '[workspace]',
        'members = ["tool-a", "tool-b"]',
        '',
        '[[bin]]',
        'name = "tool-a"',
        'path = "tool-a/src/main.rs"',
        '',
        '[[bin]]',
        'name = "tool-b"',
        'path = "tool-b/src/main.rs"',
        '',
      ].join('\n'),
    );

    const result = collectDeployableEvidence({ projectPath, nodes: [], entryPoints: [], exitPoints: [] });
    const toolA = result.find(item => item.kind === 'bin' && item.name === 'tool-a');
    const toolB = result.find(item => item.kind === 'bin' && item.name === 'tool-b');
    expect(toolA).toBeDefined();
    expect(toolB).toBeDefined();
    expect(toolA!.bundled_into).toBeUndefined();
    expect(toolB!.bundled_into).toBeUndefined();
  });

  describe('Android Gradle: one ship unit, not sibling root-aggregator/module-dir rows', () => {
    function writeSingleModuleAndroidApp(projectPath: string, displayName: string): void {
      // Standard Android Studio template shape: root build.gradle.kts only
      // version-pins the plugins (never applies them), settings.gradle.kts
      // includes the single `app` module, and app/build.gradle.kts actually
      // applies com.android.application.
      fs.writeFileSync(
        path.join(projectPath, 'build.gradle.kts'),
        [
          'plugins {',
          '    id("com.android.application") version "8.2.0" apply false',
          '    id("org.jetbrains.kotlin.android") version "1.9.0" apply false',
          '}',
        ].join('\n') + '\n',
      );
      fs.writeFileSync(
        path.join(projectPath, 'settings.gradle.kts'),
        [
          `rootProject.name = "${displayName}"`,
          'include(":app")',
        ].join('\n') + '\n',
      );
      fs.mkdirpSync(path.join(projectPath, 'app', 'src', 'main'));
      fs.writeFileSync(
        path.join(projectPath, 'app', 'build.gradle.kts'),
        [
          'plugins {',
          '    id("com.android.application")',
          '    id("org.jetbrains.kotlin.android")',
          '}',
          'android {',
          '    namespace = "com.example.app"',
          '    defaultConfig {',
          '        applicationId = "com.example.app"',
          '    }',
          '}',
        ].join('\n') + '\n',
      );
      fs.writeFileSync(
        path.join(projectPath, 'app', 'src', 'main', 'AndroidManifest.xml'),
        [
          '<manifest xmlns:android="http://schemas.android.com/apk/res/android">',
          '  <application>',
          '    <activity android:name=".MainActivity">',
          '      <intent-filter>',
          '        <action android:name="android.intent.action.MAIN" />',
          '        <category android:name="android.intent.category.LAUNCHER" />',
          '      </intent-filter>',
          '    </activity>',
          '  </application>',
          '</manifest>',
        ].join('\n') + '\n',
      );
    }

    test('single-module com.android.application repo yields exactly ONE application unit named from displayName, plus root/settings/module rows bundled into it', () => {
      projectPath = tempProject();
      writeSingleModuleAndroidApp(projectPath, 'MyProductApp');

      const result = collectDeployableEvidence({
        projectPath,
        nodes: [],
        entryPoints: [],
        exitPoints: [],
        displayName: 'MyProductApp',
      });

      // Exactly one application-kind (tier 1, kind 'bin') unit, never a
      // second one for the root build.gradle.kts's `apply false` declaration.
      const appUnits = result.filter(item => item.tier === 1 && item.kind === 'bin');
      expect(appUnits).toHaveLength(1);
      expect(appUnits[0].name).toBe('MyProductApp');
      expect(appUnits[0].root_path).toBe('app');

      // The jvm.ts generic Tier-3 package-identity scan still emits rows for
      // the root build file, the settings file, and the module's own build
      // file — but they must all resolve as MEMBERS of the one app unit, not
      // stand as sibling deployables.
      const packageRows = result.filter(item => item.tier === 3 && item.kind === 'package');
      expect(packageRows.length).toBeGreaterThan(0);
      for (const row of packageRows) {
        expect(row.bundled_into).toBe('MyProductApp');
      }
    });

    test('multi-module android repo (app + 2 library modules) yields one app unit + libraries not promoted to ship units', () => {
      projectPath = tempProject();
      writeSingleModuleAndroidApp(projectPath, 'MultiModuleApp');
      // Rewrite settings to include the two extra library modules too.
      fs.writeFileSync(
        path.join(projectPath, 'settings.gradle.kts'),
        [
          'rootProject.name = "MultiModuleApp"',
          'include(":app")',
          'include(":core-ui")',
          'include(":core-data")',
        ].join('\n') + '\n',
      );
      for (const lib of ['core-ui', 'core-data']) {
        fs.mkdirpSync(path.join(projectPath, lib));
        fs.writeFileSync(
          path.join(projectPath, lib, 'build.gradle.kts'),
          ['plugins {', '    id("com.android.library")', '}'].join('\n') + '\n',
        );
      }

      const result = collectDeployableEvidence({
        projectPath,
        nodes: [],
        entryPoints: [],
        exitPoints: [],
        displayName: 'MultiModuleApp',
      });

      const appUnits = result.filter(item => item.tier === 1 && item.kind === 'bin');
      expect(appUnits).toHaveLength(1);
      expect(appUnits[0].name).toBe('MultiModuleApp');

      // Libraries stay their own tier-3 package rows, never promoted to a
      // ship unit and never bundled into the app (they are real distinct
      // modules, not aggregator duplicates of the app's own module tree).
      const coreUi = result.find(item => item.root_path === 'core-ui');
      const coreData = result.find(item => item.root_path === 'core-data');
      expect(coreUi).toBeDefined();
      expect(coreData).toBeDefined();
      expect(coreUi!.tier).toBe(3);
      expect(coreData!.tier).toBe(3);
      expect(coreUi!.bundled_into).toBeUndefined();
      expect(coreData!.bundled_into).toBeUndefined();
    });

    test('plain JVM gradle service repo (no android plugin anywhere) is unchanged: no mobile-provider rows at all', () => {
      projectPath = tempProject();
      fs.writeFileSync(
        path.join(projectPath, 'settings.gradle.kts'),
        'rootProject.name = "my-service"\n',
      );
      fs.writeFileSync(
        path.join(projectPath, 'build.gradle.kts'),
        [
          'buildscript {',
          '    dependencies {',
          '        classpath("org.springframework.boot:spring-boot-gradle-plugin:3.2.0")',
          '    }',
          '}',
          'application {',
          '    mainClass.set("com.example.Main")',
          '}',
        ].join('\n') + '\n',
      );

      const result = collectDeployableEvidence({
        projectPath,
        nodes: [],
        entryPoints: [],
        exitPoints: [],
        displayName: 'my-service',
      });

      // No Android app/library evidence of any kind should be produced.
      expect(result.some(item => item.evidence.some(e => /com\.android\.(application|library)/.test(e)))).toBe(false);
      // The Spring Boot service is still detected normally (jvm.ts unaffected).
      const serverEntry = result.find(item => item.kind === 'server-entry');
      expect(serverEntry).toBeDefined();
    });
  });

  // --- JVM (Maven): spring-boot-maven-plugin's `repackage` goal is what
  // actually produces the shippable executable jar -- it must be read as
  // ship/build evidence, the same as a Gradle `application` target or a
  // cargo [[bin]]. Before this fix, jvm.ts's Maven path classified every
  // Spring Boot module as kind:'server-entry' (an in-process route handler,
  // no build artifact of its own), which deployable-analysis.ts's
  // isBuildTargetDeclaration (tier===2 && kind==='bin') silently excludes
  // from ship-evidence qualification -- a repo whose only runnable units are
  // Spring Boot Maven services could never promote to a Deployable-Analysis
  // Workspace no matter how many independently shippable services it had.
  describe('JVM (Maven): spring-boot-maven-plugin repackage goal', () => {
    test('a Maven module with spring-boot-maven-plugin (explicit repackage execution) yields a tier-2 kind:bin row, not server-entry', () => {
      projectPath = tempProject();
      fs.writeFileSync(
        path.join(projectPath, 'pom.xml'),
        [
          '<project>',
          '  <artifactId>orders-service</artifactId>',
          '  <build>',
          '    <plugins>',
          '      <plugin>',
          '        <groupId>org.springframework.boot</groupId>',
          '        <artifactId>spring-boot-maven-plugin</artifactId>',
          '        <executions>',
          '          <execution>',
          '            <goals><goal>repackage</goal></goals>',
          '          </execution>',
          '        </executions>',
          '      </plugin>',
          '    </plugins>',
          '  </build>',
          '</project>',
        ].join('\n') + '\n',
      );

      const result = collectDeployableEvidence({
        projectPath,
        nodes: [],
        entryPoints: [],
        exitPoints: [],
        displayName: 'orders-service',
      });

      const binRow = result.find(item => item.tier === 2 && item.kind === 'bin' && item.root_path === '.');
      expect(binRow).toBeDefined();
      expect(binRow!.evidence.some(e => /repackage goal bound explicitly/.test(e))).toBe(true);
      expect(result.some(item => item.kind === 'server-entry')).toBe(false);
    });

    test('a Maven module with spring-boot-maven-plugin bare (repackage bound implicitly via spring-boot-starter-parent) still yields kind:bin', () => {
      projectPath = tempProject();
      fs.writeFileSync(
        path.join(projectPath, 'pom.xml'),
        [
          '<project>',
          '  <artifactId>billing-service</artifactId>',
          '  <parent>',
          '    <groupId>org.springframework.boot</groupId>',
          '    <artifactId>spring-boot-starter-parent</artifactId>',
          '  </parent>',
          '  <build>',
          '    <plugins>',
          '      <plugin>',
          '        <groupId>org.springframework.boot</groupId>',
          '        <artifactId>spring-boot-maven-plugin</artifactId>',
          '      </plugin>',
          '    </plugins>',
          '  </build>',
          '</project>',
        ].join('\n') + '\n',
      );

      const result = collectDeployableEvidence({
        projectPath,
        nodes: [],
        entryPoints: [],
        exitPoints: [],
        displayName: 'billing-service',
      });

      const binRow = result.find(item => item.tier === 2 && item.kind === 'bin' && item.root_path === '.');
      expect(binRow).toBeDefined();
      expect(binRow!.evidence.some(e => /default binding via spring-boot-starter-parent/.test(e))).toBe(true);
    });

    test('two Maven Spring Boot modules clear the sub-CAS promotion threshold', () => {
      projectPath = tempProject();
      for (const svc of ['orders-service', 'billing-service']) {
        fs.mkdirpSync(path.join(projectPath, svc));
        fs.writeFileSync(
          path.join(projectPath, svc, 'pom.xml'),
          [
            '<project>',
            `  <artifactId>${svc}</artifactId>`,
            '  <build>',
            '    <plugins>',
            '      <plugin>',
            '        <groupId>org.springframework.boot</groupId>',
            '        <artifactId>spring-boot-maven-plugin</artifactId>',
            '      </plugin>',
            '    </plugins>',
            '  </build>',
            '</project>',
          ].join('\n') + '\n',
        );
      }

      const result = collectDeployableEvidence({
        projectPath,
        nodes: [],
        entryPoints: [],
        exitPoints: [],
        displayName: 'multi-service',
      });

      const binRows = result.filter(item => item.tier === 2 && item.kind === 'bin');
      expect(binRows.map(r => r.name).sort()).toEqual(['billing-service', 'orders-service']);
    });
  });

  // --- Cross-provider duplicate-identity regression coverage (2026-07 hosted
  // reanalysis of a Rust cargo-workspace repo with shell + NSIS installers,
  // v1.0.111, 49 deployable rows). Real defect: the same logical service
  // surfaced as TWO unbundled top-level rows — a concrete `kind: 'bin'` row
  // from bin-targets (the Cargo `[[bin]]` name, sometimes hyphenated) and an
  // unbundled `kind: 'installer'` twin naming the identical service under a
  // squashed/hyphen-stripped or exactly-equal variant (an NSIS/installer
  // per-component identity record) — plus junk standalone units named after
  // nothing but a build script's own generic-output-shaped basename
  // ("base", "buildbinaries").
  describe('cross-provider duplicate-identity consolidation (multi-binary cargo workspace + installer twins)', () => {
    function cargoCrate(binName: string): string {
      return ['[package]', `name = "${binName}"`, 'version = "0.1.0"', '', '[[bin]]', `name = "${binName}"`, 'path = "src/main.rs"', ''].join('\n');
    }

    test('a Cargo [[bin]] crate and an installer-declared squashed/exact-name twin merge into ONE row, still bundled into the real installer head', () => {
      projectPath = tempProject();

      // Five Cargo workspace member crates — "drop-server" is the
      // hyphenated one whose installer-side twin gets squashed ("dropserver");
      // the other four have no hyphen so their twin is an EXACT name repeat.
      const crates = ['drop-server', 'client', 'coordinator', 'agent', 'gateway'];
      for (const crate of crates) {
        fs.mkdirSync(path.join(projectPath, 'crates', crate), { recursive: true });
        fs.writeFileSync(path.join(projectPath, 'crates', crate, 'Cargo.toml'), cargoCrate(crate));
      }

      // A real bundling installer script — the same shell-script-derived
      // ships_paths mechanism covered by existing tests above, referencing
      // every crate by its correct hyphenated cargo package name. This is
      // the genuine multi-member ship-unit HEAD (ships_paths.length >= 2)
      // and must remain the single surviving installer row.
      fs.mkdirSync(path.join(projectPath, 'scripts'), { recursive: true });
      fs.writeFileSync(
        path.join(projectPath, 'scripts', 'build-installer.sh'),
        crates.map(c => `cargo build --release -p ${c}`).join('\n') +
          '\n' +
          crates.map(c => `cp target/release/${c} dist/`).join('\n') +
          '\n',
      );

      // Synthetic per-component distribution-artifact nodes — the shape an
      // NSIS/installer parser emits for each referenced binary section, one
      // per crate, each naming exactly ONE thing (ships_paths.length === 1,
      // never a bundle head). "drop-server" is squashed to "dropserver"; the
      // rest repeat their bin name verbatim. Each gets its OWN source file —
      // installer.ts's cross-collector merge already collapses same-FILE
      // installer records regardless of name, so distinct files are what
      // keep these as independent per-component identity records (as
      // distinct NSIS Section blocks / per-platform scripts would be) rather
      // than trivially pre-merging before the fix under test ever runs.
      const distArtifactNode = (idSuffix: string, overrides: Record<string, any>): CASNode => ({
        id: `nsis_${idSuffix}`,
        name: `Installer component: ${idSuffix}`,
        type: 'distribution_installer',
        source: { file: `installer/sections/${idSuffix}.nsi`, line: 1 },
        metadata: {
          topology_surface: 'distribution-artifacts',
          artifact_kind: 'installer',
          distribution_role: 'installer',
          binary_names: [],
          ...overrides,
        } as any,
      });
      const nodes: CASNode[] = [
        distArtifactNode('drop_server', { product_name: 'dropserver', binary_names: ['dropserver'] }),
        distArtifactNode('client', { product_name: 'client', binary_names: ['client'] }),
        distArtifactNode('coordinator', { product_name: 'coordinator', binary_names: ['coordinator'] }),
        distArtifactNode('agent', { product_name: 'agent', binary_names: ['agent'] }),
        distArtifactNode('gateway', { product_name: 'gateway', binary_names: ['gateway'] }),
        // Junk: a build script whose own name is nothing but a generic
        // output-shaped noun / noise compound — must never mint a standalone
        // unit at all (no real ship-artifact identity).
        distArtifactNode('junk_base', { product_name: 'base' }),
        distArtifactNode('junk_buildbinaries', { product_name: 'buildbinaries' }),
      ];

      const result = collectDeployableEvidence({ projectPath, nodes, entryPoints: [], exitPoints: [] });

      // Exactly one row per crate (kind: 'bin') — no unbundled installer twin
      // survives alongside it.
      const bins = result.filter(item => item.kind === 'bin');
      expect(new Set(bins.map(b => b.name))).toEqual(new Set(crates));
      expect(bins).toHaveLength(crates.length);

      // Every bin row is bundled into the ONE real multi-member installer
      // head, including "drop-server" (which required the hyphen/squash-
      // insensitive normalization fix to match its "dropserver" ships_paths
      // twin's now-merged identity, and — independently — the head's own
      // ships_paths, which already spelled it correctly).
      for (const bin of bins) {
        expect(bin.bundled_into).toBe('build-installer');
      }

      // No standalone installer row survives for any of the five crates —
      // each per-component installer/NSIS node merged into its bin row
      // instead of standing alone.
      const installerRows = result.filter(item => item.kind === 'installer');
      expect(installerRows.map(i => i.name)).toEqual(['build-installer']);

      // Junk generic-output-noun / noise-compound names never mint a row at
      // all — not even a badly-named one.
      expect(result.some(item => item.name === 'base')).toBe(false);
      expect(result.some(item => item.name === 'buildbinaries')).toBe(false);

      // Total row count: one per crate + the one real installer head. No
      // duplicate/phantom rows.
      expect(result).toHaveLength(crates.length + 1);
    });

    function soloInstallerNode(id: string, overrides: Record<string, any>): CASNode {
      return {
        id,
        name: `Installer node: ${id}`,
        type: 'distribution_installer',
        source: { file: `installer/${id}.nsi`, line: 1 },
        metadata: {
          topology_surface: 'distribution-artifacts',
          artifact_kind: 'installer',
          distribution_role: 'installer',
          binary_names: [],
          ...overrides,
        } as any,
      };
    }

    test('an installer leaf that matches NOTHING else stays standalone (never merge on absence of evidence)', () => {
      projectPath = tempProject();
      const nodes: CASNode[] = [
        soloInstallerNode('nsis_standalone', { product_name: 'StandaloneUtility', binary_names: ['standaloneutility'] }),
      ];
      const result = collectDeployableEvidence({ projectPath, nodes, entryPoints: [], exitPoints: [] });
      const installer = result.find(item => item.kind === 'installer');
      expect(installer).toBeDefined();
      expect(installer!.name).toBe('StandaloneUtility');
      expect(installer!.bundled_into).toBeUndefined();
    });

    test('a genuine single-member installer (ships exactly one real binary) is untouched when no duplicate-named row exists', () => {
      projectPath = tempProject();
      const nodes: CASNode[] = [
        soloInstallerNode('nsis_myapp', { product_name: 'MyApp', binary_names: ['myapp.exe'] }),
      ];
      const result = collectDeployableEvidence({ projectPath, nodes, entryPoints: [], exitPoints: [] });
      const installer = result.find(item => item.kind === 'installer');
      expect(installer).toBeDefined();
      expect(installer!.name).toBe('MyApp');
      expect(installer!.ships_paths).toEqual(['myapp.exe']);
    });
  });
});

// --- Compose<->container identity join + build-stage exclusion (2026-07
// hosted CAS shape, v1.0.112: a compose-based Rust workspace). Real defect:
// each service surfaced as an UNMERGED trio (compose-service + container +
// bin), plus junk Tier-1 rows for pure build-infra Dockerfiles (a shared
// FROM base other Dockerfiles build on top of, and a multi-stage
// "build-only, copy the binaries out" builder image).
describe('collectDeployableEvidence: compose<->container identity join + build-stage exclusion', () => {
  let projectPath: string;

  afterEach(() => {
    if (projectPath) fs.removeSync(projectPath);
  });

  function serviceDockerfile(crate: string): string {
    return [
      'FROM zerac-base:latest',
      `COPY target/release/${crate} /usr/local/bin/${crate}`,
      `ENTRYPOINT ["/usr/local/bin/${crate}"]`,
    ].join('\n') + '\n';
  }

  function composeServiceNode(name: string): CASNode {
    return {
      id: `compose_service_${name}`,
      name: `Compose service: ${name}`,
      type: 'compose_service',
      source: { file: 'docker-compose.yml', line: 1 },
      metadata: {
        topology_surface: 'docker-compose',
        deployment_service_name: name,
        build: '.',
      } as any,
    };
  }

  function containerNode(dockerfileStem: string, baseImages: string[]): CASNode {
    return {
      id: `dockerfile_${dockerfileStem}`,
      name: `Docker image definition: docker/${dockerfileStem}.Dockerfile`,
      type: 'container_image_definition',
      source: { file: `docker/${dockerfileStem}.Dockerfile`, line: 1 },
      metadata: {
        topology_surface: 'dockerfile',
        base_images: baseImages,
      } as any,
    };
  }

  test('real-shape fixture: 5 compose services join 1:1 with their Dockerfiles, drop-server/dropserver merge, Base/BuildBinaries are excluded from ship units, zero junk Tier-1', () => {
    projectPath = tempProject();

    const services = ['client', 'coordinator', 'agent', 'gateway', 'drop-server'];
    const dockerfileStems: Record<string, string> = {
      client: 'Client',
      coordinator: 'Coordinator',
      agent: 'Agent',
      gateway: 'Gateway',
      'drop-server': 'DropServer', // twin naming style: compose "drop-server" <-> Dockerfile stem "DropServer"/"dropserver"
    };

    fs.mkdirpSync(path.join(projectPath, 'docker'));
    for (const svc of services) {
      fs.writeFileSync(path.join(projectPath, 'docker', `${dockerfileStems[svc]}.Dockerfile`), serviceDockerfile(svc));
    }
    fs.writeFileSync(path.join(projectPath, 'docker', 'Base.Dockerfile'), 'FROM debian:bookworm-slim\n');
    fs.writeFileSync(
      path.join(projectPath, 'docker', 'BuildBinaries.Dockerfile'),
      [
        'FROM rust:1.79 AS builder',
        'RUN cargo build --release -p coordinator',
        'RUN cargo build --release -p drop-server',
        'FROM scratch',
        'COPY --from=builder /app/target/release/coordinator /coordinator',
        'COPY --from=builder /app/target/release/drop-server /drop-server',
      ].join('\n') + '\n',
    );

    fs.writeFileSync(
      path.join(projectPath, 'Cargo.toml'),
      [
        '[package]',
        'name = "workspace"',
        'version = "0.1.0"',
        '',
        ...services.flatMap(svc => ['[[bin]]', `name = "${svc}"`, `path = "src/${svc}/main.rs"`, '']),
      ].join('\n'),
    );

    const nodes: CASNode[] = [
      ...services.map(composeServiceNode),
      ...services.map(svc => containerNode(dockerfileStems[svc], ['zerac-base:latest'])),
      containerNode('Base', ['debian:bookworm-slim']),
      containerNode('BuildBinaries', ['rust:1.79', 'scratch']),
    ];

    const result = collectDeployableEvidence({ projectPath, nodes, entryPoints: [], exitPoints: [] });

    // Exactly one Tier-1 row per real service — the compose-service/container
    // trio collapsed into ONE row, not three.
    const tier1 = result.filter(item => item.tier === 1);
    expect(tier1).toHaveLength(services.length);
    expect(new Set(tier1.map(item => item.name))).toEqual(new Set(services));
    for (const unit of tier1) {
      expect(unit.kind).toBe('compose-service');
      expect(unit.evidence.some(e => e.startsWith('compose service:'))).toBe(true);
      expect(unit.evidence.some(e => e.startsWith('Dockerfile:'))).toBe(true);
      expect(unit.evidence.some(e => e.includes('merged-container-identity'))).toBe(true);
    }

    // No junk Tier-1 row for the build-infra Dockerfiles.
    expect(tier1.some(item => item.name === 'base' || item.name === 'Base')).toBe(false);
    expect(tier1.some(item => item.name === 'buildbinaries' || item.name === 'BuildBinaries')).toBe(false);

    // Base.Dockerfile (used as FROM base, no build output of its own) is
    // excluded outright — not even a demoted row.
    expect(result.some(item => /base/i.test(item.name) && item.kind === 'container')).toBe(false);

    // BuildBinaries.Dockerfile (multi-stage builder, no runtime entrypoint,
    // builds 2 real members) is demoted to a Tier-3 build-image citation,
    // never a Tier-1 ship unit.
    const buildImage = result.find(item => item.kind === 'build-image');
    expect(buildImage).toBeDefined();
    expect(buildImage!.tier).toBe(3);
    expect(buildImage!.evidence.some(e => e.includes('coordinator') && e.includes('drop-server'))).toBe(true);

    // Every Cargo [[bin]] bundles into its OWN joined service unit.
    const bins = result.filter(item => item.kind === 'bin');
    expect(bins).toHaveLength(services.length);
    for (const bin of bins) {
      expect(bin.bundled_into).toBe(bin.name);
    }
  });

  test('negative: a compose service backed by an IMAGE (no build) never merges with an unrelated Dockerfile of the same name coincidence', () => {
    projectPath = tempProject();
    fs.mkdirpSync(path.join(projectPath, 'docker'));
    fs.writeFileSync(path.join(projectPath, 'docker', 'Worker.Dockerfile'), serviceDockerfile('worker'));

    const nodes: CASNode[] = [
      {
        id: 'compose_service_redis',
        name: 'Compose service: redis',
        type: 'compose_service',
        source: { file: 'docker-compose.yml', line: 1 },
        metadata: {
          topology_surface: 'docker-compose',
          deployment_service_name: 'redis',
          image: 'redis:7.4-alpine', // no `build:` -> pulled image, not a ship declaration
        } as any,
      },
      containerNode('Worker', ['zerac-base:latest']),
    ];

    const result = collectDeployableEvidence({ projectPath, nodes, entryPoints: [], exitPoints: [] });
    // The image-only compose service never became a row at all; the
    // unrelated "worker" container stands alone, untouched.
    expect(result.some(item => item.kind === 'compose-service')).toBe(false);
    const container = result.find(item => item.kind === 'container');
    expect(container).toBeDefined();
    expect(container!.name).toBe('worker');
  });

  test('negative: a standalone Dockerfile repo with no compose file at all is unaffected by the join/exclusion passes', () => {
    projectPath = tempProject();
    fs.writeFileSync(path.join(projectPath, 'Dockerfile'), serviceDockerfile('solo-app'));

    const nodes: CASNode[] = [
      {
        id: 'dockerfile_solo',
        name: 'Docker image definition: Dockerfile',
        type: 'container_image_definition',
        source: { file: 'Dockerfile', line: 1 },
        metadata: { topology_surface: 'dockerfile', base_images: ['zerac-base:latest'], service_aliases: ['solo-app'] } as any,
      },
    ];

    const result = collectDeployableEvidence({ projectPath, nodes, entryPoints: [], exitPoints: [] });
    const container = result.find(item => item.kind === 'container');
    expect(container).toBeDefined();
    expect(container!.tier).toBe(1);
    expect(container!.name).toBe('solo-app');
  });

  test('bin->service rebundling wins over a weaker installer-only bundle when a real compose-service unit shares the identity', () => {
    // The joined compose-service unit has no ships_paths of its own here
    // (no matching container was found to fold in), so resolveEvidenceBundling's
    // ships_paths-only pass can't use it as a bundling source at all — an
    // unrelated installer row that DOES carry positive ships_paths evidence
    // for "worker" claims the bin first. rebundleBinsIntoServiceUnits must
    // still re-point it at the real service unit by name identity.
    projectPath = tempProject();
    fs.writeFileSync(
      path.join(projectPath, 'Cargo.toml'),
      ['[package]', 'name = "workspace"', 'version = "0.1.0"', '', '[[bin]]', 'name = "worker"', 'path = "src/worker/main.rs"', ''].join('\n'),
    );

    const nodes: CASNode[] = [
      composeServiceNode('worker'),
      {
        id: 'installer_legacy',
        name: 'Installer: LegacyPackaging',
        type: 'distribution_installer',
        source: { file: 'installer/legacy.nsi', line: 1 },
        metadata: {
          topology_surface: 'distribution-artifacts',
          artifact_kind: 'installer',
          distribution_role: 'installer',
          product_name: 'LegacyPackaging',
          binary_names: ['worker'],
        } as any,
      },
    ];

    const result = collectDeployableEvidence({ projectPath, nodes, entryPoints: [], exitPoints: [] });
    const workerBin = result.find(item => item.kind === 'bin' && item.name === 'worker');
    expect(workerBin).toBeDefined();
    expect(workerBin!.bundled_into).toBe('worker');
    expect(workerBin!.bundled_into).not.toBe('LegacyPackaging');
  });
});

describe('collectDeployableEvidence: analyzer-own-fixture-directory exclusion (regression: 126 deployable_evidence units on this repo\'s own self-analysis, 2026-07 quality-iter-1)', () => {
  let projectPath: string;

  afterEach(() => {
    if (projectPath) fs.removeSync(projectPath);
  });

  function write(relative: string, content: string): void {
    const full = path.join(projectPath, relative);
    fs.ensureDirSync(path.dirname(full));
    fs.writeFileSync(full, content);
  }

  test('a real-shaped root Cargo.toml bin target still yields exactly one deployable', () => {
    projectPath = tempProject();
    write(
      'Cargo.toml',
      ['[package]', 'name = "root-service"', 'version = "0.1.0"', '', '[[bin]]', 'name = "root-service"', 'path = "src/main.rs"', ''].join('\n'),
    );
    write('src/main.rs', 'fn main() {}\n');

    const result = collectDeployableEvidence({ projectPath, nodes: [], entryPoints: [], exitPoints: [] });
    expect(result.filter(item => item.kind === 'bin' && item.name === 'root-service').length).toBe(1);
  });

  test('a build-installer.sh under fixtures/ (the analyzer\'s OWN test fixture) never mints a deployable unit', () => {
    projectPath = tempProject();
    // Real repro shape: apps/mcp-server/fixtures/deployable-detection/rust-messy-workspace/build-installer.sh
    write(
      'fixtures/deployable-detection/rust-messy-workspace/build-installer.sh',
      '#!/bin/sh\ncargo build --release -p messy-worker\ncp target/release/messy-worker /usr/local/bin/\n',
    );

    const result = collectDeployableEvidence({ projectPath, nodes: [], entryPoints: [], exitPoints: [] });
    expect(result.some(item => (item.evidence || []).some(e => e.includes('build-installer.sh')))).toBe(false);
    expect(result.length).toBe(0);
  });

  test('a Cargo.toml under __tests__/fixtures/ (the analyzer\'s OWN test fixture) never mints a deployable unit', () => {
    projectPath = tempProject();
    // Real repro shape: packages/analyzer-core/src/__tests__/fixtures/rust/actix-web-app
    write(
      '__tests__/fixtures/rust/actix-web-app/Cargo.toml',
      ['[package]', 'name = "actix-web-app"', 'version = "0.1.0"', '', '[[bin]]', 'name = "actix-web-app"', 'path = "src/main.rs"', ''].join('\n'),
    );
    write('__tests__/fixtures/rust/actix-web-app/src/main.rs', 'fn main() {}\n');

    const result = collectDeployableEvidence({ projectPath, nodes: [], entryPoints: [], exitPoints: [] });
    expect(result.length).toBe(0);
  });

  test('the same real manifest shape OUTSIDE a fixture directory is still collected (exclusion is path-scoped, not manifest-shape-scoped)', () => {
    projectPath = tempProject();
    write(
      'Cargo.toml',
      ['[package]', 'name = "real-service"', 'version = "0.1.0"', '', '[[bin]]', 'name = "real-service"', 'path = "src/main.rs"', ''].join('\n'),
    );
    write('src/main.rs', 'fn main() {}\n');

    const result = collectDeployableEvidence({ projectPath, nodes: [], entryPoints: [], exitPoints: [] });
    expect(result.some(item => item.name === 'real-service')).toBe(true);
  });

  test('a Cargo.toml bin target under __fixtures__/, testdata/, or cas-tests/ is excluded the same way', () => {
    projectPath = tempProject();
    const manifest = (name: string) =>
      ['[package]', `name = "${name}"`, 'version = "0.1.0"', '', '[[bin]]', `name = "${name}"`, 'path = "src/main.rs"', ''].join('\n');
    write('__fixtures__/svc/Cargo.toml', manifest('fixtures-svc'));
    write('__fixtures__/svc/src/main.rs', 'fn main() {}\n');
    write('testdata/svc2/Cargo.toml', manifest('testdata-svc'));
    write('testdata/svc2/src/main.rs', 'fn main() {}\n');
    write('cas-tests/svc3/Cargo.toml', manifest('cas-tests-svc'));
    write('cas-tests/svc3/src/main.rs', 'fn main() {}\n');
    // One real one at the root, to prove the walk itself still runs.
    write('Cargo.toml', manifest('root-svc'));
    write('src/main.rs', 'fn main() {}\n');

    const result = collectDeployableEvidence({ projectPath, nodes: [], entryPoints: [], exitPoints: [] });
    expect(result.some(item => item.name === 'fixtures-svc')).toBe(false);
    expect(result.some(item => item.name === 'testdata-svc')).toBe(false);
    expect(result.some(item => item.name === 'cas-tests-svc')).toBe(false);
    expect(result.some(item => item.name === 'root-svc')).toBe(true);
  });
});
