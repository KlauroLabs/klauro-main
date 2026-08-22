import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { classifyAnalysisProfile } from './analysis-profile';
import { attachCasProjection } from './cas-projection';

test('analysis profile does not classify an unloaded graph projection as an empty codebase', () => {
  const cas = attachCasProjection({
    system: {
      name: 'Projected API',
      type: 'api',
      technologies: { frameworks: [{ name: 'NestJS' }] },
    },
    nodes: [],
    edges: [],
    entry_points: [{ id: 'http', type: 'http', name: 'GET /health' }],
    analyzer_contributions: [],
  } as any, {
    loaded_sections: ['identity', 'supplemental'],
    node_count: 62_375,
    edge_count: 114_765,
  });

  const profile = classifyAnalysisProfile(cas, '/tmp/projected-api');

  assert.equal(profile.kind, 'backend-service');
  assert.notEqual(profile.kind, 'empty');
});

test('analysis profile ignores fixture mobile code when classifying a product repo', () => {
  const cas: any = {
    nodes: [
      {
        id: 'orchestrator',
        name: 'AnalyzerOrchestrator',
        type: 'class',
        source: { file: 'packages/analyzer-core/src/analyzer/core/orchestrator.ts' },
        metadata: { language: 'typescript' },
      },
      {
        id: 'fixture-mobile',
        name: 'HomeScreen',
        type: 'mobile_screen',
        source: { file: 'packages/analyzer-core/src/__tests__/fixtures/flutter/lib/home.dart' },
        metadata: { language: 'dart' },
      },
    ],
    edges: [],
    entry_points: [
      {
        id: 'cli',
        type: 'cli',
        name: 'klauro',
        source_node: 'orchestrator',
        handler: { file: 'apps/mcp-server/src/cli.ts' },
      },
      {
        id: 'fixture-page',
        type: 'page',
        name: 'Home',
        source_node: 'fixture-mobile',
        handler: { file: 'packages/analyzer-core/src/__tests__/fixtures/flutter/lib/home.dart' },
      },
    ],
    system: {
      type: 'service',
      technologies: {
        languages: [{ name: 'TypeScript/JavaScript' }, { name: 'Dart/Flutter' }],
        frameworks: [{ name: 'Flutter' }],
      },
    },
  };

  const profile = classifyAnalysisProfile(cas, '/Users/michaelshattuck/dev/unravl/proof-of-concept');

  assert.notEqual(profile.kind, 'mobile-app');
  assert.equal(profile.kind, 'cli-tool');
});

test('analysis profile treats Electron apps as desktop apps before embedded HTTP/frontend dependencies', () => {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-electron-profile-'));
  try {
    fs.writeFileSync(path.join(projectPath, 'electron.vite.config.ts'), 'export default {};');
    fs.writeFileSync(path.join(projectPath, 'package.json'), JSON.stringify({
      name: 'desktop-client',
      main: './out/main/index.js',
      dependencies: {
        electron: '^26.0.0',
        express: '^4.18.0',
        react: '^18.2.0',
      },
      devDependencies: {
        'electron-vite': '^1.0.0',
      },
    }));

    const cas: any = {
      nodes: [
        {
          id: 'main',
          name: 'ElectronMain',
          type: 'class',
          source: { file: 'src/main/index.ts' },
          metadata: { language: 'typescript' },
        },
        {
          id: 'embedded-server',
          name: 'LocalServer',
          type: 'class',
          source: { file: 'src/main/local-server.ts' },
          metadata: { language: 'typescript', framework: 'Express' },
        },
      ],
      edges: [],
      entry_points: [
        {
          id: 'health',
          type: 'http',
          name: 'GET /health',
          source_node: 'embedded-server',
          handler: { file: 'src/main/local-server.ts' },
        },
      ],
      system: {
        type: 'application',
        technologies: {
          languages: [{ name: 'TypeScript/JavaScript' }],
          frameworks: [{ name: 'Express' }, { name: 'React' }],
        },
      },
    };

    const profile = classifyAnalysisProfile(cas, projectPath);

    assert.equal(profile.kind, 'desktop-app');
    assert.match(profile.evidence.join(' '), /desktop/i);
  } finally {
    fs.rmSync(projectPath, { recursive: true, force: true });
  }
});

test('analysis profile does not classify a repo as desktop-app just because source mentions electron', () => {
  // Klauro-self regression: an analyzer product whose source SUPPORTS Electron apps
  // (node names/files mention electron) is not itself a desktop app.
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-analyzer-profile-'));
  try {
    fs.writeFileSync(path.join(projectPath, 'package.json'), JSON.stringify({
      name: 'analyzer-monorepo',
      dependencies: { express: '^4.18.0' },
    }));

    const cas: any = {
      nodes: [
        {
          id: 'electron-analyzer',
          name: 'ElectronAnalyzer',
          type: 'class',
          source: { file: 'src/analyzer/frameworks/electron-analyzer.ts' },
          metadata: { language: 'typescript', framework: 'Express' },
        },
        {
          id: 'controller',
          name: 'AnalysisController',
          type: 'controller',
          source: { file: 'src/analysis.controller.ts' },
          metadata: { language: 'typescript', framework: 'Express' },
        },
      ],
      edges: [],
      entry_points: [
        {
          id: 'analyze-route',
          type: 'http',
          name: 'POST /analyze',
          source_node: 'controller',
          handler: { file: 'src/analysis.controller.ts' },
        },
      ],
      system: {
        type: 'application',
        technologies: {
          languages: [{ name: 'TypeScript/JavaScript' }],
          frameworks: [{ name: 'Express' }],
        },
      },
    };

    const profile = classifyAnalysisProfile(cas, projectPath);

    assert.notEqual(profile.kind, 'desktop-app');
    assert.equal(profile.kind, 'backend-service');
  } finally {
    fs.rmSync(projectPath, { recursive: true, force: true });
  }
});

test('analysis profile does not treat generic desktop wording as a desktop app signal', () => {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-web-profile-'));
  try {
    fs.writeFileSync(path.join(projectPath, 'package.json'), JSON.stringify({
      name: 'secure-access-portal',
      dependencies: {
        express: '^4.18.0',
        react: '^18.2.0',
      },
    }));

    const cas: any = {
      nodes: [
        {
          id: 'controller',
          name: 'AccessController',
          type: 'controller',
          source: { file: 'backend/access.controller.ts' },
          metadata: { language: 'typescript', framework: 'Express' },
        },
        {
          id: 'landing',
          name: 'DesktopAccessPage',
          type: 'component',
          source: { file: 'ui/src/DesktopAccessPage.tsx' },
          metadata: { language: 'typescript', framework: 'React' },
        },
      ],
      edges: [],
      entry_points: [
        {
          id: 'access-route',
          type: 'http',
          name: 'GET /access',
          source_node: 'controller',
          handler: { file: 'backend/access.controller.ts' },
        },
      ],
      system: {
        type: 'application',
        technologies: {
          languages: [{ name: 'TypeScript/JavaScript' }],
          frameworks: [{ name: 'Express' }, { name: 'React' }],
        },
      },
    };

    const profile = classifyAnalysisProfile(cas, projectPath);

    assert.notEqual(profile.kind, 'desktop-app');
    assert.equal(profile.kind, 'backend-service');
  } finally {
    fs.rmSync(projectPath, { recursive: true, force: true });
  }
});

test('analysis profile does not treat backend preload wording as desktop evidence', () => {
  const cas: any = {
    nodes: [
      {
        id: 'controller',
        name: 'PreloadController',
        type: 'controller',
        source: { file: 'src/Controller/PreloadController.php' },
        metadata: { language: 'php', framework: 'Symfony' },
      },
      {
        id: 'worker',
        name: 'MessageConsumer',
        type: 'service',
        source: { file: 'src/Message/MessageConsumer.php' },
        metadata: { language: 'php', framework: 'Symfony' },
      },
    ],
    edges: [],
    entry_points: [
      {
        id: 'preload-route',
        type: 'http',
        name: 'GET /preload',
        source_node: 'controller',
        handler: { file: 'src/Controller/PreloadController.php' },
      },
      {
        id: 'consumer',
        type: 'message',
        name: 'MessageConsumer',
        source_node: 'worker',
        handler: { file: 'src/Message/MessageConsumer.php' },
      },
    ],
    system: {
      type: 'service',
      technologies: {
        languages: [{ name: 'PHP' }],
        frameworks: [{ name: 'Symfony' }],
      },
    },
  };

  const profile = classifyAnalysisProfile(cas, '/tmp/truckspyapp');

  assert.equal(profile.kind, 'backend-service');
});

test('analysis profile keeps Flutter mobile apps ahead of desktop-like view names', () => {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-flutter-profile-'));
  try {
    fs.writeFileSync(path.join(projectPath, 'pubspec.yaml'), 'name: mobile_app\ndependencies:\n  flutter:\n    sdk: flutter\n');

    const cas: any = {
      nodes: [
        {
          id: 'main',
          name: 'main.dart',
          type: 'file',
          source: { file: 'lib/main.dart' },
          metadata: { language: 'dart' },
        },
        {
          id: 'screen',
          name: 'DesktopModeScreen',
          type: 'mobile_screen',
          source: { file: 'lib/views/desktop_mode_screen.dart' },
          metadata: { language: 'dart' },
        },
      ],
      edges: [],
      entry_points: [
        {
          id: 'app-start',
          type: 'lifecycle',
          name: 'Flutter start',
          source_node: 'main',
          handler: { file: 'lib/main.dart' },
        },
      ],
      system: {
        type: 'application',
        technologies: {
          languages: [{ name: 'Dart/Flutter' }],
          frameworks: [{ name: 'Flutter' }],
        },
      },
    };

    const profile = classifyAnalysisProfile(cas, projectPath);

    assert.equal(profile.kind, 'mobile-app');
  } finally {
    fs.rmSync(projectPath, { recursive: true, force: true });
  }
});

test('analysis profile treats WPF/XAML applications as desktop before worker entry points', () => {
  const cas: any = {
    nodes: [
      {
        id: 'program',
        name: 'Program',
        type: 'class',
        source: { file: 'Hoggan.Windows.Presentation/Program.cs' },
        metadata: { language: 'C#' },
      },
      {
        id: 'patient-window',
        name: 'PatientWindow',
        type: 'class',
        source: { file: 'Hoggan.Windows.Presentation/PatientWindow.xaml.cs' },
        metadata: { language: 'C#' },
      },
      {
        id: 'measurement-viewmodel',
        name: 'MeasurementViewModel',
        type: 'class',
        source: { file: 'Hoggan.Windows.Presentation/ViewModels/MeasurementViewModel.cs' },
        metadata: { language: 'C#' },
      },
    ],
    edges: [],
    entry_points: [
      {
        id: 'schedule',
        type: 'schedule',
        name: 'Nightly sync',
        source_node: 'program',
        handler: { file: 'Hoggan.Windows.Presentation/Program.cs' },
      },
      {
        id: 'cli',
        type: 'cli',
        name: 'Program.Main',
        source_node: 'program',
        handler: { file: 'Hoggan.Windows.Presentation/Program.cs' },
      },
    ],
    system: {
      type: 'application',
      technologies: {
        languages: [{ name: 'C#/.NET' }],
        frameworks: [{ name: '.NET Host' }],
      },
    },
  };

  const profile = classifyAnalysisProfile(cas, '/tmp/HogganScientific-Rebuild');

  assert.equal(profile.kind, 'desktop-app');
  assert.match(profile.evidence.join(' '), /desktop/i);
});

test('analysis profile treats nested Terraform stacks as infrastructure', () => {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-nested-terraform-profile-'));
  try {
    fs.mkdirSync(path.join(projectPath, 'platform', 'production'), { recursive: true });
    fs.writeFileSync(path.join(projectPath, '.terraform-version'), '1.9.0\n');
    fs.writeFileSync(path.join(projectPath, 'platform', 'production', 'ecs.tf'), 'resource "aws_ecs_cluster" "main" {}\n');

    const cas: any = {
      nodes: [
        {
          id: 'ecs',
          name: 'aws_ecs_cluster.main',
          type: 'infrastructure_resource',
          source: { file: 'platform/production/ecs.tf' },
          metadata: { language: 'terraform' },
        },
      ],
      edges: [],
      entry_points: [],
      system: {
        type: 'infrastructure',
        technologies: {
          languages: [{ name: 'Terraform' }],
          frameworks: [{ name: 'Terraform' }],
        },
      },
    };

    const profile = classifyAnalysisProfile(cas, projectPath);

    assert.equal(profile.kind, 'infrastructure');
  } finally {
    fs.rmSync(projectPath, { recursive: true, force: true });
  }
});

test('analysis profile ignores generated Klauro proof workspaces embedded in a repo', () => {
  const cas: any = {
    nodes: [
      {
        id: 'cli',
        name: 'AnalyzeCommand',
        type: 'function',
        source: { file: 'src/cli.ts' },
        metadata: { language: 'typescript' },
      },
      {
        id: 'generated-react-page',
        name: 'DashboardPage',
        type: 'component',
        source: { file: '.klauro-existing-task-live-ui/run/with-klauro/src/pages/DashboardPage.tsx' },
        metadata: { language: 'typescript', framework: 'React' },
      },
    ],
    edges: [],
    entry_points: [
      {
        id: 'cli-entry',
        type: 'cli',
        name: 'analyze',
        source_node: 'cli',
        handler: { file: 'src/cli.ts' },
      },
      {
        id: 'generated-route',
        type: 'page',
        name: 'Dashboard',
        source_node: 'generated-react-page',
        handler: { file: '.klauro-existing-task-live-ui/run/with-klauro/src/pages/DashboardPage.tsx' },
      },
    ],
    system: {
      type: 'package',
      technologies: {
        languages: [{ name: 'TypeScript/JavaScript' }],
        frameworks: [{ name: 'React' }],
      },
    },
  };

  const profile = classifyAnalysisProfile(cas, '/Users/michaelshattuck/dev/unravl/proof-of-concept');

  assert.equal(profile.kind, 'cli-tool');
  assert.match(profile.evidence.join(' '), /CLI/i);
});
