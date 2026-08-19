import * as fs from 'node:fs';
import * as path from 'node:path';
import { analyzeForBench } from './gauntlet/product-analysis';
import { evaluateAgentReadiness, getAgentContext, getAgentStartContext } from './agent-adoption';
import { buildSummary, getCodingContext } from './query';

interface SelfDogfoodOptions {
  projectPath: string;
  target: string;
  output?: string;
}

function parseOptions(argv: string[]): SelfDogfoodOptions {
  const projectPath = path.resolve(argv[0] || '.');
  const targetIndex = argv.indexOf('--target');
  const outputIndex = argv.indexOf('--output');
  return {
    projectPath,
    target: targetIndex >= 0 ? argv[targetIndex + 1] : 'participant-in-flight-store',
    output: outputIndex >= 0 ? path.resolve(argv[outputIndex + 1]) : undefined,
  };
}

function payloadMetrics(value: unknown) {
  const bytes = Buffer.byteLength(JSON.stringify(value));
  return { bytes, estimated_tokens: Math.ceil(bytes / 4) };
}

function sourceFile(value: any): string | null {
  return value?.file || value?.source?.file || null;
}

async function run(options: SelfDogfoodOptions) {
  const timings: Record<string, number> = {};
  let startedAt = Date.now();
  const cas = await analyzeForBench(options.projectPath);
  timings.analysis_ms = Date.now() - startedAt;
  const task = {
    task_type: 'modify' as const,
    target: options.target,
    instructions: `Locate and understand ${options.target} before broad source inspection.`,
  };
  startedAt = Date.now();
  const readiness = evaluateAgentReadiness(cas, options.projectPath);
  timings.readiness_ms = Date.now() - startedAt;
  startedAt = Date.now();
  const standardStart = getAgentStartContext(cas, options.projectPath, task);
  timings.standard_start_ms = Date.now() - startedAt;
  startedAt = Date.now();
  const firstTurnStart = getAgentStartContext(cas, options.projectPath, { ...task, response_profile: 'first-turn' });
  timings.first_turn_start_ms = Date.now() - startedAt;
  startedAt = Date.now();
  const agentContext = await getAgentContext(cas, options.projectPath, { ...task, response_profile: 'first-turn' }) as any;
  timings.agent_context_ms = Date.now() - startedAt;
  startedAt = Date.now();
  const codingContext = getCodingContext(cas, options.target) as any;
  timings.coding_context_ms = Date.now() - startedAt;
  startedAt = Date.now();
  const summary = buildSummary(cas);
  timings.summary_ms = Date.now() - startedAt;
  const expectedFileSuffix = `${options.target}.ts`;
  const agentFile = sourceFile(agentContext.selected) || sourceFile(agentContext.selected_node);
  const codingFile = sourceFile(codingContext.target_node);
  const diagnosticCodes = (cas.analysis_errors || []).map(error => error.code).filter(Boolean);
  const standardMetrics = payloadMetrics(standardStart);
  const firstTurnMetrics = payloadMetrics(firstTurnStart);
  const checks = {
    structural_agent_context: readiness.agent_context_ready,
    canonical_comprehension: readiness.comprehension_ready,
    analysis_only_understanding: readiness.analysis_only_understanding_ready,
    cli_claim_integrity: !diagnosticCodes.includes('ZERO_NODES_FOR_CLAIMED_FILES'),
    agent_target: Boolean(agentFile?.endsWith(expectedFileSuffix) && !/\.(test|spec)\./i.test(agentFile)),
    coding_target: Boolean(codingFile?.endsWith(expectedFileSuffix) && !/\.(test|spec)\./i.test(codingFile)),
    first_turn_budget: firstTurnMetrics.bytes < standardMetrics.bytes * 0.6,
  };
  const report = {
    generated_at: new Date().toISOString(),
    project_path: options.projectPath,
    target: options.target,
    timings,
    passed: Object.values(checks).every(Boolean),
    checks,
    analysis: {
      nodes: cas.nodes.length,
      edges: cas.edges.length,
      entry_points: cas.entry_points?.length || 0,
      diagnostics: diagnosticCodes,
      diagnostic_details: cas.analysis_errors || [],
    },
    readiness: {
      status: readiness.status,
      score: readiness.score,
      agent_context_ready: readiness.agent_context_ready,
      comprehension_ready: readiness.comprehension_ready,
      analysis_only_understanding_ready: readiness.analysis_only_understanding_ready,
      comprehension: readiness.comprehension,
      gaps: readiness.adoption_gaps,
    },
    payloads: {
      standard_start: standardMetrics,
      first_turn_start: firstTurnMetrics,
      agent_context: payloadMetrics(agentContext),
      coding_context: payloadMetrics(codingContext),
    },
    selected: {
      agent: agentContext.selected || agentContext.selected_node || null,
      coding: codingContext.target_node || null,
      files: agentContext.files || agentContext.file_read_plan || [],
    },
    top_capabilities: summary.top_capabilities,
    structural_capabilities: (cas.structural_capability_candidates || []).slice(0, 12).map(capability => ({
      name: capability.name,
      description: capability.description,
      category: capability.category,
      operations: capability.operations.length,
    })),
  };

  if (options.output) {
    fs.mkdirSync(path.dirname(options.output), { recursive: true });
    fs.writeFileSync(options.output, `${JSON.stringify(report, null, 2)}\n`);
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.passed) process.exitCode = 1;
}

run(parseOptions(process.argv.slice(2))).catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exitCode = 1;
});
