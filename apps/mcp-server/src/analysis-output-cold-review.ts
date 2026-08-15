import * as fs from 'fs-extra';
import * as path from 'path';
import { isDirectCliInvocation } from './cli-invocation';

type ReviewStatus = 'pass' | 'warn' | 'fail';

interface MachineRepoResult {
  name: string;
  path: string;
  status: string;
  proof_status?: string;
  source_files?: number;
  cas?: {
    nodes?: number;
    edges?: number;
    capabilities?: number;
    codebase_idioms?: number;
    behavioral_invariants?: number;
    primary_domain?: string;
    description_source?: string;
    description_generation?: {
      status?: string;
      attempted?: boolean;
      reason?: string;
    };
  };
  usefulness_review?: {
    status?: ReviewStatus;
    score?: number;
    profile?: { kind?: string };
    gates?: Array<{ id?: string; status?: ReviewStatus; score?: number; detail?: string }>;
    summary?: {
      description?: string;
      agent_context_tokens?: number;
      agent_context_files?: number;
      missing_agent_value?: string[];
    };
  };
}

interface ColdReviewItem {
  category: 'large-app' | 'infrastructure' | 'library-sdk' | 'small-simple' | 'klauro-self';
  repo: string;
  path: string;
  profile_kind: string;
  source_files: number;
  nodes: number;
  agent_context_score: number;
  narrative_score: number;
  product_output_score: number;
  status: ReviewStatus;
  verdict: string;
  strengths: string[];
  concerns: string[];
}

interface ColdReviewReport {
  generated_at: string;
  benchmark_type: 'analysis-output-cold-review';
  source_report: string;
  status: ReviewStatus;
  score: number;
  summary: {
    sample_count: number;
    categories: Record<string, number>;
    average_agent_context_score: number;
    average_narrative_score: number;
    average_product_output_score: number;
    narrative_debt_count: number;
    fail_count: number;
  };
  reviews: ColdReviewItem[];
}

const DEFAULT_MACHINE_REPORT = '.klauro-agent-proof-machine/latest-report.json';

export async function runAnalysisOutputColdReview(options: {
  machineReportPath?: string;
  outputPath?: string;
  markdownPath?: string;
} = {}): Promise<ColdReviewReport> {
  const sourceReport = path.resolve(options.machineReportPath || path.join(process.cwd(), DEFAULT_MACHINE_REPORT));
  const machine = await fs.readJson(sourceReport);
  const repos: MachineRepoResult[] = (machine.repo_results || []).filter((repo: MachineRepoResult) =>
    repo.status === 'eligible' && repo.usefulness_review && repo.proof_status !== 'skipped'
  );
  const selected = selectRepresentativeRepos(repos);
  const reviews = selected.map(reviewColdOutput);
  const report = buildReport(sourceReport, reviews);

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

export function selectRepresentativeRepos(repos: MachineRepoResult[]): MachineRepoResult[] {
  const selected: MachineRepoResult[] = [];
  const add = (repo: MachineRepoResult | undefined) => {
    if (repo && !selected.some(item => item.path === repo.path)) selected.push(repo);
  };

  const byKind = (kinds: string[]) => repos.filter(repo => kinds.includes(repo.usefulness_review?.profile?.kind || ''));
  const bySizeDesc = (items: MachineRepoResult[]) => [...items].sort((a, b) => (b.source_files || 0) - (a.source_files || 0));
  const bySizeAsc = (items: MachineRepoResult[]) => [...items].sort((a, b) => (a.source_files || 0) - (b.source_files || 0));

  bySizeDesc(byKind(['backend-service', 'frontend-app', 'desktop-app', 'mobile-app', 'worker-service']))
    .slice(0, 3)
    .forEach(add);
  bySizeDesc(byKind(['infrastructure'])).slice(0, 3).forEach(add);
  bySizeDesc(byKind(['library-package'])).slice(0, 3).forEach(add);
  bySizeAsc(repos.filter(repo => (repo.source_files || 0) > 0 && (repo.source_files || 0) <= 40))
    .slice(0, 3)
    .forEach(add);
  add(repos.find(repo => /\/unravl\/proof-of-concept$/.test(repo.path) || /\/klauro\/proof-of-concept$/.test(repo.path)));

  return selected;
}

function reviewColdOutput(repo: MachineRepoResult): ColdReviewItem {
  const usefulness = repo.usefulness_review!;
  const descriptionGate = (usefulness.gates || []).find(gate => gate.id === 'description-quality' || gate.id === 'description-layering');
  const architectureGate = (usefulness.gates || []).find(gate => gate.id === 'architecture-agent-context');
  const agentContextScore = clamp(Math.round(Number(usefulness.score || 0) - contextPenalty(repo)));
  const narrativeScore = scoreNarrative(repo, descriptionGate);
  const productOutputScore = clamp(Math.round(agentContextScore * 0.65 + narrativeScore * 0.35));
  const concerns = concernsFor(repo, descriptionGate, architectureGate);
  const strengths = strengthsFor(repo, architectureGate);
  const status: ReviewStatus = concerns.some(concern => /^fail:/i.test(concern))
    ? 'fail'
    : productOutputScore >= 90 && (narrativeScore >= 75 || concerns.length === 0)
      ? 'pass'
      : 'warn';

  return {
    category: categoryFor(repo),
    repo: repo.name,
    path: repo.path,
    profile_kind: usefulness.profile?.kind || 'unknown',
    source_files: repo.source_files || 0,
    nodes: repo.cas?.nodes || 0,
    agent_context_score: agentContextScore,
    narrative_score: narrativeScore,
    product_output_score: productOutputScore,
    status,
    verdict: verdictFor(status, agentContextScore, narrativeScore),
    strengths,
    concerns,
  };
}

function scoreNarrative(repo: MachineRepoResult, descriptionGate?: { score?: number; detail?: string; status?: ReviewStatus }): number {
  const source = repo.cas?.description_source || '';
  const generation = repo.cas?.description_generation;
  const base = Number(descriptionGate?.score || 0);




  const trusted = /^(ai|manual|reused|reused-ai|ai-reviewed-deterministic)$/i.test(source);
  if (trusted && descriptionGate?.status === 'pass') return clamp(Math.max(base, 90));
  if (generation?.attempted === false || /deterministic/i.test(source)) return clamp(Math.min(base || 65, 72));
  if (descriptionGate?.status === 'fail') return clamp(Math.min(base || 45, 50));
  return clamp(base || 70);
}

function concernsFor(
  repo: MachineRepoResult,
  descriptionGate?: { score?: number; detail?: string; status?: ReviewStatus },
  architectureGate?: { status?: ReviewStatus; detail?: string }
): string[] {
  const concerns: string[] = [];
  if (repo.usefulness_review?.status !== 'pass') concerns.push(`fail: usefulness review status is ${repo.usefulness_review?.status || 'missing'}`);
  if (architectureGate?.status === 'fail') concerns.push(`fail: architecture context weak (${architectureGate.detail || 'no detail'})`);
  if (descriptionGate?.status !== 'pass') concerns.push(`narrative debt: ${descriptionGate?.detail || 'description quality not proven'}`);
  if ((repo.cas?.capabilities || 0) === 0 && repo.usefulness_review?.profile?.kind !== 'infrastructure') concerns.push('no capabilities for agent/product orientation');
  if ((repo.cas?.codebase_idioms || 0) === 0) concerns.push('no repo-local idioms extracted');
  if ((repo.usefulness_review?.summary?.agent_context_tokens || 0) > 5000) concerns.push(`large agent context: ${repo.usefulness_review?.summary?.agent_context_tokens} estimated tokens`);
  return concerns;
}

function strengthsFor(repo: MachineRepoResult, architectureGate?: { status?: ReviewStatus }): string[] {
  const strengths: string[] = [];
  if (repo.cas?.primary_domain) strengths.push(`domain: ${repo.cas.primary_domain}`);
  if ((repo.cas?.capabilities || 0) > 0) strengths.push(`${repo.cas?.capabilities} capabilities`);
  if ((repo.cas?.codebase_idioms || 0) > 0) strengths.push(`${repo.cas?.codebase_idioms} idioms`);
  if ((repo.cas?.behavioral_invariants || 0) > 0) strengths.push(`${repo.cas?.behavioral_invariants} invariants`);
  if (architectureGate?.status === 'pass') strengths.push('actionable architecture context');
  return strengths;
}

function categoryFor(repo: MachineRepoResult): ColdReviewItem['category'] {
  const kind = repo.usefulness_review?.profile?.kind || '';
  if (/\/unravl\/proof-of-concept$/.test(repo.path) || /\/klauro\/proof-of-concept$/.test(repo.path)) return 'klauro-self';
  if (kind === 'infrastructure') return 'infrastructure';
  if (kind === 'library-package') return 'library-sdk';
  if ((repo.source_files || 0) <= 40) return 'small-simple';
  return 'large-app';
}

function contextPenalty(repo: MachineRepoResult): number {
  const tokens = repo.usefulness_review?.summary?.agent_context_tokens || 0;
  if (tokens > 10000) return 20;
  if (tokens > 5000) return 10;
  return 0;
}

function buildReport(sourceReport: string, reviews: ColdReviewItem[]): ColdReviewReport {
  const failCount = reviews.filter(review => review.status === 'fail').length;
  const warnCount = reviews.filter(review => review.status === 'warn').length;
  const score = Math.round(average(reviews.map(review => review.product_output_score)));
  return {
    generated_at: new Date().toISOString(),
    benchmark_type: 'analysis-output-cold-review',
    source_report: sourceReport,
    status: failCount > 0 ? 'fail' : warnCount > 0 ? 'warn' : 'pass',
    score,
    summary: {
      sample_count: reviews.length,
      categories: reviews.reduce<Record<string, number>>((counts, review) => {
        counts[review.category] = (counts[review.category] || 0) + 1;
        return counts;
      }, {}),
      average_agent_context_score: Math.round(average(reviews.map(review => review.agent_context_score))),
      average_narrative_score: Math.round(average(reviews.map(review => review.narrative_score))),
      average_product_output_score: score,
      narrative_debt_count: reviews.filter(review => review.concerns.some(concern => /narrative debt/i.test(concern))).length,
      fail_count: failCount,
    },
    reviews,
  };
}

function renderMarkdown(report: ColdReviewReport): string {
  return [
    '# Klauro Analysis Output Cold Review',
    '',
    `Generated: ${report.generated_at}`,
    `Status: **${report.status.toUpperCase()}** (${report.score}/100)`,
    `Source report: ${report.source_report}`,
    '',
    '## Summary',
    '',
    `- Sampled outputs: ${report.summary.sample_count}`,
    `- Categories: ${Object.entries(report.summary.categories).map(([name, count]) => `${name} ${count}`).join(', ')}`,
    `- Average agent-context score: ${report.summary.average_agent_context_score}`,
    `- Average narrative score: ${report.summary.average_narrative_score}`,
    `- Narrative debt count: ${report.summary.narrative_debt_count}`,
    '',
    '## Reviews',
    '',
    '| Repo | Category | Status | Product | Agent | Narrative | Concerns |',
    '|---|---|---:|---:|---:|---:|---|',
    ...report.reviews.map(review => [
      review.repo,
      review.category,
      review.status,
      String(review.product_output_score),
      String(review.agent_context_score),
      String(review.narrative_score),
      review.concerns.join('; ') || 'none',
    ].join(' | ')).map(row => `| ${row} |`),
    '',
  ].join('\n');
}

function verdictFor(status: ReviewStatus, agentScore: number, narrativeScore: number): string {
  if (status === 'fail') return 'Not good enough for default product trust.';
  if (status === 'pass') return 'Useful product output for a cold agent and human reviewer.';
  if (narrativeScore < 75) return 'Agent context is useful, but human-facing narrative still needs AI enrichment.';
  if (agentScore < 90) return 'Narrative is acceptable, but the MCP agent context needs sharper agent context.';
  return 'Useful product output for a cold agent and human reviewer.';
}

function average(values: number[]): number {
  const finite = values.filter(value => Number.isFinite(value));
  if (!finite.length) return 0;
  return finite.reduce((sum, value) => sum + value, 0) / finite.length;
}

function clamp(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function parseArgs(argv: string[]): { machineReportPath?: string; outputPath?: string; markdownPath?: string } {
  const options: { machineReportPath?: string; outputPath?: string; markdownPath?: string } = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--machine-report') options.machineReportPath = path.resolve(argv[++index]);
    else if (arg === '--output') options.outputPath = path.resolve(argv[++index]);
    else if (arg === '--markdown') options.markdownPath = path.resolve(argv[++index]);
    else if (arg === '--help' || arg === '-h') {
      console.log([
        'Usage: npm run analysis-output-cold-review -- [options]',
        '',
        'Options:',
        '  --machine-report /path/report.json   Read machine proof report',
        '  --output /path/report.json           Write JSON report',
        '  --markdown /path/report.md           Write Markdown report',
      ].join('\n'));
      process.exit(0);
    }
  }
  return options;
}

async function main(): Promise<void> {
  const report = await runAnalysisOutputColdReview(parseArgs(process.argv.slice(2)));
  console.log(JSON.stringify(report, null, 2));
  if (report.status === 'fail') process.exitCode = 1;
}

if (isDirectCliInvocation('analysis-output-cold-review')) {
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
