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

  test('Tier 1: Dockerfile node yields a container candidate with ships_paths from base images', () => {
    projectPath = tempProject();
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
    expect(container!.ships_paths).toEqual(['node:22-alpine']);
    expect(container!.ports).toEqual([3000]);
    expect(container!.evidence.some(e => e.includes('Dockerfile'))).toBe(true);
  });

  test('Tier 1: compose service node yields a compose-service candidate', () => {
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
          image: 'nginx:latest',
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
});
