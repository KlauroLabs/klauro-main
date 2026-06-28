import * as fs from 'fs-extra';
import * as path from 'path';
import { getAnalysisFocusProfiles, withAnalysisFocus, type AnalysisFocus } from './analysis-focus';
import { isDirectCliInvocation } from './cli-invocation';

type GateStatus = 'pass' | 'fail';

interface BenchmarkGate {
  id: string;
  status: GateStatus;
  detail: string;
}

interface FocusSnapshot {
  focus: AnalysisFocus;
  token_policy: string;
  cost_tier: string;
  enabled_layers: string[];
  deferred_layers: string[];
  env: Record<string, string | null>;
  estimated_core_work_units: number;
  estimated_optional_work_units: number;
  estimated_total_work_units: number;
  optional_work_reduction_vs_enriched_percent: number;
  total_work_reduction_vs_enriched_percent: number;
}

interface AnalysisFocusBenchmarkReport {
  generated_at: string;
  benchmark_type: 'analysis-focus-layer-proof';
  status: GateStatus;
  score: number;
  summary: {
    enriched_total_work_units: number;
    enriched_optional_work_units: number;
    agent_fast_total_work_units: number;
    agent_fast_optional_work_units: number;
    agent_fast_total_reduction_percent: number;
    agent_fast_optional_reduction_percent: number;
    ui_overview_optional_work_units: number;
    deep_context_optional_work_units: number;
  };
  gates: BenchmarkGate[];
  routing: Array<{
    trigger: string;
    task_type?: string;
    recommended_focus: string;
    recommended_layer: string | null;
    token_policy: string;
  }>;
  profiles: FocusSnapshot[];
}

const FOCUS_ENV_KEYS = [
  'KLAURO_ANALYSIS_FOCUS',
  'KLAURO_AI_INTERPRETATION',
  'KLAURO_AI_INTERPRETATION_FORCE',
  'KLAURO_AI_INTERPRETATION_ALLOW_DETERMINISTIC_KEEP',
  'KLAURO_AI_INTERPRETATION_BUDGET_MS',
  'KLAURO_AI_ELEMENT_DESCRIPTION_BUDGET_MS',
  'KLAURO_AI_ELEMENT_DESCRIPTION_BATCH_SIZE',
  'KLAURO_AI_ELEMENT_DESCRIPTION_LIMIT',
  'KLAURO_AI_ELEMENT_DESCRIPTIONS',
  'KLAURO_EMBEDDING_ENABLED',
  'KLAURO_OLLAMA_AUTO',
  'OLLAMA_BASE_URL',
  'OLLAMA_MODEL',
] as const;

const CORE_WORK_UNITS = 100;
const LAYER_COSTS = {
  aiSystemNarrative: 35,
  aiPrimaryCapabilityDescriptions: 25,
  aiLazyElementDescriptions: 100,
  semanticEmbeddings: 45,
};

const ENRICHED_OPTIONAL_WORK_UNITS =
  LAYER_COSTS.aiLazyElementDescriptions +
  LAYER_COSTS.semanticEmbeddings;
const REQUIRED_AI_WORK_UNITS = LAYER_COSTS.aiSystemNarrative + LAYER_COSTS.aiPrimaryCapabilityDescriptions;
const ENRICHED_TOTAL_WORK_UNITS =
  CORE_WORK_UNITS +
  REQUIRED_AI_WORK_UNITS +
  ENRICHED_OPTIONAL_WORK_UNITS;

export async function runAnalysisFocusBenchmark(options: {
  outputPath?: string;
  markdownPath?: string;
} = {}): Promise<AnalysisFocusBenchmarkReport> {
  const profiles = await Promise.all((['agent-fast', 'ui-overview', 'deep-context', 'full'] as AnalysisFocus[])
    .map(focus => captureFocusSnapshot(focus)));
  const byFocus = Object.fromEntries(profiles.map(profile => [profile.focus, profile])) as Record<AnalysisFocus, FocusSnapshot>;

  const routingInputs = [
    { trigger: 'mcp', taskType: 'modify' },
    { trigger: 'cli', taskType: 'debug' },
    { trigger: 'ui', taskType: 'overview' },
    { trigger: 'manual-description', taskType: 'describe entity' },
    { trigger: 'runtime', taskType: 'bug triage' },
    { trigger: 'mcp', taskType: 'architecture audit' },
  ];
  const routing = routingInputs.map(input => {
    const recommendation = getAnalysisFocusProfiles({ trigger: input.trigger, taskType: input.taskType }).recommendation;
    return {
      trigger: input.trigger,
      task_type: input.taskType,
      recommended_focus: recommendation.recommended_focus,
      recommended_layer: recommendation.recommended_layer,
      token_policy: recommendation.token_policy,
    };
  });

  const gates = buildGates(byFocus, routing);
  const passed = gates.filter(gate => gate.status === 'pass').length;
  const report: AnalysisFocusBenchmarkReport = {
    generated_at: new Date().toISOString(),
    benchmark_type: 'analysis-focus-layer-proof',
    status: passed === gates.length ? 'pass' : 'fail',
    score: Math.round((passed / Math.max(1, gates.length)) * 100),
    summary: {
      enriched_total_work_units: ENRICHED_TOTAL_WORK_UNITS,
      enriched_optional_work_units: ENRICHED_OPTIONAL_WORK_UNITS,
      agent_fast_total_work_units: byFocus['agent-fast'].estimated_total_work_units,
      agent_fast_optional_work_units: byFocus['agent-fast'].estimated_optional_work_units,
      agent_fast_total_reduction_percent: byFocus['agent-fast'].total_work_reduction_vs_enriched_percent,
      agent_fast_optional_reduction_percent: byFocus['agent-fast'].optional_work_reduction_vs_enriched_percent,
      ui_overview_optional_work_units: byFocus['ui-overview'].estimated_optional_work_units,
      deep_context_optional_work_units: byFocus['deep-context'].estimated_optional_work_units,
    },
    gates,
    routing,
    profiles,
  };

  if (options.outputPath) {
    await fs.ensureDir(path.dirname(options.outputPath));
    await fs.writeJson(options.outputPath, report, { spaces: 2 });
  }
  if (options.markdownPath) {
    await fs.ensureDir(path.dirname(options.markdownPath));
    await fs.writeFile(options.markdownPath, renderMarkdown(report), 'utf8');
  }
  return report;
}

async function captureFocusSnapshot(focus: AnalysisFocus): Promise<FocusSnapshot> {
  const previous = captureEnv();
  for (const key of FOCUS_ENV_KEYS) delete process.env[key];

  try {
    return await withAnalysisFocus(focus, async () => {
      const env = Object.fromEntries(FOCUS_ENV_KEYS.map(key => [key, process.env[key] ?? null]));
      const profile = getAnalysisFocusProfiles({ trigger: triggerForFocus(focus) }).profiles.find(item => item.focus === focus);
      const enabledLayers = enabledLayersFromEnv(env);
      const optionalWork = optionalWorkUnits(enabledLayers);
      const requiredWork = requiredWorkUnits(enabledLayers);
      return {
        focus,
        token_policy: profile?.token_policy || 'unknown',
        cost_tier: profile?.cost_tier || 'unknown',
        enabled_layers: enabledLayers,
        deferred_layers: deferredLayers(enabledLayers),
        env,
        estimated_core_work_units: CORE_WORK_UNITS,
        estimated_optional_work_units: optionalWork,
        estimated_total_work_units: requiredWork + optionalWork,
        optional_work_reduction_vs_enriched_percent: percentReduction(ENRICHED_OPTIONAL_WORK_UNITS, optionalWork),
        total_work_reduction_vs_enriched_percent: percentReduction(ENRICHED_TOTAL_WORK_UNITS, requiredWork + optionalWork),
      };
    });
  } finally {
    restoreEnv(previous);
  }
}

function enabledLayersFromEnv(env: Record<string, string | null>): string[] {
  const layers = ['core-graph', 'agent-context'];
  if (env.KLAURO_AI_INTERPRETATION === 'true') layers.push('ai-system-narrative');
  const elementLimit = Number(env.KLAURO_AI_ELEMENT_DESCRIPTION_LIMIT || '0');
  if (env.KLAURO_AI_ELEMENT_DESCRIPTIONS === 'true' && elementLimit > 0) {
    if (elementLimit <= 8) layers.push('ai-primary-capability-descriptions');
    else layers.push('ai-lazy-element-descriptions');
  }
  if (env.KLAURO_EMBEDDING_ENABLED === 'true') layers.push('semantic-embeddings');
  return layers;
}

function deferredLayers(enabledLayers: string[]): string[] {
  return [
    'ai-lazy-element-descriptions',
    'semantic-embeddings',
  ].filter(layer => !enabledLayers.includes(layer));
}

function optionalWorkUnits(enabledLayers: string[]): number {
  let total = 0;
  if (enabledLayers.includes('ai-lazy-element-descriptions')) total += LAYER_COSTS.aiLazyElementDescriptions;
  if (enabledLayers.includes('semantic-embeddings')) total += LAYER_COSTS.semanticEmbeddings;
  return total;
}

function requiredWorkUnits(enabledLayers: string[]): number {
  let total = CORE_WORK_UNITS;
  if (enabledLayers.includes('ai-system-narrative')) total += LAYER_COSTS.aiSystemNarrative;
  if (enabledLayers.includes('ai-primary-capability-descriptions')) total += LAYER_COSTS.aiPrimaryCapabilityDescriptions;
  return total;
}

function buildGates(byFocus: Record<AnalysisFocus, FocusSnapshot>, routing: AnalysisFocusBenchmarkReport['routing']): BenchmarkGate[] {
  const agentFast = byFocus['agent-fast'];
  const uiOverview = byFocus['ui-overview'];
  const deepContext = byFocus['deep-context'];
  const full = byFocus.full;
  return [
    gate('analysis-focus:all-profiles-present',
      Boolean(agentFast && uiOverview && deepContext && full),
      Object.keys(byFocus).join(', ')),
    gate('analysis-focus:agent-fast-minimal',
      agentFast.estimated_optional_work_units === 0 &&
        agentFast.enabled_layers.includes('core-graph') &&
        agentFast.enabled_layers.includes('agent-context') &&
        agentFast.enabled_layers.includes('ai-system-narrative') &&
        agentFast.enabled_layers.includes('ai-primary-capability-descriptions') &&
        agentFast.deferred_layers.includes('ai-lazy-element-descriptions') &&
        agentFast.deferred_layers.includes('semantic-embeddings'),
      `${agentFast.estimated_optional_work_units} optional units; defers ${agentFast.deferred_layers.join(', ')}`),
    gate('analysis-focus:agent-fast-material-work-reduction',
      agentFast.total_work_reduction_vs_enriched_percent >= 45 &&
        agentFast.optional_work_reduction_vs_enriched_percent === 100,
      `${agentFast.total_work_reduction_vs_enriched_percent}% total reduction, ${agentFast.optional_work_reduction_vs_enriched_percent}% optional reduction`),
    gate('analysis-focus:ui-overview-narrative-not-semantic',
      uiOverview.enabled_layers.includes('ai-system-narrative') &&
        uiOverview.enabled_layers.includes('ai-primary-capability-descriptions') &&
        !uiOverview.enabled_layers.includes('semantic-embeddings'),
      uiOverview.enabled_layers.join(', ')),
    gate('analysis-focus:deep-context-semantic-not-bulk-elements',
      deepContext.enabled_layers.includes('ai-system-narrative') &&
        deepContext.enabled_layers.includes('ai-primary-capability-descriptions') &&
        deepContext.enabled_layers.includes('semantic-embeddings') &&
        !deepContext.enabled_layers.includes('ai-lazy-element-descriptions'),
      deepContext.enabled_layers.join(', ')),
    gate('analysis-focus:default-routing-never-full',
      routing.every(route => route.recommended_focus !== 'full'),
      routing.map(route => `${route.trigger}/${route.task_type}:${route.recommended_focus}`).join(', ')),
    gate('analysis-focus:mcp-routing-agent-fast',
      routing.filter(route => route.trigger === 'mcp' && !/audit/i.test(route.task_type || '')).every(route => route.recommended_focus === 'agent-fast'),
      routing.map(route => `${route.trigger}/${route.task_type}:${route.recommended_focus}`).join(', ')),
    gate('analysis-focus:human-routing-ui-overview',
      routing.filter(route => route.trigger === 'ui' || route.trigger === 'manual-description').every(route => route.recommended_focus === 'ui-overview'),
      routing.map(route => `${route.trigger}/${route.task_type}:${route.recommended_focus}`).join(', ')),
    gate('analysis-focus:runtime-audit-routing-deep-context',
      routing.filter(route => route.trigger === 'runtime' || /audit/i.test(route.task_type || '')).every(route => route.recommended_focus === 'deep-context'),
      routing.map(route => `${route.trigger}/${route.task_type}:${route.recommended_focus}`).join(', ')),
  ];
}

function triggerForFocus(focus: AnalysisFocus): string {
  if (focus === 'agent-fast') return 'mcp';
  if (focus === 'ui-overview') return 'ui';
  if (focus === 'deep-context') return 'runtime';
  return 'unknown';
}

function gate(id: string, ok: boolean, detail: string): BenchmarkGate {
  return { id, status: ok ? 'pass' : 'fail', detail };
}

function percentReduction(baseline: number, current: number): number {
  return Math.round(((baseline - current) / Math.max(1, baseline)) * 1000) / 10;
}

function captureEnv(): Record<string, string | undefined> {
  return Object.fromEntries(FOCUS_ENV_KEYS.map(key => [key, process.env[key]]));
}

function restoreEnv(previous: Record<string, string | undefined>): void {
  for (const key of FOCUS_ENV_KEYS) {
    const value = previous[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function renderMarkdown(report: AnalysisFocusBenchmarkReport): string {
  return [
    '# Klauro Analysis Focus Benchmark',
    '',
    `Status: **${report.status.toUpperCase()}** (${report.score}/100)`,
    '',
    '## Summary',
    '',
    `- Enriched baseline: ${report.summary.enriched_total_work_units} total work units, ${report.summary.enriched_optional_work_units} optional enrichment units.`,
    `- Agent-fast: ${report.summary.agent_fast_total_work_units} total work units, ${report.summary.agent_fast_optional_work_units} optional enrichment units.`,
    `- Agent-fast reduction: ${report.summary.agent_fast_total_reduction_percent}% total work, ${report.summary.agent_fast_optional_reduction_percent}% optional enrichment work.`,
    '',
    '## Profiles',
    '',
    '| Focus | Token policy | Cost tier | Enabled layers | Deferred layers | Total units | Optional units |',
    '|---|---|---:|---|---|---:|---:|',
    ...report.profiles.map(profile => [
      profile.focus,
      profile.token_policy,
      profile.cost_tier,
      profile.enabled_layers.join(', '),
      profile.deferred_layers.join(', '),
      String(profile.estimated_total_work_units),
      String(profile.estimated_optional_work_units),
    ].join(' | ')).map(row => `| ${row} |`),
    '',
    '## Gates',
    '',
    ...report.gates.map(gate => `- ${gate.status === 'pass' ? 'PASS' : 'FAIL'} ${gate.id}: ${gate.detail}`),
    '',
  ].join('\n');
}

function parseArgs(argv: string[]): { outputPath?: string; markdownPath?: string } {
  const options: { outputPath?: string; markdownPath?: string } = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--output') options.outputPath = path.resolve(argv[++index]);
    else if (arg === '--markdown') options.markdownPath = path.resolve(argv[++index]);
    else if (arg === '--help' || arg === '-h') {
      console.log([
        'Usage: npm run analysis-focus-benchmark -- [options]',
        '',
        'Options:',
        '  --output /path/report.json   Write JSON report',
        '  --markdown /path/report.md   Write Markdown report',
      ].join('\n'));
      process.exit(0);
    }
  }
  return options;
}

async function main(): Promise<void> {
  const report = await runAnalysisFocusBenchmark(parseArgs(process.argv.slice(2)));
  console.log(JSON.stringify(report, null, 2));
  if (report.status !== 'pass') process.exitCode = 1;
}

if (isDirectCliInvocation('analysis-focus-benchmark')) {
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
