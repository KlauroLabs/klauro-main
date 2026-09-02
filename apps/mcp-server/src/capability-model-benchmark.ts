import { spawn } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'fs-extra';
import { isDirectCliInvocation } from './cli-invocation';

interface ModelSpec {
  name: string;
  baseUrl: string;
  apiKey: string;
  contextTokens: number;
  maxOutputTokens: number;
}

interface CapabilityResult {
  name: string;
  description: string;
  category: string;
  operations: number;
  entities: number;
}

export interface CapabilityModelTrial {
  model: string;
  trial: number;
  status: 'pass' | 'fail';
  elapsed_ms: number;
  score: number;
  score_components: Record<string, number>;
  primary_domain: string;
  system_description: string;
  description_status: string;
  description_reason?: string;
  capability_count: number;
  capabilities: CapabilityResult[];
  error?: string;
}

interface ModelSummary {
  model: string;
  trials: number;
  successful_trials: number;
  mean_score: number;
  mean_elapsed_ms: number;
  title_stability: number;
  domain_stability: number;
  overall_score: number;
}

export interface CapabilityModelBenchmarkReport {
  generated_at: string;
  project_path: string;
  max_duration_ms: number;
  status: 'pass' | 'fail';
  winner?: string;
  models: ModelSummary[];
  trials: CapabilityModelTrial[];
}

interface BenchmarkOptions {
  projectPath: string;
  models: ModelSpec[];
  trials: number;
  maxDurationMs: number;
  outputPath?: string;
  markdownPath?: string;
}

interface WorkerResult {
  elapsed_ms: number;
  primary_domain: string;
  system_description: string;
  description_status: string;
  description_reason?: string;
  capabilities: CapabilityResult[];
}

const PRODUCT_ACTION = /^(?:accept|add|administer|analyze|approve|assign|audit|authorize|book|build|capture|compare|configure|connect|control|coordinate|create|deliver|deploy|discover|dispatch|enforce|evaluate|export|find|generate|grant|import|inspect|manage|monitor|operate|organize|plan|process|protect|provide|publish|record|report|request|resolve|review|schedule|secure|send|settle|share|submit|sync|track|trade|validate|view|visualize)\b/i;
const IMPLEMENTATION_LANGUAGE = /\b(?:api|class|component|controller|database|endpoint|entity|feature|framework|function|handler|http|interface|method|module|repository|route|schema|service layer|source file|table)\b/i;

function words(value: string): string[] {
  return String(value || '').trim().split(/\s+/).filter(Boolean);
}

function rounded(value: number): number {
  return Math.round(value * 100) / 100;
}

export function scoreCapabilityModelTrial(
  result: WorkerResult,
  model: string,
  trial: number,
  maxDurationMs: number,
): CapabilityModelTrial {
  const capabilities = result.capabilities || [];
  const languageScores = capabilities.map(capability => {
    const nameWords = words(capability.name);
    const descriptionWords = words(capability.description);
    const checks = [
      PRODUCT_ACTION.test(capability.name),
      nameWords.length >= 2 && nameWords.length <= 8,
      descriptionWords.length >= 8 && descriptionWords.length <= 30,
      !IMPLEMENTATION_LANGUAGE.test(`${capability.name} ${capability.description}`),
      !/^lets users\b/i.test(capability.description),
      (capability.description.match(/[.!?](?:\s|$)/g) || []).length <= 1,
    ];
    return checks.filter(Boolean).length / checks.length;
  });
  const language = languageScores.length > 0
    ? languageScores.reduce((sum, value) => sum + value, 0) / languageScores.length
    : 0;
  const evidence = capabilities.length > 0
    ? capabilities.filter(capability => capability.operations > 0 || capability.entities > 0).length / capabilities.length
    : 0;
  const narrative = result.primary_domain && result.system_description && result.description_status === 'ai_applied' ? 1 : 0;
  const count = capabilities.length > 0 ? 1 : 0;
  const duration = result.elapsed_ms <= maxDurationMs ? 1 : 0;
  const components = {
    completion: 10,
    duration: duration * 15,
    narrative: narrative * 25,
    product_language: language * 25,
    evidence_grounding: evidence * 15,
    catalog_size: count * 10,
  };
  const score = rounded(Object.values(components).reduce((sum, value) => sum + value, 0));
  return {
    model,
    trial,
    status: capabilities.length > 0 && duration === 1 ? 'pass' : 'fail',
    elapsed_ms: result.elapsed_ms,
    score,
    score_components: Object.fromEntries(Object.entries(components).map(([key, value]) => [key, rounded(value)])),
    primary_domain: result.primary_domain,
    system_description: result.system_description,
    description_status: result.description_status,
    description_reason: result.description_reason,
    capability_count: capabilities.length,
    capabilities,
  };
}

function setSimilarity(left: Set<string>, right: Set<string>): number {
  const union = new Set([...left, ...right]);
  if (union.size === 0) return 1;
  let intersection = 0;
  for (const value of left) if (right.has(value)) intersection += 1;
  return intersection / union.size;
}

function modelSummary(model: string, trials: CapabilityModelTrial[]): ModelSummary {
  const successful = trials.filter(trial => trial.status === 'pass');
  const pairs: number[] = [];
  for (let left = 0; left < successful.length; left++) {
    for (let right = left + 1; right < successful.length; right++) {
      pairs.push(setSimilarity(
        new Set(successful[left].capabilities.map(capability => capability.name.toLowerCase())),
        new Set(successful[right].capabilities.map(capability => capability.name.toLowerCase())),
      ));
    }
  }
  const titleStability = pairs.length > 0 ? pairs.reduce((sum, value) => sum + value, 0) / pairs.length : 0;
  const domains = successful.map(trial => trial.primary_domain).filter(Boolean);
  const domainStability = domains.length >= 2
    ? Math.max(...Array.from(new Set(domains)).map(domain => domains.filter(value => value === domain).length)) / domains.length
    : 0;
  const meanScore = trials.reduce((sum, trial) => sum + trial.score, 0) / Math.max(1, trials.length);
  const stabilityScore = successful.length >= 2 ? titleStability * 10 + domainStability * 5 : 0;
  return {
    model,
    trials: trials.length,
    successful_trials: successful.length,
    mean_score: rounded(meanScore),
    mean_elapsed_ms: Math.round(trials.reduce((sum, trial) => sum + trial.elapsed_ms, 0) / Math.max(1, trials.length)),
    title_stability: rounded(titleStability * 100),
    domain_stability: rounded(domainStability * 100),
    overall_score: rounded(successful.length >= 2 ? meanScore * 0.85 + stabilityScore : meanScore),
  };
}

function runWorker(projectPath: string, model: ModelSpec, trial: number, maxDurationMs: number): Promise<CapabilityModelTrial> {
  return new Promise(resolve => {
    const startedAt = Date.now();
    const child = spawn(process.execPath, ['--import', 'tsx', __filename, '--worker', '--project', projectPath], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        KLAURO_ALLOW_LOCAL_AI: '1',
        LOCAL_LLM_BASE_URL: model.baseUrl,
        LOCAL_LLM_MODEL: model.name,
        LOCAL_LLM_STRUCTURED_MODEL: model.name,
        LOCAL_LLM_MAX_TOKENS: String(model.maxOutputTokens),
        LOCAL_LLM_API_KEY: model.apiKey,
        KLAURO_FORCE_AI_REFRESH: '1',
        KLAURO_AI_ENABLED: 'true',
        KLAURO_AI_INTERPRETATION: 'true',
        KLAURO_AI_INTERPRETATION_FORCE: '1',
        KLAURO_EMBEDDING_ENABLED: 'false',
        KLAURO_FRESH_ORCHESTRATOR_PER_ANALYSIS: '1',
        AI_MAX_CONTEXT_LENGTH: String(model.contextTokens),
        OLLAMA_NUM_CTX: String(model.contextTokens + model.maxOutputTokens + 512),
      },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let stdout = '';
    let settled = false;
    const finish = (result: CapabilityModelTrial): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve(result);
    };
    const deadline = setTimeout(() => {
      child.kill('SIGTERM');
      finish(failedTrial(
        model.name,
        trial,
        `worker exceeded ${maxDurationMs}ms benchmark deadline`,
        Date.now() - startedAt,
      ));
    }, maxDurationMs);
    child.stdout.on('data', chunk => {
      stdout = `${stdout}${String(chunk)}`.slice(-2_000_000);
    });
    child.on('error', error => finish(failedTrial(model.name, trial, error.message, Date.now() - startedAt)));
    child.on('close', code => {
      const marker = stdout.split('\n').find(line => line.startsWith('KLAURO_CAPABILITY_MODEL_RESULT='));
      if (code !== 0 || !marker) {
        finish(failedTrial(model.name, trial, `worker exited ${code ?? 'without status'}`, Date.now() - startedAt));
        return;
      }
      try {
        finish(scoreCapabilityModelTrial(JSON.parse(marker.slice('KLAURO_CAPABILITY_MODEL_RESULT='.length)), model.name, trial, maxDurationMs));
      } catch (error) {
        finish(failedTrial(model.name, trial, error instanceof Error ? error.message : String(error), Date.now() - startedAt));
      }
    });
  });
}

function failedTrial(model: string, trial: number, error: string, elapsedMs = 0): CapabilityModelTrial {
  return {
    model,
    trial,
    status: 'fail',
    elapsed_ms: elapsedMs,
    score: 0,
    score_components: {},
    primary_domain: '',
    system_description: '',
    description_status: 'failed',
    description_reason: error,
    capability_count: 0,
    capabilities: [],
    error,
  };
}

export async function runCapabilityModelBenchmark(options: BenchmarkOptions): Promise<CapabilityModelBenchmarkReport> {
  const trialResults: CapabilityModelTrial[] = [];
  for (const model of options.models) {
    for (let trial = 1; trial <= options.trials; trial++) {
      trialResults.push(await runWorker(options.projectPath, model, trial, options.maxDurationMs));
    }
  }
  const models = options.models
    .map(model => modelSummary(model.name, trialResults.filter(trial => trial.model === model.name)))
    .sort((left, right) => right.overall_score - left.overall_score || left.mean_elapsed_ms - right.mean_elapsed_ms);
  const report: CapabilityModelBenchmarkReport = {
    generated_at: new Date().toISOString(),
    project_path: path.resolve(options.projectPath),
    max_duration_ms: options.maxDurationMs,
    status: models.length > 0 && models[0].successful_trials > 0 ? 'pass' : 'fail',
    winner: models[0]?.successful_trials ? models[0].model : undefined,
    models,
    trials: trialResults,
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
}

function renderMarkdown(report: CapabilityModelBenchmarkReport): string {
  return [
    '# Capability Model Benchmark',
    '',
    `Status: **${report.status.toUpperCase()}**`,
    `Winner: ${report.winner || 'none'}`,
    '',
    '| Model | Overall | Quality | Mean latency | Title stability | Domain stability |',
    '| --- | ---: | ---: | ---: | ---: | ---: |',
    ...report.models.map(model => `| ${model.model} | ${model.overall_score} | ${model.mean_score} | ${model.mean_elapsed_ms} ms | ${model.title_stability}% | ${model.domain_stability}% |`),
    '',
    ...report.trials.flatMap(trial => [
      `## ${trial.model}, trial ${trial.trial}`,
      '',
      `Status: ${trial.status}; score: ${trial.score}; latency: ${trial.elapsed_ms} ms; domain: ${trial.primary_domain || 'none'}`,
      '',
      ...trial.capabilities.map(capability => `- ${capability.name}: ${capability.description}`),
      '',
    ]),
  ].join('\n');
}

interface ParsedArgs extends BenchmarkOptions {
  worker: boolean;
}

export function parseCapabilityModelBenchmarkArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): ParsedArgs {
  let projectPath = '';
  let baseUrl = env.LOCAL_LLM_BASE_URL || '';
  let apiKey = env.LOCAL_LLM_API_KEY || 'local';
  let contextTokens = Number(env.AI_MAX_CONTEXT_LENGTH || 6000);
  let maxOutputTokens = Number(env.LOCAL_LLM_MAX_TOKENS || 2200);
  let trials = 1;
  let maxDurationMs = 180000;
  let outputPath: string | undefined;
  let markdownPath: string | undefined;
  let worker = false;
  const modelNames: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--worker') worker = true;
    else if (arg === '--project') projectPath = path.resolve(argv[++index]);
    else if (arg === '--base-url') baseUrl = argv[++index];
    else if (arg === '--api-key') throw new Error('API keys must be supplied through LOCAL_LLM_API_KEY, never command-line arguments');
    else if (arg === '--model') modelNames.push(argv[++index]);
    else if (arg === '--trials') trials = Number(argv[++index]);
    else if (arg === '--context-tokens') contextTokens = Number(argv[++index]);
    else if (arg === '--max-output-tokens') maxOutputTokens = Number(argv[++index]);
    else if (arg === '--max-duration-ms') maxDurationMs = Number(argv[++index]);
    else if (arg === '--output') outputPath = path.resolve(argv[++index]);
    else if (arg === '--markdown') markdownPath = path.resolve(argv[++index]);
  }
  if (!projectPath) throw new Error('--project is required');
  if (!worker && modelNames.length === 0) throw new Error('at least one --model is required');
  if (!worker && !baseUrl) throw new Error('--base-url or LOCAL_LLM_BASE_URL is required');
  if (![trials, contextTokens, maxOutputTokens, maxDurationMs].every(value => Number.isFinite(value) && value > 0)) {
    throw new Error('numeric benchmark options must be positive');
  }
  return {
    projectPath,
    models: modelNames.map(name => ({ name, baseUrl, apiKey, contextTokens, maxOutputTokens })),
    trials: Math.floor(trials),
    maxDurationMs: Math.floor(maxDurationMs),
    outputPath,
    markdownPath,
    worker,
  };
}

async function runWorkerAnalysis(projectPath: string): Promise<void> {
  const imported = await import('./analyzer');
  const started = Date.now();
  const output = await imported.analyzeProject(projectPath, path.basename(projectPath), { reuseStoredContext: false, persist: false });
  const purpose = output.enhanced_system_purpose;
  const result: WorkerResult = {
    elapsed_ms: Date.now() - started,
    primary_domain: purpose?.primary_domain || '',
    system_description: purpose?.inferred_description || '',
    description_status: purpose?.description_generation?.status || '',
    description_reason: purpose?.description_generation?.reason,
    capabilities: (output.capabilities || []).map(capability => ({
      name: capability.name,
      description: capability.description || '',
      category: capability.category || '',
      operations: capability.operations?.length || 0,
      entities: capability.related_entities?.length || 0,
    })),
  };
  process.stdout.write(`KLAURO_CAPABILITY_MODEL_RESULT=${JSON.stringify(result)}\n`);
}

if (isDirectCliInvocation('capability-model-benchmark')) {
  try {
    const options = parseCapabilityModelBenchmarkArgs(process.argv.slice(2));
    if (options.worker) {
      runWorkerAnalysis(options.projectPath).catch(error => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      });
    } else {
      runCapabilityModelBenchmark(options).then(report => {
        for (const model of report.models) {
          console.log(`${model.model}: overall=${model.overall_score} quality=${model.mean_score} latency=${model.mean_elapsed_ms}ms stability=${model.title_stability}%`);
        }
        if (report.status !== 'pass') process.exitCode = 1;
      }).catch(error => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      });
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
