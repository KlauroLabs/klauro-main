import test from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import {
  assessAnalysisQuality,
  buildMachinePerformanceDiagnostics,
  defaultMachineProofWorkRoot,
  machineProofAnalysisFocus,
  normalizeMachineProofOptions,
  selectEligibleReposForMachineProof,
  type ParsedArgs,
} from './machine-gauntlet';
import { defaultIncrementalBenchmarkWorkRoot } from './incremental-benchmark';
import { defaultLiveTrialWorkRoot } from './agent-live-trial';
import type { RealRepoTarget } from './repo-discovery';

test('fast machine proof defaults to a bounded resource profile', () => {
  const options = normalizeMachineProofOptions(baseOptions({ mode: 'fast' }));

  assert.equal(options.mode, 'fast');
  assert.equal(options.maxTargets, 8);
  assert.equal(options.maxSourceFiles, 2500);
  assert.equal(options.runLive, false);
  assert.equal(options.analysisConcurrency, 1);
  assert.equal(options.incrementalConcurrency, 1);
  assert.equal(options.analysisPath, 'klauro-product');
  assert.equal(options.inFlightPath, 'klauro-product');
  assert.equal(options.analysisBudgetMs, 30_000);
  assert.equal(options.incrementalBudgetMs, 30_000);
  assert.equal(machineProofAnalysisFocus(options), 'agent-fast');
});

test('proof scratch workspaces default outside durable Klauro storage', () => {
  const tempRoot = os.tmpdir();

  assert.equal(defaultMachineProofWorkRoot('machine-test').startsWith(tempRoot), true);
  assert.equal(defaultIncrementalBenchmarkWorkRoot().startsWith(tempRoot), true);
  assert.equal(defaultLiveTrialWorkRoot().startsWith(tempRoot), true);
  assert.equal(defaultMachineProofWorkRoot('machine-test').includes('/.klauro'), false);
});

test('machine proof defaults to fast mode when callers omit mode', () => {
  const options = normalizeMachineProofOptions(baseOptions());

  assert.equal(options.mode, 'fast');
  assert.equal(options.maxTargets, 8);
  assert.equal(options.maxSourceFiles, 2500);
  assert.equal(options.runLive, false);
});

test('full machine proof remains explicit and comprehensive by default', () => {
  const options = normalizeMachineProofOptions(baseOptions({ mode: 'full' }));

  assert.equal(options.mode, 'full');
  assert.equal(options.maxTargets, undefined);
  assert.equal(options.maxSourceFiles, undefined);
  assert.equal(options.runLive, true);
  assert.equal(options.analysisPath, 'klauro-product');
  assert.equal(options.inFlightPath, 'klauro-product');
  assert.equal(options.analysisBudgetMs, 120_000);
  assert.equal(options.incrementalBudgetMs, 120_000);
  assert.equal(machineProofAnalysisFocus(options), 'agent-fast');
});

test('machine proof still allows explicit harness paths for development', () => {
  const options = normalizeMachineProofOptions(baseOptions({
    mode: 'fast',
    analysisPath: 'in-process-harness',
    inFlightPath: 'isolated-harness',
  }));

  assert.equal(options.analysisPath, 'in-process-harness');
  assert.equal(options.inFlightPath, 'isolated-harness');
});

test('machine proof selection reports all repos but only analyzes budgeted fast targets', () => {
  const options = normalizeMachineProofOptions(baseOptions({ mode: 'fast', maxTargets: 2, maxSourceFiles: 100 }));
  const selected = selectEligibleReposForMachineProof([
    repo('small-a', 10),
    repo('huge', 5000),
    repo('small-b', 20),
    repo('small-c', 30),
  ], options);

  assert.deepEqual(selected.map(item => item.name), ['small-a', 'small-b']);
});

test('machine proof selection can start from later eligible batches after size filtering', () => {
  const options = normalizeMachineProofOptions(baseOptions({
    mode: 'fast',
    startIndex: 2,
    maxTargets: 2,
    maxSourceFiles: 100,
  }));
  const selected = selectEligibleReposForMachineProof([
    repo('small-a', 10),
    repo('huge', 5000),
    repo('small-b', 20),
    repo('small-c', 30),
    repo('small-d', 40),
  ], options);

  assert.deepEqual(selected.map(item => item.name), ['small-c', 'small-d']);
});

test('machine analysis quality grounds short proper nouns in technologies', () => {
  const quality = assessAnalysisQuality({
    system: {
      name: 'user-service',
      technologies: {
        languages: [{ name: 'C#' }],
        frameworks: [{ name: 'ASP.NET Core' }],
      },
    },
    enhanced_system_purpose: {
      primary_domain: 'user-identity-management',
      core_concepts: ['identity', 'security', 'password'],
      inferred_description: 'A user identity management system built with .NET host, .NET, and ASP.NET Core that coordinates identity and security workflows. It is exercised through HTTP endpoints, message handlers, and lifecycle entry points.',
      description_generation: { status: 'ai_skipped' },
    },
    domain_concepts: [{ name: 'identity' }, { name: 'security' }],
    capabilities: [
      { name: 'Identity Management' },
      { name: 'Password Management' },
    ],
    entry_points: [{ name: 'LoginController', type: 'http' }],
    nodes: [{ name: 'LoginController', type: 'controller', source: { file: 'src/Controllers/LoginController.cs' } }],
    architecture_summary: {
      architectural_patterns: [],
      architectural_inventory: {},
      pattern_balance: { status: 'balanced' },
    },
  }, '/tmp/dev/user-service');

  assert.equal(quality.status, 'pass');
  assert.doesNotMatch(quality.failures.join('\n'), /unexplained short proper-noun/);
});

test('machine analysis quality grounds product identity from first-party CAS evidence', () => {
  const quality = assessAnalysisQuality({
    system: { name: 'storefront-theme' },
    enhanced_system_purpose: {
      primary_domain: 'commerce-storefront',
      core_concepts: ['product', 'cart', 'collection'],
      first_party_product_evidence: {
        title: { value: 'Dawn', source: 'README.md' },
        overview: { value: 'A storefront theme for commerce catalogs.', source: 'README.md' },
      },
      inferred_description: 'Dawn enables users to browse products and manage carts across a commerce storefront. When shoppers choose products, the theme preserves cart state for checkout.',
      description_generation: { status: 'ai_applied' },
    },
    domain_concepts: [{ name: 'product' }, { name: 'cart' }],
    capabilities: [{ name: 'Browse products' }, { name: 'Manage carts' }],
    entry_points: [{ name: 'ProductPage', type: 'page' }],
    nodes: [{ name: 'ProductPage', type: 'component', source: { file: 'sections/product.liquid' } }],
    architecture_summary: {
      architectural_patterns: [],
      architectural_inventory: {},
      pattern_balance: { status: 'balanced' },
    },
  }, '/tmp/dev/storefront-theme');

  assert.doesNotMatch(quality.failures.join('\n'), /unexplained short proper-noun/);
});

test('machine analysis quality accepts rich architectures when pattern balance names primary patterns', () => {
  const patterns = [
    'MVC',
    'Layered Architecture',
    'Client SDK / API Wrapper',
    'MVVM',
    'Feature Modules',
    'Unit of Work',
    'Service Layer',
    'Repository',
    'Mediator / Handler',
    'Component/Page UI',
    'Command Script / Automation',
    'Singleton / Registry',
  ].map((name, index) => ({
    name,
    confidence: index < 9 ? 0.8 : 0.55,
  }));

  const quality = assessAnalysisQuality({
    system: { name: 'clinical-desktop', technologies: { frameworks: [{ name: 'WPF' }] } },
    nodes: Array.from({ length: 120 }, (_, index) => ({ id: `node-${index}`, name: `Node${index}`, type: 'service' })),
    enhanced_system_purpose: {
      primary_domain: 'clinical-testing',
      core_concepts: ['patient', 'measurement', 'clinical report'],
      inferred_description: 'A clinical testing desktop system that coordinates patient records, clinical measurements, device connectivity, and reporting workflows for care teams and test operators.',
      description_generation: { status: 'ai_skipped' },
    },
    domain_concepts: [{ name: 'patient' }, { name: 'measurement' }],
    capabilities: [{ name: 'Clinical Measurements' }, { name: 'Patient Records' }],
    architecture_summary: {
      architectural_patterns: patterns,
      architectural_inventory: {
        controllers: ['controller'],
        models: ['model'],
        views: ['view'],
        view_models: ['view-model'],
        repositories: ['repository'],
        mediators: ['mediator'],
        unit_of_work: ['unit-of-work'],
        singletons: ['registry'],
      },
      pattern_balance: {
        status: 'balanced',
        primary_patterns: patterns.slice(0, 6).map(pattern => pattern.name),
        rationale: 'Detected patterns share a layered or module backbone.',
      },
    },
  }, '/tmp/dev/clinical-desktop');

  assert.equal(quality.status, 'pass');
  assert.doesNotMatch(quality.failures.join('\n'), /pattern splurge/);
  assert.doesNotMatch(quality.warnings.join('\n'), /many supporting architectural patterns/);
});

test('machine performance diagnostics surface slow and weak-token outliers without hiding passing proof', () => {
  const diagnostics = buildMachinePerformanceDiagnostics(
    [
      { name: 'large-analysis', path: '/tmp/dev/large-analysis', analysis_ms: 70_000, cas: { nodes: 1200 }, source_files: 400 },
      { name: 'small-analysis', path: '/tmp/dev/small-analysis', analysis_ms: 900, cas: { nodes: 12 }, source_files: 4 },
    ],
    {
      targets: [
        {
          name: 'slow-proof-harness',
          original_path: '/tmp/dev/slow-proof-harness',
          timings: {
            isolated_child_wall_ms: 75_000,
            copy_repo_ms: 58_000,
            edit_loop_wall_ms: 900,
            initial_full_ms: 52_000,
            edit_incremental_ms: 600,
          },
          speedups: { edit_incremental_vs_full: 86.67 },
          output_summary: { nodes: 48_000, tracked_files: 3_000 },
          agent_value_after_edit: {
            estimated_search_token_reduction_percentage: 99,
            estimated_context_tokens: 2_500,
            estimated_total_context_tokens: 3_500,
            estimated_search_baseline_tokens: 900_000,
          },
        },
        {
          name: 'slow-incremental',
          original_path: '/tmp/dev/slow-incremental',
          timings: {
            isolated_child_wall_ms: 75_000,
            edit_loop_wall_ms: 66_000,
            initial_full_ms: 120_000,
            edit_incremental_ms: 65_000,
          },
          speedups: { edit_incremental_vs_full: 1.85 },
          output_summary: { nodes: 48_000, tracked_files: 3_000 },
          agent_value_after_edit: {
            estimated_search_token_reduction_percentage: 99,
            estimated_context_tokens: 7_500,
            estimated_total_context_tokens: 8_500,
            estimated_search_baseline_tokens: 900_000,
          },
        },
        {
          name: 'tiny-token-margin',
          original_path: '/tmp/dev/tiny-token-margin',
          timings: {
            isolated_child_wall_ms: 2_000,
            edit_loop_wall_ms: 200,
            initial_full_ms: 500,
            edit_incremental_ms: 100,
          },
          speedups: { edit_incremental_vs_full: 5 },
          output_summary: { nodes: 80, tracked_files: 12 },
          agent_value_after_edit: {
            estimated_search_token_reduction_percentage: 12,
            estimated_context_tokens: 1_800,
            estimated_total_context_tokens: 2_400,
            estimated_search_baseline_tokens: 2_700,
          },
        },
      ],
    },
    { analysisBudgetMs: 120_000, incrementalBudgetMs: 120_000 }
  );

  assert.equal(diagnostics.status, 'watch');
  assert.equal(diagnostics.counts.slow_analysis_repos, 1);
  assert.equal(diagnostics.counts.slow_proof_harness_repos, 2);
  assert.equal(diagnostics.counts.slow_incremental_repos, 1);
  assert.equal(diagnostics.counts.slow_edit_loop_repos, 1);
  assert.equal(diagnostics.counts.weak_token_reduction_repos, 1);
  assert.equal(diagnostics.counts.large_context_repos, 1);
  assert.equal(diagnostics.slow_proof_harness_repos[0].name, 'slow-proof-harness');
  assert.equal(diagnostics.slow_incremental_repos[0].name, 'slow-incremental');
  assert.equal(diagnostics.weak_token_reduction_repos[0].name, 'tiny-token-margin');
  assert.ok(diagnostics.recommendations.some((item: string) => /tiny|narrow/i.test(item)));
});

function baseOptions(overrides: Partial<ParsedArgs> = {}): ParsedArgs {
  return {
    devRoot: '/tmp/dev',
    outputPath: '/tmp/report.json',
    markdownPath: '/tmp/report.md',
    runLive: true,
    discardWorkspaces: true,
    ...overrides,
  };
}

function repo(name: string, sourceFiles: number): RealRepoTarget {
  return {
    name,
    path: `/tmp/dev/${name}`,
    status: 'eligible',
    supported: true,
    languages: ['TypeScript'],
    manifests: ['package.json'],
    source_files: sourceFiles,
  };
}
