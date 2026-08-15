import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import { getAgentContext } from './agent-adoption';
import { buildOperationalPriorities } from './product';
import { ingestTelemetryBatch, loadTelemetryObservations, type TelemetryEvent } from './telemetry-ingestion';

interface BenchmarkGate {
  id: string;
  status: 'pass' | 'fail';
  detail: string;
}

interface RuntimeImpactBenchmarkReport {
  generated_at: string;
  status: 'pass' | 'fail';
  score: number;
  duration_ms: number;
  summary: {
    ingested_events: number;
    matched_events: number;
    baseline_static_top: string;
    runtime_top_file: string;
    runtime_top_score: number;
    capsule_estimated_tokens: number;
    full_context_estimated_tokens: number;
    token_reduction_percentage: number;
  };
  gates: BenchmarkGate[];
  top_priorities: any[];
  capsule_sample: string;
}

export async function runRuntimeImpactBenchmark(options: { outputPath?: string; markdownPath?: string } = {}): Promise<RuntimeImpactBenchmarkReport> {
  const startedAt = Date.now();
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-runtime-impact-'));
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-runtime-impact-storage-'));
  const previousStorage = process.env.KLAURO_STORAGE_PATH;
  const previousProfile = process.env.KLAURO_AGENT_CONTEXT_PROFILE;
  const gates: BenchmarkGate[] = [];

  process.env.KLAURO_STORAGE_PATH = storage;

  try {
    await seedRuntimeImpactProject(workspace);
    const cas = buildRuntimeImpactCas(workspace);
    const telemetry = buildRuntimeImpactTelemetry();
    const ingestion = await ingestTelemetryBatch(cas, workspace, telemetry, { persist: true });
    const stored = await loadTelemetryObservations(workspace, { source: 'ingested', limit: 5000 });
    const priorities = buildOperationalPriorities(cas, stored.observations, { limit: 5 });
    const top = priorities.priorities[0];
    const baselineStaticTop = 'src/checkout/checkout.service.ts';
    const runtimeTopFile = top?.static_target?.file || '';

    gates.push(gate(
      'runtime-impact:telemetry-correlates',
      ingestion.event_count === telemetry.length && ingestion.correlation_summary.matched >= telemetry.length - 1,
      `${ingestion.correlation_summary.matched}/${telemetry.length} events matched`
    ));
    gates.push(gate(
      'runtime-impact:reorders-static-guess',
      runtimeTopFile.endsWith('src/exports/invoice-export.service.ts') && runtimeTopFile !== baselineStaticTop,
      `static baseline ${baselineStaticTop}; runtime top ${runtimeTopFile || 'missing'}`
    ));
    gates.push(gate(
      'runtime-impact:top-is-ingested',
      top?.source === 'ingested' && top.runtime.errors >= 6 && top.runtime.estimated_volume >= 1000,
      top ? `${top.source}, ${top.runtime.errors} errors, volume ${top.runtime.estimated_volume}` : 'missing priority'
    ));

    process.env.KLAURO_AGENT_CONTEXT_PROFILE = 'standard';
    const fullContext = await getAgentContext(cas, workspace, {
      task_type: 'debug',
      target: 'what bugs should I address today',
      instructions: 'Use production telemetry to pick the most impactful bug, then preserve local idioms and tests.',
    }) as any;

    const capsuleContext = await getAgentContext(cas, workspace, {
      task_type: 'debug',
      target: 'what bugs should I address today',
      instructions: 'Use production telemetry to pick the most impactful bug, then preserve local idioms and tests.',
      response_profile: 'capsule-only',
    }) as any;

    const fullContextEstimatedTokens = estimateTokens(JSON.stringify(fullContext));
    const capsuleEstimatedTokens = Number(capsuleContext.estimated_tokens || estimateTokens(`${capsuleContext.context_capsule}\n${capsuleContext.execution_capsule}`));
    const tokenReduction = percentReduction(fullContextEstimatedTokens, capsuleEstimatedTokens);
    const fullPriorityFile = fullContext.work_context?.operational_priorities?.priorities?.[0]?.static_target?.file || '';
    const capsuleText = `${capsuleContext.context_capsule || ''}\n${capsuleContext.execution_capsule || ''}`;

    gates.push(gate(
      'runtime-impact:work-context-carries-priority',
      fullPriorityFile.endsWith('src/exports/invoice-export.service.ts'),
      `agent context top priority ${fullPriorityFile || 'missing'}`
    ));
    gates.push(gate(
      'runtime-impact:capsule-carries-priority',
      /invoice-export\.service\.ts/.test(capsuleText) && /ops critical runtime\b/.test(capsuleText),
      capsuleText.slice(0, 220).replace(/\s+/g, ' ')
    ));
    gates.push(gate(
      'runtime-impact:capsule-token-reduction',
      tokenReduction >= 70 && capsuleEstimatedTokens <= 350,
      `${tokenReduction}% reduction, ${capsuleEstimatedTokens} capsule tokens vs ${fullContextEstimatedTokens} full tokens`
    ));

    const passed = gates.filter(item => item.status === 'pass').length;
    const report: RuntimeImpactBenchmarkReport = {
      generated_at: new Date().toISOString(),
      status: passed === gates.length ? 'pass' : 'fail',
      score: Math.round((passed / gates.length) * 100),
      duration_ms: Date.now() - startedAt,
      summary: {
        ingested_events: ingestion.event_count,
        matched_events: ingestion.correlation_summary.matched,
        baseline_static_top: baselineStaticTop,
        runtime_top_file: runtimeTopFile,
        runtime_top_score: Number(top?.priority_score || 0),
        capsule_estimated_tokens: capsuleEstimatedTokens,
        full_context_estimated_tokens: fullContextEstimatedTokens,
        token_reduction_percentage: tokenReduction,
      },
      gates,
      top_priorities: priorities.priorities.slice(0, 3),
      capsule_sample: capsuleText.slice(0, 900),
    };

    if (options.outputPath) {
      await fs.ensureDir(path.dirname(options.outputPath));
      await fs.writeJson(options.outputPath, report, { spaces: 2 });
    }
    if (options.markdownPath) {
      await fs.ensureDir(path.dirname(options.markdownPath));
      await fs.writeFile(options.markdownPath, renderMarkdown(report));
    }
    return report;
  } finally {
    if (previousStorage === undefined) delete process.env.KLAURO_STORAGE_PATH;
    else process.env.KLAURO_STORAGE_PATH = previousStorage;
    if (previousProfile === undefined) delete process.env.KLAURO_AGENT_CONTEXT_PROFILE;
    else process.env.KLAURO_AGENT_CONTEXT_PROFILE = previousProfile;
    await fs.remove(workspace);
    await fs.remove(storage);
  }
}

async function seedRuntimeImpactProject(workspace: string): Promise<void> {
  await fs.outputJson(path.join(workspace, 'package.json'), {
    scripts: { test: 'vitest run', typecheck: 'tsc --noEmit' },
  });
  await fs.outputFile(path.join(workspace, 'src/checkout/checkout.service.ts'), 'export class CheckoutService { async submitCheckout() {} }\n');
  await fs.outputFile(path.join(workspace, 'src/exports/invoice-export.service.ts'), 'export class InvoiceExportService { async runInvoiceExport() {} }\n');
  await fs.outputFile(path.join(workspace, 'src/search/search.controller.ts'), 'export class SearchController { async search() {} }\n');
  await fs.outputFile(path.join(workspace, 'tests/invoice-export.service.test.ts'), 'test("exports invoices", () => {});\n');
}

function buildRuntimeImpactCas(workspace: string): CASOutput {
  return {
    cas_version: '1.10.0',
    analysis_timestamp: new Date().toISOString(),
    analysis_id: 'analysis-runtime-impact-benchmark',
    system: {
      id: 'runtime-impact-system',
      name: 'Runtime Impact Fixture',
      type: 'service',
      root_path: workspace,
      description: 'Fixture for runtime impact prioritization.',
    },
    nodes: [
      node('node-checkout-service', 'CheckoutService', 'service', 'src/checkout/checkout.service.ts', 1),
      node('node-invoice-export-service', 'InvoiceExportService', 'service', 'src/exports/invoice-export.service.ts', 1),
      node('node-search-controller', 'SearchController', 'controller', 'src/search/search.controller.ts', 1),
      node('node-invoice-export-test', 'InvoiceExportService test', 'test', 'tests/invoice-export.service.test.ts', 1),
    ],
    edges: [
      { id: 'edge-test-export', source: 'node-invoice-export-test', target: 'node-invoice-export-service', type: 'tests' },
    ],
    entry_points: [
      entry('entry-checkout-submit', 'POST /checkout', 'node-checkout-service', 'POST', '/checkout', 'src/checkout/checkout.service.ts'),
      entry('entry-invoice-export', 'POST /exports/invoices', 'node-invoice-export-service', 'POST', '/exports/invoices', 'src/exports/invoice-export.service.ts'),
      entry('entry-search', 'GET /search', 'node-search-controller', 'GET', '/search', 'src/search/search.controller.ts'),
    ],
    runtime_static_links: [
      runtimeLink('runtime-checkout-submit', 'entry-checkout-submit', 'http:POST:/checkout', 'src/checkout/checkout.service.ts:1'),
      runtimeLink('runtime-invoice-export', 'entry-invoice-export', 'http:POST:/exports/invoices', 'src/exports/invoice-export.service.ts:1'),
      runtimeLink('runtime-search', 'entry-search', 'http:GET:/search', 'src/search/search.controller.ts:1'),
    ],
    test_suites: [{
      id: 'suite-invoice-export',
      name: 'InvoiceExportService',
      file_path: 'tests/invoice-export.service.test.ts',
      test_type: 'unit',
      tests: [{ id: 'test-invoice-export', name: 'exports invoices', test_type: 'unit', assertions: [] }],
    }] as any,
    codebase_idioms: [{
      id: 'idiom-services',
      category: 'testing',
      name: 'Services get focused tests',
      description: 'Service changes should add or update a focused service test.',
      confidence: 0.9,
      prevalence: 1,
      evidence: [{ type: 'file', file: 'tests/invoice-export.service.test.ts', description: 'focused service test' }],
      positive_examples: [{ idiom_id: 'idiom-services', name: 'InvoiceExportService test', file: 'tests/invoice-export.service.test.ts', line: 1, explanation: 'focused test' }],
      affected_scopes: { files: ['src/exports/invoice-export.service.ts'], file_globs: ['src/**/*.service.ts'], node_ids: ['node-invoice-export-service'], node_types: ['service'] },
      agent_guidance: {
        do: ['Update the focused service test when changing service behavior.'],
        avoid: ['Do not patch production behavior without matching test evidence.'],
        validation: ['Run validate_codebase_idioms after edits.'],
      },
      deviations: [],
    }] as any,
    behavioral_invariants: [{
      id: 'invariant-export-scope',
      name: 'Invoice export preserves account scope',
      invariant_type: 'authorization',
      description: 'Invoice exports must preserve account scope before producing files.',
      confidence: 'high',
      scope: { file_paths: ['src/exports/invoice-export.service.ts'], node_ids: ['node-invoice-export-service'] },
      enforcement: [{ type: 'service', file: 'src/exports/invoice-export.service.ts', node_id: 'node-invoice-export-service', description: 'service checks scope' }],
      evidence: [{ source: 'node', id: 'node-invoice-export-service', file: 'src/exports/invoice-export.service.ts', line: 1 }],
      related_tests: ['tests/invoice-export.service.test.ts'],
      related_boundaries: [],
      related_entities: [],
      gaps: [],
    }] as any,
    system_health: {
      score: 72,
      status: 'watch',
      summary: 'Checkout is statically risky, but runtime telemetry may shift operational priority.',
      risk_areas: [{
        id: 'risk-checkout-static',
        type: 'critical-path',
        severity: 'high',
        title: 'Checkout is a statically critical path',
        description: 'Checkout has high static business risk.',
        affected_nodes: ['node-checkout-service', 'entry-checkout-submit'],
        evidence: ['checkout route'],
        recommendation: 'Inspect checkout before broad auth or payment changes.',
        agent_guidance: 'Use runtime telemetry before assuming checkout is today’s top bug.',
      }],
      coherence: {
        status: 'coherent',
        paradigm_count: 1,
        primary_paradigms: ['Service Layer'],
        conflicting_paradigms: [],
        naming_convention_violations: 0,
        dependency_injection_violations: 0,
        module_boundary_violations: 0,
        duplication_signals: 0,
      },
      remediation: { immediate: [], agent_rules: [], validation_tools: [] },
    } as any,
    change_risks: [{
      node_id: 'entry-checkout-submit',
      risk_level: 'high',
      risk_factors: [{ factor: 'revenue-path', severity: 'high', details: 'Checkout is revenue critical.' }],
      downstream_impact: { direct_callers: [], transitive_callers: [], affected_call_chains: [], affected_entry_points: ['entry-checkout-submit'] },
      test_protection: { has_direct_tests: false, has_integration_tests: false },
      stability_context: { recent_churn: true, commit_count_30d: 4, bug_fix_density: 1 },
      recommendations: ['Add checkout regression tests before risky edits.'],
    }] as any,
    change_risk_summary: {
      high_risk_nodes: ['entry-checkout-submit'],
      untested_critical_paths: ['entry-checkout-submit'],
      recent_hotspots: [],
    },
    capabilities: [
      capability('cap-checkout', 'Checkout submission', 'Submits checkout requests for paid orders.', 'entry-checkout-submit', ['checkout'], 'critical'),
      capability('cap-invoice-export', 'Invoice export', 'Exports invoice packages for finance operations.', 'entry-invoice-export', ['finance', 'exports'], 'high'),
      capability('cap-search', 'Search', 'Searches records for operators.', 'entry-search', ['search'], 'medium'),
    ] as any,
    analyzer_contributions: [],
    progressive_levels: { levels: {}, level_definitions: [] } as any,
    analysis_errors: [],
  } as unknown as CASOutput;
}

function buildRuntimeImpactTelemetry(): TelemetryEvent[] {
  const now = Date.now();
  const events: TelemetryEvent[] = [];
  events.push({
    kind: 'error',
    timestamp: new Date(now - 90_000).toISOString(),
    method: 'POST',
    route: '/checkout',
    status: 500,
    duration_ms: 420,
    trace_id: 'trace-checkout-1',
    span_id: 'span-checkout-1',
    file_hint: 'src/checkout/checkout.service.ts',
    function_hint: 'CheckoutService',
    volume: 2,
    error: {
      type: 'PaymentProviderTimeout',
      message: 'Payment provider timed out once',
      stack_top_frames: [{ file: 'src/checkout/checkout.service.ts', line: 1, function: 'CheckoutService' }],
    },
  });

  for (let index = 0; index < 8; index += 1) {
    events.push({
      kind: 'error',
      timestamp: new Date(now - index * 15_000).toISOString(),
      method: 'POST',
      route: '/exports/invoices',
      status: 500,
      duration_ms: 1400 + index * 40,
      trace_id: `trace-export-${index}`,
      span_id: `span-export-${index}`,
      file_hint: 'src/exports/invoice-export.service.ts',
      function_hint: 'InvoiceExportService',
      volume: 180,
      error: {
        type: 'InvoiceExportScopeError',
        message: 'Invoice export dropped account scope',
        stack_top_frames: [{ file: 'src/exports/invoice-export.service.ts', line: 1, function: 'InvoiceExportService' }],
      },
    });
  }

  for (let index = 0; index < 4; index += 1) {
    events.push({
      kind: 'request',
      timestamp: new Date(now - index * 20_000).toISOString(),
      method: 'GET',
      route: '/search',
      status: 200,
      duration_ms: 1500 + index * 100,
      trace_id: `trace-search-${index}`,
      span_id: `span-search-${index}`,
      file_hint: 'src/search/search.controller.ts',
      function_hint: 'SearchController',
      volume: 90,
    });
  }
  return events;
}

function node(id: string, name: string, type: string, file: string, line: number) {
  return { id, name, type, category: type === 'test' ? 'test' : 'code', source: { file, line, end_line: line + 5 } };
}

function entry(id: string, name: string, sourceNode: string, method: string, route: string, file: string) {
  return {
    id,
    name,
    type: 'http',
    source_node: sourceNode,
    trigger: { method, path: route },
    handler: { node_id: sourceNode, method_name: name, file, line: 1 },
  };
}

function runtimeLink(id: string, staticId: string, signal: string, point: string) {
  return {
    id,
    kind: 'entry-point',
    static_id: staticId,
    runtime_signal: signal,
    telemetry_status: 'observed',
    confidence: 0.95,
    instrumentation_points: [point],
    evidence: [{ kind: 'route', source: signal, confidence: 0.95 }],
  };
}

function capability(id: string, name: string, description: string, entryPointId: string, domains: string[], criticality: string) {
  return {
    id,
    name,
    description,
    category: 'core',
    operations: [{ entry_point_id: entryPointId, entry_point_type: 'http', action: name, path_or_command: entryPointId }],
    related_entities: [],
    related_domains: domains,
    criticality,
    criticality_factors: domains,
  };
}

function gate(id: string, condition: boolean, detail: string): BenchmarkGate {
  return { id, status: condition ? 'pass' : 'fail', detail };
}

function estimateTokens(value: string): number {
  return Math.max(1, Math.ceil(Buffer.byteLength(value || '') / 4));
}

function percentReduction(baseline: number, current: number): number {
  return Math.round(((baseline - current) / Math.max(1, baseline)) * 1000) / 10;
}

function renderMarkdown(report: RuntimeImpactBenchmarkReport): string {
  return [
    '# Runtime Impact Benchmark',
    '',
    `Status: ${report.status} (${report.score}/100)`,
    '',
    '## Summary',
    '',
    `- Ingested events: ${report.summary.ingested_events}`,
    `- Matched events: ${report.summary.matched_events}`,
    `- Static-only top: ${report.summary.baseline_static_top}`,
    `- Runtime top: ${report.summary.runtime_top_file}`,
    `- Token reduction: ${report.summary.token_reduction_percentage}%`,
    '',
    '## Gates',
    '',
    ...report.gates.map(item => `- ${item.status.toUpperCase()} ${item.id}: ${item.detail}`),
  ].join('\n');
}

if (require.main === module) {
  const outputPath = process.argv.includes('--output')
    ? process.argv[process.argv.indexOf('--output') + 1]
    : '';
  const markdownPath = process.argv.includes('--markdown')
    ? process.argv[process.argv.indexOf('--markdown') + 1]
    : '';
  runRuntimeImpactBenchmark({ outputPath, markdownPath })
    .then(report => {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      if (report.status !== 'pass') process.exitCode = 1;
    })
    .catch(error => {
      process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
