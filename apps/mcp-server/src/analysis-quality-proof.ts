import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import pLimit from 'p-limit';
import { discoverRealRepos, type RealRepoTarget } from './repo-discovery';
import { analyzeForBench } from './gauntlet/product-analysis';
import { withAnalysisFocus, type AnalysisFocus } from './analysis-focus';
import { evaluateSpotReadCas } from './analysis-spot-read-quality';
import { isDirectCliInvocation } from './cli-invocation';
import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';

type ProofStatus = 'pass' | 'warn' | 'fail' | 'unsupported' | 'skipped';

interface ParsedArgs {
  devRoot: string;
  maxTargets?: number;
  startIndex: number;
  concurrency: number;
  perRepoTimeoutMs: number;
  focus: AnalysisFocus;
  outputPath?: string;
  markdownPath?: string;
  allowWarnings: boolean;
  repoFilters: string[];
}

interface RepoProofResult {
  repo: RealRepoTarget;
  status: ProofStatus;
  score: number;
  duration_ms: number;
  analysis_id?: string;
  dimensions?: {
    system_description: string;
    primary_capabilities: string;
    domain_inference: string;
    entities: string;
    architectural_patterns: string;
    risks: string;
  };
  index?: {
    nodes: number;
    edges: number;
    entry_points: number;
    entities: number;
    files: number | null;
    languages: number;
  };
  failed_gates: string[];
  warning_gates: string[];
  error?: string;
}

interface AnalysisQualityProofReport {
  generated_at: string;
  benchmark_type: 'analysis-quality-proof';
  dev_root: string;
  focus: AnalysisFocus;
  selected_eligible_repos: number;
  discovered: {
    total: number;
    eligible: number;
    unsupported: number;
    skipped: number;
  };
  status: 'pass' | 'fail';
  summary: {
    pass: number;
    warn: number;
    fail: number;
    unsupported: number;
    skipped: number;
    average_score: number;
  };
  results: RepoProofResult[];
}

export async function runAnalysisQualityProof(options: ParsedArgs): Promise<AnalysisQualityProofReport> {
  const discovery = await discoverRealRepos(options.devRoot);
  const eligible = discovery.repos.filter(repo =>
    repo.status === 'eligible' &&
    (options.repoFilters.length === 0 || options.repoFilters.some(filter =>
      `${repo.name} ${repo.path}`.toLowerCase().includes(filter.toLowerCase())
    ))
  );
  const selected = eligible.slice(options.startIndex, options.maxTargets ? options.startIndex + options.maxTargets : undefined);
  const limit = pLimit(options.concurrency);
  const analyzed = await Promise.all(selected.map(repo => limit(() => evaluateRepo(repo, options.focus, options.perRepoTimeoutMs))));
  const unselected = discovery.repos
    .filter(repo => repo.status !== 'eligible')
    .map(repo => ({
      repo,
      status: repo.status as 'unsupported' | 'skipped',
      score: 0,
      duration_ms: 0,
      failed_gates: [],
      warning_gates: [],
      error: repo.reason,
    } satisfies RepoProofResult));
  const results = [...analyzed, ...unselected].sort((left, right) => left.repo.path.localeCompare(right.repo.path));
  const scored = analyzed.filter(result => result.status !== 'fail' || result.score > 0);
  const averageScore = Math.round(scored.reduce((sum, result) => sum + result.score, 0) / Math.max(1, scored.length));
  const failCount = analyzed.filter(result => result.status === 'fail').length;
  const warnCount = analyzed.filter(result => result.status === 'warn').length;
  const report: AnalysisQualityProofReport = {
    generated_at: new Date().toISOString(),
    benchmark_type: 'analysis-quality-proof',
    dev_root: discovery.dev_root,
    focus: options.focus,
    selected_eligible_repos: selected.length,
    discovered: {
      total: discovery.total_repos,
      eligible: discovery.eligible_repos,
      unsupported: discovery.unsupported_repos,
      skipped: discovery.skipped_repos,
    },
    status: failCount > 0 || (!options.allowWarnings && warnCount > 0) ? 'fail' : 'pass',
    summary: {
      pass: analyzed.filter(result => result.status === 'pass').length,
      warn: warnCount,
      fail: failCount,
      unsupported: discovery.unsupported_repos,
      skipped: discovery.skipped_repos,
      average_score: averageScore,
    },
    results,
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

async function evaluateRepo(repo: RealRepoTarget, focus: AnalysisFocus, perRepoTimeoutMs: number): Promise<RepoProofResult> {
  const started = Date.now();
  try {
    const cas: CASOutput = await withTimeout(
      withAnalysisFocus(focus, () => analyzeForBench(repo.path)),
      perRepoTimeoutMs,
      `analysis timed out after ${Math.round(perRepoTimeoutMs / 1000)}s`
    );
    const spot = evaluateSpotReadCas(cas, '');
    const failedGates = spot.gates.filter(gate => gate.status === 'fail');
    const warningGates = spot.gates.filter(gate => gate.status === 'warn');
    return {
      repo,
      status: spot.status,
      score: spot.score,
      duration_ms: Date.now() - started,
      analysis_id: cas.analysis_id,
      dimensions: {
        system_description: describeDescription(cas),
        primary_capabilities: describeCapabilities(cas),
        domain_inference: describeDomain(cas),
        entities: describeEntities(cas),
        architectural_patterns: describePatterns(cas),
        risks: describeRisks(cas),
      },
      index: describeIndex(cas),
      failed_gates: failedGates.map(gate => `${gate.id}: ${gate.detail}`),
      warning_gates: warningGates.map(gate => `${gate.id}: ${gate.detail}`),
    };
  } catch (error) {
    return {
      repo,
      status: 'fail',
      score: 0,
      duration_ms: Date.now() - started,
      failed_gates: ['analysis-error'],
      warning_gates: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function describeDescription(cas: any): string {
  const source = cas.enhanced_system_purpose?.description_source || 'missing';
  const status = cas.enhanced_system_purpose?.description_generation?.status || 'missing';
  const length = String(cas.enhanced_system_purpose?.inferred_description || '').length;
  return `${source}/${status}, ${length} chars`;
}

function describeCapabilities(cas: any): string {
  const names = (cas.capabilities || []).map((capability: any) => capability.name).filter(Boolean);
  return `${names.length}: ${names.slice(0, 6).join(', ') || 'none'}`;
}

function describeDomain(cas: any): string {
  return String(cas.enhanced_system_purpose?.primary_domain || 'missing');
}

function describeEntities(cas: any): string {
  const entities = [
    ...(cas.entities || []),
    ...((cas.database_schema?.entities || []) as any[]),
  ];
  const names = entities.map((entity: any) => entity.name).filter(Boolean);
  return `${names.length}: ${names.slice(0, 6).join(', ') || 'none'}`;
}

function describePatterns(cas: any): string {
  const patterns = cas.architecture_summary?.architectural_patterns || [];
  return `${patterns.length}: ${patterns.slice(0, 6).map((pattern: any) => pattern.name).join(', ') || 'none'}`;
}

function describeRisks(cas: any): string {
  const risks = [
    ...(cas.change_risk_summary?.risks || []),
    ...(cas.system_health?.risk_areas || []),
    ...(cas.test_gaps || []),
  ];
  return `${risks.length} risk/test-gap signals`;
}

function renderMarkdown(report: AnalysisQualityProofReport): string {
  const lines = [
    '# Klauro Analysis Quality Proof',
    '',
    `Generated: ${report.generated_at}`,
    `Status: ${report.status.toUpperCase()}`,
    `Focus: ${report.focus}`,
    `Repos: ${report.selected_eligible_repos} selected / ${report.discovered.eligible} eligible / ${report.discovered.total} discovered`,
    `Summary: ${report.summary.pass} pass, ${report.summary.warn} warn, ${report.summary.fail} fail, average score ${report.summary.average_score}`,
    '',
    '## Failures And Warnings',
    '',
  ];
  const issues = report.results.filter(result => result.status === 'fail' || result.status === 'warn');
  if (issues.length === 0) {
    lines.push('No analyzed repo quality failures or warnings.');
  } else {
    for (const result of issues.slice(0, 50)) {
      lines.push(`### ${result.status.toUpperCase()} ${result.repo.name}`);
      lines.push('');
      lines.push(`Path: \`${result.repo.path}\``);
      lines.push(`Score: ${result.score}, duration: ${result.duration_ms}ms`);
      if (result.error) lines.push(`Error: ${result.error}`);
      if (result.dimensions) {
        lines.push(`Description: ${result.dimensions.system_description}`);
        lines.push(`Domain: ${result.dimensions.domain_inference}`);
        lines.push(`Capabilities: ${result.dimensions.primary_capabilities}`);
        lines.push(`Entities: ${result.dimensions.entities}`);
        lines.push(`Patterns: ${result.dimensions.architectural_patterns}`);
        lines.push(`Risks: ${result.dimensions.risks}`);
      }
      for (const failure of result.failed_gates) lines.push(`- FAIL ${failure}`);
      for (const warning of result.warning_gates) lines.push(`- WARN ${warning}`);
      lines.push('');
    }
  }
  lines.push('## Index');
  lines.push('');
  lines.push('| Repo | Files | Nodes | Edges | Entry points | Entities | Languages | Duration |');
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const result of report.results) {
    if (!result.index) continue;
    lines.push(`| ${result.repo.name} | ${result.index.files ?? ''} | ${result.index.nodes} | ${result.index.edges} | ${result.index.entry_points} | ${result.index.entities} | ${result.index.languages} | ${(result.duration_ms / 1000).toFixed(1)} s |`);
  }
  lines.push('');
  lines.push('## All Results');
  lines.push('');
  lines.push('| Repo | Status | Score | Description | Domain | Capabilities | Patterns |');
  lines.push('| --- | --- | ---: | --- | --- | --- | --- |');
  for (const result of report.results) {
    lines.push([
      result.repo.name,
      result.status,
      String(result.score),
      result.dimensions?.system_description || result.error || result.repo.reason || '',
      result.dimensions?.domain_inference || '',
      result.dimensions?.primary_capabilities || '',
      result.dimensions?.architectural_patterns || '',
    ].map(value => String(value).replace(/\|/g, '/')).join(' | ').replace(/^/, '| ').replace(/$/, ' |'));
  }
  return `${lines.join('\n')}\n`;
}

function describeIndex(cas: CASOutput): RepoProofResult['index'] {
  const files = (cas as { l0_index?: { total_files?: number } }).l0_index?.total_files;
  return {
    nodes: (cas.nodes || []).length,
    edges: (cas.edges || []).length,
    entry_points: (cas.entry_points || []).length,
    entities: (cas.entities || []).length,
    files: typeof files === 'number' ? files : null,
    languages: (cas.system?.technologies?.languages || []).length,
  };
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {
    devRoot: path.join(os.homedir(), 'dev'),
    startIndex: 0,
    concurrency: 1,
    perRepoTimeoutMs: 10 * 60 * 1000,
    focus: 'ui-overview',
    allowWarnings: false,
    repoFilters: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dev-root') args.devRoot = path.resolve(argv[++index]);
    else if (arg === '--max-targets') args.maxTargets = Number(argv[++index]);
    else if (arg === '--start-index') args.startIndex = Number(argv[++index]);
    else if (arg === '--concurrency') args.concurrency = Math.max(1, Number(argv[++index]));
    else if (arg === '--per-repo-timeout-ms') args.perRepoTimeoutMs = Math.max(1, Number(argv[++index]));
    else if (arg === '--per-repo-timeout-seconds') args.perRepoTimeoutMs = Math.max(1, Number(argv[++index])) * 1000;
    else if (arg === '--analysis-focus') args.focus = argv[++index] as AnalysisFocus;
    else if (arg === '--repo-filter' || arg === '--repo') args.repoFilters.push(argv[++index]);
    else if (arg === '--allow-warnings') args.allowWarnings = true;
    else if (arg === '--output') args.outputPath = path.resolve(argv[++index]);
    else if (arg === '--markdown') args.markdownPath = path.resolve(argv[++index]);
    else if (arg === '--help' || arg === '-h') {
      console.log([
        'Usage: npm run analysis-quality-proof -- [options]',
        '',
        'Options:',
        '  --dev-root /path          Root to discover real Git repos. Default ~/dev.',
        '  --max-targets n           Analyze at most n eligible repos.',
        '  --start-index n           Start offset within eligible repos.',
        '  --concurrency n           Concurrent analyses. Default 1.',
        '  --per-repo-timeout-seconds n  Fail a repo after n seconds. Default 600.',
        '  --analysis-focus name     agent-fast, ui-overview, deep-context, or full. Default ui-overview.',
        '  --repo-filter text        Analyze only eligible repos whose name/path contains text. Repeatable.',
        '  --repo text               Alias for --repo-filter.',
        '  --allow-warnings          Pass when there are warnings but no failures.',
        '  --output /path/report.json',
        '  --markdown /path/report.md',
      ].join('\n'));
      process.exit(0);
    }
  }
  return args;
}

if (isDirectCliInvocation('analysis-quality-proof')) {
  runAnalysisQualityProof(parseArgs(process.argv.slice(2))).then(report => {
    console.log(JSON.stringify(report, null, 2));
    if (report.status === 'fail') process.exitCode = 1;
  }).catch(error => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  });
}
