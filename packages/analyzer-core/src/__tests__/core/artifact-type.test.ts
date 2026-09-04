import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import {
  classifyArtifactType,
  artifactLedDomainLabel,
  collectArtifactManifestSignal,
  type ArtifactTypeInput,
} from '../../analyzer/core/artifact-type';

function node(name: string, file: string, metadata: Record<string, any> = {}): ArtifactTypeInput['nodes'][number] {
  return { name, type: 'class', source: { file }, metadata };
}

function input(overrides: Partial<ArtifactTypeInput>): ArtifactTypeInput {
  return {
    nodes: [],
    entryPointSummary: [],
    exitPoints: [],
    frameworks: [],
    manifest: {},
    ...overrides,
  };
}

describe('classifyArtifactType', () => {
  test('Cargo lib target without binaries is a library (ztray shape)', () => {
    const result = classifyArtifactType(input({
      manifest: {
        cargo: {
          description: 'A pure Rust system tray implementation',
          hasLibSection: false,
          hasBinTarget: false,
          hasLibFile: true,
          hasMainFile: false,
          dependencyNames: ['image', 'tokio', 'thiserror'],
        },
      },
      nodes: [node('Icon', 'src/lib.rs', { is_exported: true }), node('Menu', 'src/menu.rs', { is_exported: true })],
    }));
    expect(result.artifactType).toBe('library');
    expect(result.evidence.join(' ')).toMatch(/Cargo lib target/);
  });

  test('Cargo workspace library ignores example HTTP entry points (axum shape)', () => {
    const result = classifyArtifactType(input({
      manifest: {
        cargo: {
          description: undefined,
          hasLibSection: false,
          hasBinTarget: false,
          hasLibFile: false,
          hasMainFile: false,
          isWorkspace: true,
          dependencyNames: [],
        },
        readmeLead: '# axum\n\naxum is an HTTP routing and request-handling library focused on ergonomics.',
      },
      nodes: [
        node('Router', 'axum/src/lib.rs', { is_exported: true }),
        node('ExampleHandler', 'examples/chat/src/main.rs'),
      ],
      entryPointSummary: [{ type: 'http', count: 87 }],
    }));
    expect(result.artifactType).toBe('library');
    expect(result.evidence.join(' ')).toMatch(/Cargo workspace README declares a library/);
  });

  test('Cargo crate with src/main.rs stays app', () => {
    const result = classifyArtifactType(input({
      manifest: {
        cargo: {
          hasLibSection: false,
          hasBinTarget: false,
          hasLibFile: true,
          hasMainFile: true,
          dependencyNames: [],
        },
      },
    }));
    expect(result.artifactType).toBe('app');
  });

  test('WSDL-generated SOAP client is a client-sdk (wex-client-php shape)', () => {
    const result = classifyArtifactType(input({
      manifest: {
        composer: {
          name: 'truckspy/wex-client',
          description: 'WEX PHP Client for TruckSpy',
          type: 'library',
          requireNames: ['php', 'ext-soap'],
        },
        readmeLead: '# wex-client-php\n\nRun `make generate` to build WEX client',
      },
      nodes: [
        node('CardManagementWS', 'src/Client/Soap/CardManagement/CardManagementWS.php'),
        node('CarrierGroupWS', 'src/Client/Soap/CarrierGroup/CarrierGroupWS.php'),
        node('IssueCard', 'src/Client/Soap/CardManagement/IssueCard.php'),
        node('CardOrder', 'src/Client/Soap/CardManagement/CardOrder.php'),
      ],
      exitPoints: [{ type: 'api', name: 'WEX SOAP service' }],
    }));
    expect(result.artifactType).toBe('client-sdk');
    expect(result.protocol).toBe('soap');
  });

  test('client-sdk verdict requires absence of app entry points', () => {
    const result = classifyArtifactType(input({
      manifest: {
        composer: { type: 'library', requireNames: ['php', 'ext-soap'] },
      },
      nodes: [
        node('PaymentsClient', 'src/Client/Soap/PaymentsClient.php'),
        node('OrdersWS', 'src/Client/Soap/OrdersWS.php'),
        node('OrderType', 'src/Client/Soap/OrderType.php'),
      ],
      entryPointSummary: [{ type: 'http', count: 12 }],
      exitPoints: [{ type: 'api', name: 'SOAP' }],
    }));
    expect(result.artifactType).not.toBe('client-sdk');
  });

  test('README boilerplate self-declaration wins even with page entry points (WashUp-React shape)', () => {
    const result = classifyArtifactType(input({
      manifest: {
        packageJson: {
          name: 'my-app-name',
          isPrivate: true,
          hasBin: false,
          hasLibraryEntry: false,
          dependencyNames: ['react', 'react-router-dom', '@tanstack/react-query'],
        },
        readmeLead: '# 🚀 Modern React Boilerplate\n\nA production-ready React application boilerplate with advanced data handling.',
      },
      frameworks: ['React'],
      entryPointSummary: [{ type: 'page', count: 6 }, { type: 'route', count: 8 }],
    }));
    expect(result.artifactType).toBe('boilerplate');
  });

  test('app with starter wording only in package description stays app when it has page entries', () => {
    const result = classifyArtifactType(input({
      manifest: {
        packageJson: {
          name: 'customer-portal',
          description: 'Built from an internal React starter template for customer operations.',
          isPrivate: true,
          hasBin: false,
          hasLibraryEntry: false,
          dependencyNames: ['react', 'react-router-dom'],
        },
      },
      frameworks: ['React'],
      entryPointSummary: [{ type: 'page', count: 10 }, { type: 'route', count: 12 }],
    }));
    expect(result.artifactType).toBe('app');
  });

  test('starter wording in package description still classifies non-app templates as boilerplate', () => {
    const result = classifyArtifactType(input({
      manifest: {
        packageJson: {
          name: 'shared-template',
          description: 'Reusable starter template for internal packages.',
          isPrivate: true,
          hasBin: false,
          hasLibraryEntry: false,
          dependencyNames: [],
        },
      },
    }));
    expect(result.artifactType).toBe('boilerplate');
  });

  test('a repository whose manifest name is the detected framework is that framework (library), even with example HTTP entries', () => {
    const result = classifyArtifactType(input({
      manifest: {
        packageJson: {
          name: 'express',
          description: 'Fast, unopinionated, minimalist web framework',
          isPrivate: false,
          hasBin: false,
          hasLibraryEntry: false,
          dependencyNames: ['body-parser', 'debug'],
        },
      },
      frameworks: ['Express'],
      entryPointSummary: [{ type: 'http', count: 40 }],
    }));
    expect(result.artifactType).toBe('library');
    expect(result.evidence[0]).toMatch(/is the detected framework "Express"/);
  });

  test('a composer package whose vendor matches the framework is NOT self-named (vendor is organization identity)', () => {
    const result = classifyArtifactType(input({
      manifest: {
        composer: { name: 'laravel/nova', description: 'Administration panel.', type: 'project', requireNames: ['laravel/framework'] },
      },
      frameworks: ['Laravel'],
      entryPointSummary: [{ type: 'http', count: 12 }],
    }));
    expect(result.artifactType).toBe('app');
  });

  test('a description whose subject is the scaffold phrase declares boilerplate even with routes (framework skeleton shape)', () => {
    const result = classifyArtifactType(input({
      manifest: {
        composer: { name: 'laravel/laravel', description: 'The skeleton application for the Laravel framework.', type: 'project', requireNames: ['laravel/framework'] },
      },
      frameworks: ['Laravel'],
      entryPointSummary: [{ type: 'http', count: 6 }],
    }));
    expect(result.artifactType).toBe('boilerplate');
    expect(result.evidence[0]).toMatch(/composer.json description declares "skeleton"/);
  });

  test('a python package manifest with public nodes and no scripts or entry points is a library (web-framework package shape)', () => {
    const publicNodes = ['FastAPI', 'APIRouter', 'Depends', 'Body', 'BackgroundTasks'].map(name => node(name, 'pkg/core.py', { access_modifier: 'public' }));
    const result = classifyArtifactType(input({
      manifest: { pythonSetup: { description: 'FastAPI framework, high performance, easy to learn', hasConsoleScripts: false, dependencyNames: ['starlette', 'pydantic'] } },
      nodes: publicNodes,
    }));
    expect(result.artifactType).toBe('library');
    const withRoutes = classifyArtifactType(input({
      manifest: { pythonSetup: { description: 'Shop backend', hasConsoleScripts: false, dependencyNames: ['fastapi'] } },
      nodes: publicNodes,
      entryPointSummary: [{ type: 'http', count: 12 }],
    }));
    expect(withRoutes.artifactType).toBe('app');
    const withCompanionCli = classifyArtifactType(input({
      manifest: { pythonSetup: { description: 'FastAPI framework', hasConsoleScripts: true, dependencyNames: ['starlette', 'typer'] } },
      nodes: publicNodes,
    }));
    expect(withCompanionCli.artifactType).toBe('library');
    expect(withCompanionCli.evidence[0]).toMatch(/companion CLI/);
  });

  test('python console_scripts + click is a cli-tool (yisda-cli shape)', () => {
    const result = classifyArtifactType(input({
      manifest: {
        pythonSetup: {
          description: 'A CLI tool for managing the Yisda system',
          hasConsoleScripts: true,
          dependencyNames: ['click'],
        },
      },
      entryPointSummary: [{ type: 'cli', count: 4 }],
    }));
    expect(result.artifactType).toBe('cli-tool');
  });

  test('cli entry points without any manifest CLI marker stay app', () => {
    const result = classifyArtifactType(input({
      entryPointSummary: [{ type: 'cli', count: 2 }],
      manifest: {
        packageJson: { isPrivate: true, hasBin: false, hasLibraryEntry: false, dependencyNames: ['express'] },
      },
    }));
    expect(result.artifactType).toBe('app');
  });

  test('package.json publish surface without app framework or entries is a library', () => {
    const result = classifyArtifactType(input({
      manifest: {
        packageJson: {
          name: 'date-fns-lite',
          isPrivate: false,
          hasBin: false,
          hasLibraryEntry: true,
          dependencyNames: [],
        },
      },
      nodes: Array.from({ length: 6 }, (_, i) => node(`format${i}`, `src/format${i}.ts`, { is_exported: true })),
    }));
    expect(result.artifactType).toBe('library');
  });

  test('server app with http entry points and express stays app (truckspyapp/washup control)', () => {
    const result = classifyArtifactType(input({
      manifest: {
        packageJson: {
          name: 'washup-server',
          isPrivate: true,
          hasBin: false,
          hasLibraryEntry: true,
          dependencyNames: ['express', 'typeorm'],
        },
        readmeLead: '# WashUp\n\nCar wash operations backend.',
      },
      frameworks: ['Express', 'TypeORM'],
      entryPointSummary: [{ type: 'http', count: 42 }],
      exitPoints: [{ type: 'database', name: 'postgres' }],
      nodes: Array.from({ length: 10 }, (_, i) => node(`Service${i}`, `src/service${i}.ts`, { is_exported: true })),
    }));
    expect(result.artifactType).toBe('app');
  });

  test('multi-surface deployment repository is infrastructure, not a CLI tool or app', () => {
    const result = classifyArtifactType(input({
      nodes: [
        { ...node('Queue', 'main.tf'), type: 'terraform_resource' },
        { ...node('Deployment', 'k8s/deployment.yaml'), type: 'kubernetes_deployment' },
        { ...node('Container', 'Dockerfile'), type: 'dockerfile' },
      ],
      entryPointSummary: [{ type: 'cli', count: 1 }, { type: 'file', count: 1 }],
    }));
    expect(result.artifactType).toBe('infrastructure');
    expect(result.evidence.join(' ')).toMatch(/container.*kubernetes.*terraform/);
  });
});

describe('artifactLedDomainLabel', () => {
  test('library label leads with top non-generic concept tokens (tray-icon-library style)', () => {
    const label = artifactLedDomainLabel(
      { artifactType: 'library', evidence: [] },
      ['A pure Rust system tray implementation', 'icon', 'menu management'],
      []
    );
    expect(label).toBe('tray-icon-library');
  });

  test('soap client-sdk gets soap-client-library', () => {
    const label = artifactLedDomainLabel(
      { artifactType: 'client-sdk', evidence: [], protocol: 'soap', generated: true },
      ['order management', 'card management'],
      []
    );
    expect(label).toBe('soap-client-library');
  });

  test('boilerplate label uses framework qualifier (react-boilerplate)', () => {
    const label = artifactLedDomainLabel(
      { artifactType: 'boilerplate', evidence: [] },
      ['commerce operations'],
      ['React', 'Redux Toolkit']
    );
    expect(label).toBe('react-boilerplate');
  });

  test('app and cli-tool do not get artifact-led labels', () => {
    expect(artifactLedDomainLabel({ artifactType: 'app', evidence: [] }, ['orders'], [])).toBeNull();
    expect(artifactLedDomainLabel({ artifactType: 'cli-tool', evidence: [] }, ['services'], [])).toBeNull();
  });

  test('library with only generic concepts falls back to utility-library', () => {
    const label = artifactLedDomainLabel(
      { artifactType: 'library', evidence: [] },
      ['user management', 'data utils'],
      []
    );
    expect(label).toBe('utility-library');
  });
});

describe('collectArtifactManifestSignal', () => {
  test('reads Cargo lib shape and README lead from disk', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-type-test-'));
    try {
      fs.writeFileSync(path.join(dir, 'Cargo.toml'), [
        '[package]',
        'name = "ztray"',
        'description = "A pure Rust system tray implementation"',
        '',
        '[dependencies]',
        'image = "0.25.5"',
        'tokio = { version = "1.0" }',
      ].join('\n'));
      fs.mkdirpSync(path.join(dir, 'src'));
      fs.writeFileSync(path.join(dir, 'src', 'lib.rs'), 'pub mod menu;');
      fs.writeFileSync(path.join(dir, 'README.md'), '# ztray\n\nA tray icon library.');

      const signal = collectArtifactManifestSignal(dir);
      expect(signal.cargo).toMatchObject({
        description: 'A pure Rust system tray implementation',
        hasLibFile: true,
        hasMainFile: false,
        hasBinTarget: false,
      });
      expect(signal.cargo?.dependencyNames).toEqual(expect.arrayContaining(['image', 'tokio']));
      expect(signal.readmeLead).toContain('tray icon library');
    } finally {
      fs.removeSync(dir);
    }
  });

  test('missing manifests contribute nothing and do not throw', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-type-empty-'));
    try {
      const signal = collectArtifactManifestSignal(dir);
      expect(signal).toEqual({});
    } finally {
      fs.removeSync(dir);
    }
  });
});
