#!/usr/bin/env tsx
import * as fs from 'fs-extra';
import * as path from 'path';
import type { CASOutput, SystemCapability } from '../../../packages/analyzer-core/src/types/cas.types';
import { buildCapabilityMemoryForAgent, getAgentWorkPacket } from './agent-adoption';
import { getOrchestrator } from './analyzer';
import { discoverRealRepos } from './repo-discovery';
import { saveAgenticBenchmarkReport } from './storage';
import { isDirectCliInvocation } from './cli-invocation';

type GateStatus = 'pass' | 'warn' | 'fail';

interface TargetInput {
  name?: string;
  path: string;
}

interface ParsedArgs {
  repos: TargetInput[];
  includeRealRepos: boolean;
  devRoot: string;
  maxTargets: number;
  maxTasksPerRepo: number;
  outputPath: string;
  markdownPath: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  const repos: TargetInput[] = [];
  let includeRealRepos = false;
  let devRoot = path.join(process.env.HOME || '', 'dev');
  let maxTargets = 8;
  let maxTasksPerRepo = 4;
  let outputPath = path.join(process.cwd(), '.klauro-agent-capability-memory', 'latest-report.json');
  let markdownPath = path.join(process.cwd(), '.klauro-agent-capability-memory', 'latest-report.md');

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--repo') {
      const value = argv[++i];
      const [namePart, repoPathPart] = value.includes('=') ? value.split('=') : [undefined, value];
      const repoPath = path.resolve(repoPathPart);
      repos.push({ name: namePart || path.basename(repoPath), path: repoPath });
    } else if (arg === '--real-repos') {
      includeRealRepos = true;
    } else if (arg === '--dev-root') {
      devRoot = path.resolve(argv[++i]);
    } else if (arg === '--max-targets') {
      maxTargets = Number(argv[++i]);
    } else if (arg === '--max-tasks-per-repo') {
      maxTasksPerRepo = Number(argv[++i]);
    } else if (arg === '--output') {
      outputPath = path.resolve(argv[++i]);
    } else if (arg === '--markdown') {
      markdownPath = path.resolve(argv[++i]);
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
  }

  return { repos, includeRealRepos, devRoot, maxTargets, maxTasksPerRepo, outputPath, markdownPath };
}

function printHelp(): void {
  console.log([
    'Usage: npm run agent-capability-memory-benchmark -- [options]',
    '',
    'Options:',
    '  --repo name=/path/to/repo       Run a specific repo. May be repeated.',
    '  --real-repos                   Include discovered repos under --dev-root.',
    '  --dev-root /path               Root used for real repo discovery.',
    '  --max-targets n                Limit total targets.',
    '  --max-tasks-per-repo n         Limit generated capability-memory tasks per repo.',
    '  --output /path/report.json     Write JSON report.',
    '  --markdown /path/report.md     Write Markdown report.',
  ].join('\n'));
}

export async function runAgentCapabilityMemoryBenchmark(options: {
  repos?: TargetInput[];
  includeRealRepos?: boolean;
  devRoot?: string;
  maxTargets?: number;
  maxTasksPerRepo?: number;
  outputPath?: string;
  markdownPath?: string;
  quiet?: boolean;
} = {}) {
  const targets = (await resolveTargets(options)).slice(0, options.maxTargets || 8);
  const repoResults = [];

  for (const target of targets) {
    if (!options.quiet) console.log(`Analyzing capability memory: ${target.name}`);
    const cas = await getOrchestrator().orchestrateAnalysis(target.path);
    const trials = [];
    for (const capability of selectCapabilities(cas).slice(0, options.maxTasksPerRepo || 4)) {
      const task = taskForCapability(capability);
      const memory = buildCapabilityMemoryForAgent(cas, {
        target: capability.name,
        instructions: task.instructions,
        success_criteria: task.success_criteria,
        files: capability.operations.map(operation => operation.path_or_command || '').filter(Boolean),
        limit: 8,
      });
      const packet = await getAgentWorkPacket(cas, target.path, task);
      const withScore = scoreWithCapabilityMemory(memory, capability, packet);
      const withoutScore = scoreWithoutCapabilityMemory(capability);
      const delta = withScore.score - withoutScore.score;
      trials.push({
        capability_id: capability.id,
        capability_name: capability.name,
        task,
        status: delta > 0 && withScore.score >= 80 ? 'pass' : delta > 0 ? 'warn' : 'fail',
        with_klauro: withScore,
        without_klauro: withoutScore,
        delta,
      });
    }
    repoResults.push({
      repo: target.name,
      path: target.path,
      status: aggregateStatus(trials.map(trial => trial.status as GateStatus)),
      capability_count: cas.system_capabilities?.length || 0,
      trial_count: trials.length,
      average_delta: Math.round(average(trials.map(trial => trial.delta))),
      trials,
    });
  }

  const allTrials = repoResults.flatMap(result => result.trials);
  const report = {
    id: `agent-capability-memory-${Date.now()}`,
    benchmark_type: 'agent-capability-memory',
    generated_at: new Date().toISOString(),
    status: aggregateStatus(repoResults.map(result => result.status as GateStatus)),
    score: Math.round(average(allTrials.map(trial => trial.with_klauro.score))),
    summary: {
      target_count: repoResults.length,
      task_count: allTrials.length,
      repos_with_capability_trials: repoResults.filter(result => result.trial_count > 0).length,
      average_duplicate_avoidance_delta: Math.round(average(allTrials.map(trial => trial.delta))),
      memory_hit_rate: allTrials.length === 0 ? 0 : Math.round((allTrials.filter(trial => trial.with_klauro.matched_requested_capability).length / allTrials.length) * 100),
      average_with_klauro_score: Math.round(average(allTrials.map(trial => trial.with_klauro.score))),
      average_without_klauro_score: Math.round(average(allTrials.map(trial => trial.without_klauro.score))),
    },
    repositories: repoResults,
  };

  if (options.outputPath) {
    await fs.ensureDir(path.dirname(options.outputPath));
    await fs.writeJson(options.outputPath, report, { spaces: 2 });
  }
  if (options.markdownPath) {
    await fs.ensureDir(path.dirname(options.markdownPath));
    await fs.writeFile(options.markdownPath, formatCapabilityMemoryMarkdown(report), 'utf8');
  }
  await saveAgenticBenchmarkReport(report);
  return report;
}

async function resolveTargets(options: { repos?: TargetInput[]; includeRealRepos?: boolean; devRoot?: string }): Promise<TargetInput[]> {
  const explicit = options.repos || [];
  if (!options.includeRealRepos) return explicit;
  const discovered = await discoverRealRepos(options.devRoot || path.join(process.env.HOME || '', 'dev'));
  return [
    ...explicit,
    ...discovered.repos
      .filter(repo => repo.status === 'eligible')
      .map(repo => ({ name: repo.name, path: repo.path })),
  ];
}

function selectCapabilities(cas: CASOutput): SystemCapability[] {
  return [...(cas.system_capabilities || [])]
    .filter(capability => capability.category !== 'internal')
    .filter(capability => isProductCapabilityForMemoryProof(capability))
    .filter(capability => capability.operations.length > 0 || capability.related_entities.length > 0)
    .sort((left, right) => capabilityRank(right) - capabilityRank(left) || right.operations.length - left.operations.length);
}

function isProductCapabilityForMemoryProof(capability: SystemCapability): boolean {
  const subject = capability.name
    .toLowerCase()
    .replace(/\b(management|capability|commands|handlers|tasks|reporting)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  if (!subject) return false;
  const generic = new Set([
    'flutter', 'lifecycle', 'read', 'write', 'create', 'update', 'delete', 'runtime',
    'method', 'main', 'home', 'settings', 'screen', 'component', 'page', 'route',
    'api', 'app', 'application', 'service', 'services', 'controller', 'controllers',
  ]);
  const terms = subject.split(/\s+/).filter(Boolean);
  return terms.some(term => term.length > 2 && !generic.has(term));
}

function taskForCapability(capability: SystemCapability) {
  return {
    task_type: 'modify' as const,
    target: capability.name,
    instructions: `Add or extend behavior for ${capability.name}. Before creating new modules, determine whether this is already represented in the codebase and prefer reuse or extension over duplication.`,
    success_criteria: [
      'Existing behavior is reused, extended, extracted, or explicitly distinguished before new code is created.',
      'The first source files inspected include the current owner of the capability when one exists.',
      'Relevant tests or validation checks are identified from current codebase structure.',
    ],
  };
}

function scoreWithCapabilityMemory(memory: any, capability: SystemCapability, packet: any) {
  const matched = (memory.matched_capabilities || []).find((candidate: any) => candidate.id === capability.id || candidate.name === capability.name);
  const reuseDecision = (memory.reuse_decisions_required || []).find((decision: any) => decision.existing_capability === capability.name);
  const operationPaths = capability.operations.map(operation => operation.path_or_command).filter(Boolean) as string[];
  const packetFiles = (packet.file_read_plan || []).map((item: any) => item.file).filter(Boolean);
  const includesOwner = operationPaths.length === 0 || operationPaths.some(file => packetFiles.includes(file));
  const score =
    (matched ? 35 : 0) +
    (reuseDecision ? 25 : 0) +
    (includesOwner ? 20 : 0) +
    ((memory.do_not_rebuild || []).length > 0 ? 10 : 0) +
    ((memory.agent_guidance || []).length > 0 ? 10 : 0);

  return {
    score,
    matched_requested_capability: Boolean(matched),
    reuse_decision_present: Boolean(reuseDecision),
    owner_path_in_file_plan: includesOwner,
    matched_capabilities: (memory.matched_capabilities || []).slice(0, 5),
    file_read_plan: packetFiles.slice(0, 8),
  };
}

function scoreWithoutCapabilityMemory(capability: SystemCapability) {
  const hasCurrentOwner = capability.operations.some(operation => operation.path_or_command) || capability.related_entities.length > 0;
  return {
    score: hasCurrentOwner ? 35 : 50,
    matched_requested_capability: false,
    reuse_decision_present: false,
    owner_path_in_file_plan: false,
    risk: hasCurrentOwner
      ? 'A source-search-only agent can still find this, but the prompt does not force an explicit reuse/extend/extract decision before creating parallel behavior.'
      : 'No clear current owner was modeled, so direct source confirmation remains required.',
  };
}

function formatCapabilityMemoryMarkdown(report: any): string {
  const lines = [
    '# Klauro Capability Memory Benchmark',
    '',
    `Generated: ${report.generated_at}`,
    `Status: ${report.status}`,
    `Score: ${report.score}/100`,
    '',
    '## Summary',
    '',
    `Targets: ${report.summary.target_count}`,
    `Tasks: ${report.summary.task_count}`,
    `Memory hit rate: ${report.summary.memory_hit_rate}%`,
    `Average with-Klauro score: ${report.summary.average_with_klauro_score}/100`,
    `Average without-Klauro score: ${report.summary.average_without_klauro_score}/100`,
    `Average duplicate-avoidance delta: +${report.summary.average_duplicate_avoidance_delta}`,
    '',
    '## Repositories',
    '',
    '| Repo | Trials | Capabilities | Avg Delta | Status |',
    '| --- | ---: | ---: | ---: | --- |',
  ];
  for (const repo of report.repositories) {
    lines.push(`| ${repo.repo} | ${repo.trial_count} | ${repo.capability_count} | ${repo.average_delta >= 0 ? '+' : ''}${repo.average_delta} | ${repo.status} |`);
  }
  lines.push('', '## Trials', '');
  for (const repo of report.repositories) {
    for (const trial of repo.trials) {
      lines.push(`### ${repo.repo}: ${trial.capability_name}`);
      lines.push(`Status: ${trial.status}; delta ${trial.delta >= 0 ? '+' : ''}${trial.delta}; with Klauro ${trial.with_klauro.score}/100; without ${trial.without_klauro.score}/100.`);
      lines.push(`Matched capability: ${trial.with_klauro.matched_requested_capability}; reuse decision: ${trial.with_klauro.reuse_decision_present}; owner in file plan: ${trial.with_klauro.owner_path_in_file_plan}.`);
      lines.push('');
    }
  }
  return `${lines.join('\n')}\n`;
}

function capabilityRank(capability: SystemCapability): number {
  const category = capability.category === 'core' ? 4 : capability.category === 'supporting' ? 3 : capability.category === 'admin' ? 2 : 1;
  const criticality = capability.criticality === 'critical' ? 4 : capability.criticality === 'high' ? 3 : capability.criticality === 'medium' ? 2 : 1;
  return category + criticality;
}

function aggregateStatus(statuses: GateStatus[]): GateStatus {
  if (statuses.length === 0) return 'warn';
  if (statuses.includes('fail')) return 'fail';
  if (statuses.includes('warn')) return 'warn';
  return 'pass';
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const report = await runAgentCapabilityMemoryBenchmark({
    repos: args.repos,
    includeRealRepos: args.includeRealRepos,
    devRoot: args.devRoot,
    maxTargets: args.maxTargets,
    maxTasksPerRepo: args.maxTasksPerRepo,
    outputPath: args.outputPath,
    markdownPath: args.markdownPath,
  });
  console.log(`Capability memory benchmark: ${report.status.toUpperCase()} (${report.score}/100)`);
  console.log(`Tasks: ${report.summary.task_count} | Memory hit rate ${report.summary.memory_hit_rate}% | Duplicate-avoidance delta +${report.summary.average_duplicate_avoidance_delta}`);
  console.log(`Report: ${args.outputPath}`);
  console.log(`Markdown: ${args.markdownPath}`);
  if (report.status === 'fail') process.exitCode = 1;
}

if (isDirectCliInvocation('agent-capability-memory-benchmark')) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
