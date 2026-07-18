import * as fs from 'fs-extra';
import * as path from 'path';
import { isDirectCliInvocation } from './cli-invocation';
import { getDescriptionEnrichmentTargets, reviewAnalysisUsefulnessStatic, type DescriptionEnrichmentTarget } from './analysis-usefulness-review';
import {
  generateElementDescriptionInSession,
  validateDescription,
  openEnrichmentSession,
  closeEnrichmentSession,
  type DescriptionTargetKind,
  type EnrichmentSession,
} from './description-enrichment';
import { withAnalysisFocus } from './analysis-focus';
import { runAnalysis } from './analyzer';
import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import { aiService } from '../../../packages/analyzer-core/src/ai/ai-service';

type RunnerStatus = 'pass' | 'warn' | 'fail';

interface RunnerResult {
  repo: string;
  path: string;
  target_kind: string;
  target: string;
  target_id?: string;
  priority: string;
  status: 'generated' | 'generated-still-weak' | 'failed' | 'skipped-system' | 'dry-run';
  before_description_score?: number;
  after_description_score?: number;
  before_remaining_targets?: number;
  after_remaining_targets?: number;
  target_removed_from_queue?: boolean;
  description_validation_status?: 'pass' | 'fail' | 'not-applicable';
  description_validation_reason?: string;
  after_reasons?: string[];
  description?: string;
  error?: string;
}

interface RunnerReport {
  generated_at: string;
  benchmark_type: 'analysis-narrative-enrichment-runner';
  status: RunnerStatus;
  score: number;
  source_cold_review: string;
  summary: {
    reviewed_repos: number;
    queued_targets: number;
    attempted_targets: number;
    generated_targets: number;
    quality_passed_targets: number;
    target_removed_count: number;
    still_weak_targets: number;
    failed_targets: number;
    skipped_system_targets: number;
    skipped_by_resume: number;
    dry_run: boolean;
    stopped_early: boolean;
    stop_reason?: string;
    max_runtime_seconds?: number;
    resume_report?: string;
    remaining_targets_before: number;
    remaining_targets_after: number;
    target_reduction: number;
    average_description_score_before: number;
    average_description_score_after: number;
  };
  results: RunnerResult[];
}

const DEFAULT_COLD_REVIEW = '.klauro-analysis-output-cold-review/latest-report.json';

export async function runAnalysisNarrativeEnrichmentRunner(options: {
  coldReviewPath?: string;
  outputPath?: string;
  markdownPath?: string;
  maxRepos?: number;
  maxTargets?: number;
  maxTargetsPerRepo?: number;
  dryRun?: boolean;
  includeSystemRefresh?: boolean;
  resumeReportPath?: string;
  skipPreviousFailures?: boolean;
  maxRuntimeSeconds?: number;
  repoPattern?: string;
} = {}): Promise<RunnerReport> {
  const coldReviewPath = path.resolve(options.coldReviewPath || path.join(process.cwd(), DEFAULT_COLD_REVIEW));
  const coldReview = await fs.readJson(coldReviewPath);
  const resumeKeys = await loadResumeKeys(options.resumeReportPath, Boolean(options.skipPreviousFailures));
  const repoPattern = options.repoPattern ? new RegExp(options.repoPattern, 'i') : null;
  const debtReviews = (Array.isArray(coldReview.reviews) ? coldReview.reviews : [])
    .filter((review: any) => Array.isArray(review.concerns) && review.concerns.some((concern: string) => /narrative debt/i.test(concern)))
    .filter((review: any) => !repoPattern || repoPattern.test(`${review.repo || ''} ${review.path || ''}`))
    .slice(0, positiveLimit(options.maxRepos));

  const results: RunnerResult[] = [];
  let queuedTargets = 0;
  let skippedByResume = 0;
  let stoppedEarly = false;
  let stopReason: string | undefined;
  const startedAt = Date.now();
  const deadline = options.maxRuntimeSeconds && options.maxRuntimeSeconds > 0
    ? startedAt + options.maxRuntimeSeconds * 1000
    : Number.POSITIVE_INFINITY;

  reviewLoop:
  for (const review of debtReviews) {
    if (Date.now() >= deadline && results.length > 0) {
      stoppedEarly = true;
      stopReason = `max-runtime-seconds:${options.maxRuntimeSeconds}`;
      break;
    }
    const projectPath = String(review.path || '');
    // One load for the whole repo's target batch, not one per target: this
    // session's in-memory cas is mutated directly by each description
    // generation and only flushed to disk on a bounded cadence (see
    // description-enrichment.ts openEnrichmentSession/persistEnrichmentSession).
    let session: EnrichmentSession | null = await openEnrichmentSession(projectPath);
    if (!session) continue;
    let cas = session.cas;

    const before = reviewAnalysisUsefulnessStatic(cas, projectPath, String(review.repo || path.basename(projectPath)), 'ui-overview');
    const beforeTargets = getDescriptionEnrichmentTargets(cas, projectPath);
    const filteredTargets = beforeTargets.filter(target => {
      const key = targetKey(target);
      if (!resumeKeys.has(key)) return true;
      skippedByResume += 1;
      return false;
    });
    const remainingGlobal = positiveLimit(options.maxTargets, queuedTargets);
    const perRepoLimit = Math.min(remainingGlobal, positiveLimit(options.maxTargetsPerRepo));
    const targets = filteredTargets.slice(0, perRepoLimit);
    queuedTargets += targets.length;

    try {
    for (let targetIndex = 0; targetIndex < targets.length; targetIndex += 1) {
      const target = targets[targetIndex];
      if (options.maxTargets && results.length >= options.maxTargets) break;
      if (Date.now() >= deadline && results.length > 0) {
        stoppedEarly = true;
        stopReason = `max-runtime-seconds:${options.maxRuntimeSeconds}`;
        break reviewLoop;
      }
      if (!session || session.aborted) {
        // Lost the in-memory session (a system refresh failed to reopen one,
        // or a concurrent analyze/reanalyze replaced the CAS mid-batch and
        // persistEnrichmentSession aborted rather than clobber it). Stop this
        // repo's batch here rather than continuing against nothing/stale
        // state; the remaining targets stay queued for a future run.
        results.push({
          repo: String(review.repo || path.basename(projectPath)),
          path: projectPath,
          target_kind: target.target_kind,
          target: target.target,
          target_id: target.target_id,
          priority: target.priority,
          before_description_score: descriptionGateScore(before),
          before_remaining_targets: beforeTargets.length,
          status: 'failed',
          after_description_score: descriptionGateScore(before),
          after_remaining_targets: beforeTargets.length,
          target_removed_from_queue: false,
          error: session?.abortReason ? `enrichment session aborted: ${session.abortReason}` : 'enrichment session unavailable after system refresh',
        });
        break;
      }
      const base = {
        repo: String(review.repo || cas.system?.name || path.basename(projectPath)),
        path: projectPath,
        target_kind: target.target_kind,
        target: target.target,
        target_id: target.target_id,
        priority: target.priority,
        before_description_score: descriptionGateScore(before),
        before_remaining_targets: beforeTargets.length,
      };

      if (options.dryRun) {
        results.push({
          ...base,
          status: 'dry-run',
          after_description_score: base.before_description_score,
          after_remaining_targets: beforeTargets.length,
          target_removed_from_queue: false,
        });
        continue;
      }

      if (target.suggested_tool === 'run_analysis_layer') {
        if (!options.includeSystemRefresh) {
          results.push({ ...base, status: 'skipped-system' });
          continue;
        }
        try {
          // runAnalysis regenerates and saves a brand-new CAS on disk under
          // this same session's nose; the in-memory session.cas is now stale
          // by construction (different analysis_id), so drop it without a
          // final persist (nothing pending is lost — this branch never wrote
          // through the session) and re-open fresh from what runAnalysis just
          // saved before continuing the batch.
          await withAnalysisFocus('ui-overview', () => runAnalysis(projectPath, { forceFull: false }));
          session = await openEnrichmentSession(projectPath);
          const afterCas = session?.cas ?? null;
          cas = afterCas ?? cas;
          const after = afterCas
            ? reviewAnalysisUsefulnessStatic(afterCas, projectPath, base.repo, 'ui-overview')
            : before;
          const afterTargets = afterCas ? getDescriptionEnrichmentTargets(afterCas, projectPath) : beforeTargets;
          const remainingTarget = findRemainingTarget(afterTargets, target);
          results.push({
            ...base,
            status: remainingTarget ? 'generated-still-weak' : 'generated',
            after_description_score: descriptionGateScore(after),
            after_remaining_targets: afterTargets.length,
            target_removed_from_queue: !remainingTarget,
            after_reasons: remainingTarget?.reasons.slice(0, 4),
          });
          // A system refresh regenerates the CAS, so capabilities may have been
          // renamed; the pre-refresh queue for this repo would then chase stale
          // names ("Could not find capability matching: ..."). Requeue the rest
          // of this repo's budget from the refreshed target list.
          if (afterCas) {
            const processedKeys = new Set(targets.slice(0, targetIndex + 1).map(targetKey));
            const staleTailLength = targets.length - targetIndex - 1;
            const refreshedTail = afterTargets
              .filter(next => !processedKeys.has(targetKey(next)) && !resumeKeys.has(targetKey(next)))
              .slice(0, Math.max(0, staleTailLength));
            targets.splice(targetIndex + 1, staleTailLength, ...refreshedTail);
            queuedTargets += refreshedTail.length - staleTailLength;
          }
          if (!session) break;
        } catch (error) {
          results.push({
            ...base,
            status: 'failed',
            after_description_score: base.before_description_score,
            after_remaining_targets: beforeTargets.length,
            target_removed_from_queue: false,
            error: errorMessage(error),
          });
        }
        continue;
      }

      try {
        const generated = await withAnalysisFocus('ui-overview', () => generateDescriptionForRunnerTarget(session!, target));
        // No reload: generateElementDescriptionInSession mutated session.cas
        // in place, so it already reflects this target's applied description
        // (and any prior ones in this batch) without a disk round-trip.
        const afterCas = session.cas;
        const after = afterCas
          ? reviewAnalysisUsefulnessStatic(afterCas, projectPath, base.repo, 'ui-overview')
          : before;
        const afterTargets = afterCas ? getDescriptionEnrichmentTargets(afterCas, projectPath) : beforeTargets;
        const remainingTarget = findRemainingTarget(afterTargets, target);
        const validation = assessGeneratedDescriptionQuality(generated.description, target, afterCas || cas);
        const stillWeak = Boolean(remainingTarget) || !validation.ok;
        results.push({
          ...base,
          status: stillWeak ? 'generated-still-weak' : 'generated',
          after_description_score: descriptionGateScore(after),
          after_remaining_targets: afterTargets.length,
          target_removed_from_queue: !remainingTarget,
          description_validation_status: validation.ok ? 'pass' : 'fail',
          description_validation_reason: validation.reason,
          after_reasons: [
            ...(remainingTarget?.reasons.slice(0, 4) || []),
            ...(!validation.ok && validation.reason ? [`generated description ${validation.reason}`] : []),
          ],
          description: generated.description,
        });
      } catch (error) {
        results.push({
          ...base,
          status: 'failed',
          after_description_score: base.before_description_score,
          after_remaining_targets: beforeTargets.length,
          target_removed_from_queue: false,
          error: errorMessage(error),
        });
        // A thrown persistEnrichmentSession abort means the on-disk analysis
        // was replaced underneath us; stop this repo's batch rather than
        // keep applying descriptions to an in-memory cas nobody will read.
        if (session?.aborted) break;
      }
    }
    } finally {
      // Bounded persistence means the session can be carrying unflushed
      // descriptions when the target loop ends (normal completion, maxTargets
      // cutoff, or a mid-repo `break reviewLoop`); flush them here so a run
      // never silently drops generated descriptions it already paid AI cost
      // for. No-ops if already flushed, aborted, or nothing is pending. Swallow
      // (rather than throw from) a conflict detected only at this final flush
      // so it can never mask an in-flight loop-control exception (e.g. the
      // max-runtime `break reviewLoop` above) — the next run's queue still
      // covers whatever this flush failed to persist.
      if (session) await closeEnrichmentSession(session).catch(() => undefined);
    }
  }

  const generatedTargets = results.filter(result => result.status === 'generated' || result.status === 'generated-still-weak').length;
  const qualityPassedTargets = results.filter(result => result.status === 'generated').length;
  const targetRemovedCount = results.filter(result => result.target_removed_from_queue).length;
  const stillWeakTargets = results.filter(result => result.status === 'generated-still-weak').length;
  const failedTargets = results.filter(result => result.status === 'failed').length;
  const skippedSystemTargets = results.filter(result => result.status === 'skipped-system').length;
  const attemptedTargets = results.filter(result => result.status === 'generated' || result.status === 'generated-still-weak' || result.status === 'failed').length;
  const remainingTargetsBefore = sumFinite(results.map(result => result.before_remaining_targets));
  const remainingTargetsAfter = sumFinite(results.map(result => result.after_remaining_targets));
  const targetReduction = Math.max(0, remainingTargetsBefore - remainingTargetsAfter);
  const score = Math.max(0, Math.round(100 - failedTargets * 8 - stillWeakTargets * 6 - skippedSystemTargets * 2));
  const status: RunnerStatus = failedTargets > 0 || stillWeakTargets > 0
    ? 'warn'
    : generatedTargets > 0 || options.dryRun ? 'pass' : 'fail';
  const report: RunnerReport = {
    generated_at: new Date().toISOString(),
    benchmark_type: 'analysis-narrative-enrichment-runner',
    status,
    score,
    source_cold_review: coldReviewPath,
    summary: {
      reviewed_repos: debtReviews.length,
      queued_targets: queuedTargets,
      attempted_targets: attemptedTargets,
      generated_targets: generatedTargets,
      quality_passed_targets: qualityPassedTargets,
      target_removed_count: targetRemovedCount,
      still_weak_targets: stillWeakTargets,
      failed_targets: failedTargets,
      skipped_system_targets: skippedSystemTargets,
      skipped_by_resume: skippedByResume,
      dry_run: Boolean(options.dryRun),
      stopped_early: stoppedEarly,
      stop_reason: stopReason,
      max_runtime_seconds: options.maxRuntimeSeconds,
      resume_report: options.resumeReportPath ? path.resolve(options.resumeReportPath) : undefined,
      remaining_targets_before: remainingTargetsBefore,
      remaining_targets_after: remainingTargetsAfter,
      target_reduction: targetReduction,
      average_description_score_before: roundedAverage(results.map(result => result.before_description_score)),
      average_description_score_after: roundedAverage(results.map(result => result.after_description_score)),
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

async function loadResumeKeys(resumeReportPath: string | undefined, includeFailures: boolean): Promise<Set<string>> {
  if (!resumeReportPath) return new Set();
  const resolved = path.resolve(resumeReportPath);
  if (!await fs.pathExists(resolved)) return new Set();
  const report = await fs.readJson(resolved);
  const results = Array.isArray(report.results) ? report.results : [];
  const statuses = new Set(includeFailures
    ? ['generated', 'generated-still-weak', 'failed']
    : ['generated']);
  return new Set(results
    .filter((result: any) => statuses.has(String(result.status || '')))
    .map(resultTargetKey)
    .filter(Boolean));
}

function findRemainingTarget(targets: DescriptionEnrichmentTarget[], original: DescriptionEnrichmentTarget): DescriptionEnrichmentTarget | undefined {
  const originalKey = targetKey(original);
  return targets.find(target => targetKey(target) === originalKey)
    || targets.find(target => target.target_kind === original.target_kind && normalizeTargetName(target.target) === normalizeTargetName(original.target));
}

async function generateDescriptionForRunnerTarget(session: EnrichmentSession, target: DescriptionEnrichmentTarget) {
  const attempts = descriptionGenerationAttempts(target);
  let lastError: unknown;
  for (const attempt of attempts) {
    try {
      return await generateElementDescriptionInSession(session, {
        target: attempt.target,
        targetKind: attempt.targetKind,
        instructions: attempt.instructions,
      });
    } catch (error) {
      lastError = error;
      if (!isMissingDescriptionTargetError(error)) throw error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError || 'Could not generate description'));
}

export function descriptionGenerationAttempts(target: DescriptionEnrichmentTarget): Array<{
  target: string;
  targetKind?: DescriptionTargetKind;
  instructions: string;
}> {
  const suggestedKind = String(target.suggested_args.target_kind || target.target_kind || '');
  const targetKind = suggestedKind === 'system' ? undefined : suggestedKind as DescriptionTargetKind | undefined;
  const instructions = String(target.suggested_args.instructions || '');
  const candidates = [
    target.suggested_args.target,
    target.target_id,
    target.target,
  ]
    .map(value => String(value || '').trim())
    .filter(Boolean);
  return Array.from(new Set(candidates)).map(candidate => ({
    target: candidate,
    targetKind,
    instructions,
  }));
}

function isMissingDescriptionTargetError(error: unknown): boolean {
  return /Could not find .* matching:/i.test(errorMessage(error));
}

function targetKey(target: DescriptionEnrichmentTarget): string {
  return [
    target.target_kind,
    target.target_id || '',
    target.target || '',
  ].join('::').toLowerCase();
}

function normalizeTargetName(value: string | undefined): string {
  return String(value || '').trim().toLowerCase();
}

function resultTargetKey(result: any): string {
  return [
    result.target_kind || '',
    result.target_id || '',
    result.target || '',
  ].join('::').toLowerCase();
}

function positiveLimit(limit: number | undefined, alreadyUsed = 0): number {
  if (!limit || limit < 1) return Number.MAX_SAFE_INTEGER;
  return Math.max(0, limit - alreadyUsed);
}

function descriptionGateScore(review: ReturnType<typeof reviewAnalysisUsefulnessStatic>): number {
  return Number(review.gates.find(gate => gate.id === 'description-quality')?.score || 0);
}

export function assessGeneratedDescriptionQuality(
  description: string,
  target: DescriptionEnrichmentTarget,
  cas: CASOutput,
): { ok: boolean; reason?: string } {
  if (!description || !description.trim()) return { ok: false, reason: 'missing-description' };
  if (target.target_kind === 'system') return { ok: true };
  const lower = description.toLowerCase();
  if (/\bacross different\b/i.test(description)) {
    return { ok: false, reason: 'generic-cross-platform-claim' };
  }
  const targetTokens = distinctiveTargetTokens(target.target);
  if (!isGenericAnalyzerCapabilityTarget(target) && targetTokens.length > 0 && !targetTokens.some(token => lower.includes(token))) {
    return { ok: false, reason: 'target-name-not-grounded' };
  }
  const subject = resolveDescriptionSubject(target, cas);
  return validateDescription(description, subject, cas);
}

function isGenericAnalyzerCapabilityTarget(target: DescriptionEnrichmentTarget): boolean {
  return target.target_kind === 'capability' &&
    /\b(?:mutation|query|handler|controller|route|page|component|command|function|method|file|event|message|http|api|graphql|click|submit|select|input|change|hover|mouse|keyboard|keypress|keydown|keyup)\s+management\b/i.test(target.target || '');
}

function distinctiveTargetTokens(value: string): string[] {
  const generic = new Set([
    'management', 'manager', 'service', 'services', 'handler', 'handlers', 'controller',
    'controllers', 'component', 'components', 'module', 'modules', 'system', 'operation',
    'operations', 'data', 'api', 'entry', 'point', 'points',
  ]);
  return String(value || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(token => token.length > 2 && !generic.has(token));
}

function resolveDescriptionSubject(target: DescriptionEnrichmentTarget, cas: CASOutput): {
  kind: any;
  name: string;
  target: any;
} {
  const targetId = target.target_id || String(target.suggested_args?.target || '');
  const targetName = target.target;
  if (target.target_kind === 'capability') {
    const capability = (cas.system_capabilities || []).find(item => item.id === targetId || item.name === targetName) || {
      id: targetId,
      name: targetName,
    };
    return { kind: 'capability', name: capability.name || targetName, target: capability };
  }
  if (target.target_kind === 'entity') {
    const entity = [
      ...(cas.data_entities || []),
      ...((cas.database_schema?.entities || []) as any[]),
    ].find(item => item.id === targetId || item.name === targetName) || {
      id: targetId,
      name: targetName,
    };
    return { kind: 'entity', name: entity.name || targetName, target: entity };
  }
  if (target.target_kind === 'entry_point') {
    const entryPoint = (cas.entry_points || []).find(item => item.id === targetId || item.name === targetName) || {
      id: targetId,
      name: targetName,
    };
    return { kind: 'entry_point', name: entryPoint.name || targetName, target: entryPoint };
  }
  const node = (cas.nodes || []).find(item => item.id === targetId || item.name === targetName) || {
    id: targetId,
    name: targetName,
    type: target.target_kind,
  };
  return {
    kind: target.target_kind === 'service' ? 'service' : 'node',
    name: node.name || targetName,
    target: node,
  };
}

function roundedAverage(values: Array<number | undefined>): number {
  const finite = values.filter((value): value is number => Number.isFinite(value));
  if (finite.length === 0) return 0;
  return Math.round(finite.reduce((sum, value) => sum + value, 0) / finite.length);
}

function sumFinite(values: Array<number | undefined>): number {
  return values
    .filter((value): value is number => Number.isFinite(value))
    .reduce((sum, value) => sum + value, 0);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function renderMarkdown(report: RunnerReport): string {
  return [
    '# Klauro Narrative Enrichment Runner',
    '',
    `Generated: ${report.generated_at}`,
    `Status: **${report.status.toUpperCase()}** (${report.score}/100)`,
    '',
    '## Summary',
    '',
    `- Reviewed repos: ${report.summary.reviewed_repos}`,
    `- Queued targets: ${report.summary.queued_targets}`,
    `- Attempted targets: ${report.summary.attempted_targets}`,
    `- Generated targets: ${report.summary.generated_targets}`,
    `- Quality-passed targets: ${report.summary.quality_passed_targets}`,
    `- Targets removed from queue: ${report.summary.target_removed_count}`,
    `- Still-weak targets: ${report.summary.still_weak_targets}`,
    `- Failed targets: ${report.summary.failed_targets}`,
    `- Skipped system refresh targets: ${report.summary.skipped_system_targets}`,
    `- Skipped by resume: ${report.summary.skipped_by_resume}`,
    `- Stopped early: ${report.summary.stopped_early}${report.summary.stop_reason ? ` (${report.summary.stop_reason})` : ''}`,
    `- Remaining targets before/after: ${report.summary.remaining_targets_before} -> ${report.summary.remaining_targets_after}`,
    `- Target reduction: ${report.summary.target_reduction}`,
    `- Description score before: ${report.summary.average_description_score_before}`,
    `- Description score after: ${report.summary.average_description_score_after}`,
    '',
    '## Results',
    '',
    '| Repo | Target | Status | Description | Error |',
    '| --- | --- | --- | --- | --- |',
    ...report.results.map(result => `| ${escapeMd(result.repo)} | ${escapeMd(`${result.target_kind}:${result.target}`)} | ${result.status} | ${escapeMd(result.description || '')} | ${escapeMd(result.error || result.after_reasons?.join('; ') || '')} |`),
    '',
  ].join('\n');
}

function escapeMd(value: unknown): string {
  return String(value || '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function parseArgs(argv: string[]) {
  const options: {
    coldReviewPath?: string;
    outputPath?: string;
    markdownPath?: string;
    maxRepos?: number;
    maxTargets?: number;
    maxTargetsPerRepo?: number;
    dryRun?: boolean;
    includeSystemRefresh?: boolean;
    resumeReportPath?: string;
    skipPreviousFailures?: boolean;
    maxRuntimeSeconds?: number;
    repoPattern?: string;
  } = {
    outputPath: path.resolve(process.cwd(), '.klauro-analysis-narrative-enrichment-runner/latest-report.json'),
    markdownPath: path.resolve(process.cwd(), '.klauro-analysis-narrative-enrichment-runner/latest-report.md'),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--cold-review') options.coldReviewPath = path.resolve(argv[++index]);
    else if (arg === '--output') options.outputPath = path.resolve(argv[++index]);
    else if (arg === '--markdown') options.markdownPath = path.resolve(argv[++index]);
    else if (arg === '--max-repos') options.maxRepos = Number(argv[++index]);
    else if (arg === '--max-targets') options.maxTargets = Number(argv[++index]);
    else if (arg === '--max-targets-per-repo') options.maxTargetsPerRepo = Number(argv[++index]);
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--include-system-refresh') options.includeSystemRefresh = true;
    else if (arg === '--resume-report') options.resumeReportPath = path.resolve(argv[++index]);
    else if (arg === '--skip-previous-failures') options.skipPreviousFailures = true;
    else if (arg === '--max-seconds') options.maxRuntimeSeconds = Number(argv[++index]);
    else if (arg === '--repo-pattern') options.repoPattern = argv[++index];
    else if (arg === '--help' || arg === '-h') {
      console.log([
        'Usage: npm run analysis-narrative-enrichment-runner -- [options]',
        '',
        'Options:',
        '  --cold-review path       Cold review JSON to execute',
        '  --max-repos n            Limit reviewed repos',
        '  --max-targets n          Limit generated targets',
        '  --max-targets-per-repo n Limit generated targets in each repo',
        '  --dry-run                Plan without generating descriptions',
        '  --include-system-refresh Run ui-overview refresh targets as well as element descriptions',
        '  --resume-report path     Skip targets already generated in a previous runner report',
        '  --skip-previous-failures Also skip previous failed or still-weak targets when resuming',
        '  --max-seconds n          Stop after a bounded wall-clock budget between targets',
        '  --repo-pattern regex     Only run repos whose name/path matches the pattern',
        '  --output path            Write JSON report',
        '  --markdown path          Write Markdown report',
      ].join('\n'));
      process.exit(0);
    }
  }
  return options;
}

async function main(): Promise<void> {
  try {
    const report = await runAnalysisNarrativeEnrichmentRunner(parseArgs(process.argv.slice(2)));
    console.log(JSON.stringify(report, null, 2));
    if (report.status === 'fail') process.exitCode = 1;
  } finally {
    await aiService.close();
  }
}

if (isDirectCliInvocation('analysis-narrative-enrichment-runner')) {
  main().then(() => {
    setImmediate(() => process.exit(process.exitCode || 0));
  }).catch(error => {
    console.error(error);
    process.exitCode = 1;
    setImmediate(() => process.exit(process.exitCode || 1));
  });
}
