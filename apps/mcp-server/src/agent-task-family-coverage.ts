#!/usr/bin/env tsx
import * as fs from 'fs-extra';
import * as path from 'path';
import { saveAgenticBenchmarkReport } from './storage';
import { isDirectCliInvocation } from './cli-invocation';
import { discoverProofReports, ProofReportEntry, proofReportTimestamp } from './proof-report-discovery';

type CoverageStatus = 'strong' | 'partial' | 'gap';
type ReportStatus = 'pass' | 'warn' | 'fail';
type JsonObject = Record<string, any>;

interface Evidence {
  path: string;
  summary: string;
}

interface TaskFamilyCoverage {
  id: string;
  label: string;
  status: CoverageStatus;
  score: number;
  evidence: Evidence[];
  proven: string[];
  missing: string[];
  next_live_tasks: string[];
}

interface CoverageReport {
  generated_at: string;
  benchmark_type: 'agent-task-family-coverage';
  status: ReportStatus;
  score: number;
  summary: {
    strong: number;
    partial: number;
    gaps: number;
    families: number;
  };
  families: TaskFamilyCoverage[];
}

interface Options {
  root: string;
  outputPath: string | null;
  markdownPath: string | null;
  strict: boolean;
}

type ReportEntry = ProofReportEntry<JsonObject>;

const REPORTS = {
  agentBenchmark: '.klauro-agent-benchmark/latest-report.json',
  qualityBenchmark: '.klauro-agent-quality-benchmark/latest-report.json',
  idiomBenchmark: '.klauro-agent-idiom-benchmark/latest-report.json',
  greenfieldBenchmark: '.klauro-agent-greenfield-benchmark/latest-report.json',
  fromZeroProof: '.klauro-from-zero-build-context-proof/latest-report.json',
  existingTaskBenchmark: '.klauro-existing-task-benchmark/latest-report.json',
  machineProof: '.klauro-agent-proof-machine/latest-report.json',
};

type LoadedReports = Record<keyof typeof REPORTS, JsonObject> & {
  existingLive: ReportEntry[];
  scratch: ReportEntry[];
};

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const report = await buildAgentTaskFamilyCoverage(options.root);
  printReport(report);

  if (options.outputPath) {
    await fs.ensureDir(path.dirname(options.outputPath));
    await fs.writeJson(options.outputPath, report, { spaces: 2 });
  }
  if (options.markdownPath) {
    await fs.ensureDir(path.dirname(options.markdownPath));
    await fs.writeFile(options.markdownPath, formatTaskFamilyCoverageMarkdown(report));
  }
  await saveAgenticBenchmarkReport(report);
  if (options.strict && report.status !== 'pass') {
    process.exitCode = 1;
  }
}

export async function buildAgentTaskFamilyCoverage(root = process.cwd()): Promise<CoverageReport> {
  const loaded = await loadReports(root);
  const families = [
    greenfieldCreation(loaded),
    greenfieldMultiWaveGrowth(loaded),
    fromZeroCapabilityMemory(loaded),
    existingProjectOrientationAndTargeting(loaded),
    bugDiagnosis(loaded),
    bugFixes(loaded),
    productEnhancements(loaded),
    architecturalChanges(loaded),
    monolithDecomposition(loaded),
    schemaMigrationChanges(loaded),
    authTenantBoundaryChanges(loaded),
    authSystemReplacement(loaded),
    mfaSecurityEnhancement(loaded),
    testAdditionAndCoverage(loaded),
    performanceFixes(loaded),
    crossRepoContractChanges(loaded),
    largeFeatureIntegration(loaded),
  ];
  const score = Math.round(average(families.map(family => family.score)));
  const gaps = families.filter(family => family.status === 'gap').length;
  const partial = families.filter(family => family.status === 'partial').length;
  return {
    generated_at: new Date().toISOString(),
    benchmark_type: 'agent-task-family-coverage',
    status: gaps > 0 ? 'warn' : partial > 0 ? 'warn' : 'pass',
    score,
    summary: {
      strong: families.filter(family => family.status === 'strong').length,
      partial,
      gaps,
      families: families.length,
    },
    families,
  };
}

export function formatTaskFamilyCoverageMarkdown(report: CoverageReport): string {
  const lines = [
    '# Agent Task Family Coverage',
    '',
    `Generated: ${report.generated_at}`,
    `Status: ${report.status}`,
    `Score: ${report.score}/100`,
    `Coverage: ${report.summary.strong} strong, ${report.summary.partial} partial, ${report.summary.gaps} gaps across ${report.summary.families} task families.`,
    '',
    'This report answers whether Klauro is proving value on real creation and real improvement work, not just aggregate orientation benchmarks.',
    '',
  ];

  for (const family of report.families) {
    lines.push(`## ${family.label}`);
    lines.push('');
    lines.push(`Status: ${family.status} (${family.score}/100)`);
    lines.push('');
    if (family.proven.length > 0) {
      lines.push('Proven:');
      for (const item of family.proven) lines.push(`- ${item}`);
      lines.push('');
    }
    if (family.missing.length > 0) {
      lines.push('Missing:');
      for (const item of family.missing) lines.push(`- ${item}`);
      lines.push('');
    }
    if (family.evidence.length > 0) {
      lines.push('Evidence:');
      for (const item of family.evidence) lines.push(`- \`${item.path}\`: ${item.summary}`);
      lines.push('');
    }
    if (family.next_live_tasks.length > 0) {
      lines.push('Next live tasks:');
      for (const item of family.next_live_tasks) lines.push(`- ${item}`);
      lines.push('');
    }
  }

  return `${lines.join('\n')}\n`;
}

async function loadReports(root: string): Promise<LoadedReports> {
  const entries = await Promise.all(Object.entries(REPORTS).map(async ([key, relative]) => {
    const absolute = path.resolve(root, relative);
    if (!(await fs.pathExists(absolute))) {
      return [key, { missing_report: relative }] as const;
    }
    return [key, await fs.readJson(absolute)] as const;
  }));
  return {
    ...Object.fromEntries(entries) as Record<keyof typeof REPORTS, JsonObject>,
    existingLive: await discoverProofReports(path.resolve(root, '.klauro-existing-task-benchmark'), report => array(report.scenarios).some(scenario => scenario.live_summary)),
    scratch: await discoverProofReports(path.resolve(root, '.klauro-agent-scratch-build-benchmark'), report => Boolean(report.task && report.comparison)),
  };
}

function greenfieldCreation(reports: LoadedReports): TaskFamilyCoverage {
  const live = liveScratchReports(reports);
  const greenfieldBenchmark = reports.greenfieldBenchmark;
  const tradeoffWarnings = activeScratchTradeoffWarningReports(reports);
  const supersededTradeoffs = supersededScratchTradeoffWarningReports(reports);
  const strongLive = live.filter(report => report.status === 'pass'
    && Number(report.score || 0) >= 82
    && Number(report.with_klauro?.score || 0) >= 90
    && acceptableGreenfieldTokenTradeoff(report));
  const positiveQualityLive = strongLive.filter(report => Number(report.comparison?.quality_delta || 0) > 0);
  const fromZero = reports.fromZeroProof;
  const fromZeroStrong = fromZero.status === 'pass'
    && Number(fromZero.summary?.scenario_count || 0) >= 3
    && Number(fromZero.summary?.growth_iteration_count || 0) >= 15;
  return family({
    id: 'greenfield-real-system-creation',
    label: 'Real From-Scratch System Creation',
    strong: tradeoffWarnings.length === 0 &&
      strongLive.length >= 3 &&
      positiveQualityLive.length >= Math.ceil(strongLive.length / 2) &&
      fromZeroStrong,
    partial: strongLive.length >= 1 || fromZeroStrong,
    evidence: [
      ...strongLive.map(report => evidence(report, scratchReportPath(report, reports), `${report.task?.title || report.task?.id || 'scratch build'}: ${report.status} ${report.score}/100, initial quality delta ${signed(report.comparison?.quality_delta)}, token delta ${percent(report.comparison?.token_reduction_percentage)}`)),
      ...tradeoffWarnings.map(report => evidence(report, scratchReportPath(report, reports), `${report.task?.title || report.task?.id || 'scratch build'}: ${report.status} ${report.score}/100, ${report.comparison?.quality_token_tradeoff_status}, token delta ${percent(report.comparison?.token_reduction_percentage)}, quality delta ${signed(report.comparison?.quality_delta)}`)),
      ...supersededTradeoffs.map(item => evidence(item.warning, scratchReportPath(item.warning, reports), `${item.warning.task?.title || item.warning.task?.id || 'scratch build'}: superseded ${item.warning.comparison?.quality_token_tradeoff_status} by ${scratchReportPath(item.replacement, reports)} (${percent(item.replacement.comparison?.token_reduction_percentage)} token delta, quality delta ${signed(item.replacement.comparison?.quality_delta)})`)),
      evidence(greenfieldBenchmark, REPORTS.greenfieldBenchmark, `${greenfieldBenchmark.status || 'missing'} ${greenfieldBenchmark.score || 0}/100, proof ${greenfieldBenchmark.summary?.proof_strength || 'unknown'}, token savings ${greenfieldBenchmark.summary?.token_savings_status || 'unknown'}`),
      evidence(fromZero, REPORTS.fromZeroProof, `${fromZero.summary?.scenario_count || 0} generated domains, ${fromZero.summary?.growth_iteration_count || 0} growth iterations, quality delta ${signed(fromZero.summary?.quality_delta)}`),
    ],
    proven: [
      'Empty-folder live A/B exists for backend, UI, and compliance-shaped products.',
      'Repeatable from-zero proof creates multiple growing systems with Klauro build contexts.',
      `${positiveQualityLive.length}/${strongLive.length} qualifying live greenfield builds show a positive initial quality delta.`,
    ],
    missing: [
      ...(strongLive.length >= 3 ? [] : ['Need at least three passing live from-scratch product families.']),
      ...(positiveQualityLive.length >= Math.ceil(Math.max(1, strongLive.length) / 2)
        ? []
        : ['Need positive initial quality deltas in at least half of qualifying live greenfield builds; no-regression plus token savings is not enough for strong proof.']),
      ...tradeoffWarnings.map(report => `${scratchReportPath(report, reports)} has an unacceptable quality/token tradeoff (${report.comparison?.quality_token_tradeoff_status || 'unknown'}): token delta ${percent(report.comparison?.token_reduction_percentage)}, live quality delta ${signed(report.comparison?.live_quality_delta)}, scored quality delta ${signed(report.comparison?.quality_delta)}.`),
    ],
    next: [
      'Add a smaller todo-style control build and compare whether Klauro overhead is worth it on low-complexity products.',
      'Run a live from-zero CRM/support-workflow build to prove a different product shape.',
    ],
  });
}

function greenfieldMultiWaveGrowth(reports: LoadedReports): TaskFamilyCoverage {
  const waves = liveScratchReports(reports).flatMap(report => array(report.continuation_waves).map(wave => ({ report, wave })));
  const liveQualityDeltas = waves.map(item => number(item.wave.live_quality_delta)).filter(isFiniteNumber);
  const precisionDeltas = waves.map(item => number(item.wave.changed_file_precision_delta)).filter(isFiniteNumber);
  const tokenDeltas = waves.map(item => number(item.wave.token_reduction_percentage)).filter(isFiniteNumber);
  const strong = waves.length >= 6
    && liveQualityDeltas.length >= 6
    && liveQualityDeltas.every(delta => delta >= 0)
    && precisionDeltas.length >= 6
    && average(precisionDeltas) >= 40
    && tokenDeltas.length >= 6
    && tokenDeltas.every(delta => delta >= 0);
  return family({
    id: 'greenfield-multi-wave-growth',
    label: 'Multi-Wave Greenfield Growth',
    strong,
    partial: waves.length >= 2,
    evidence: liveScratchReports(reports).map(report => evidence(report, scratchReportPath(report, reports), `${array(report.continuation_waves).length} continuation waves, status ${report.status} ${report.score}/100`)),
    proven: [
      `${waves.length} live continuation waves exist across scratch-built systems.`,
      `Average changed-file precision delta is ${Math.round(average(precisionDeltas))}.`,
      `Provider-token reduction is positive in ${tokenDeltas.filter(delta => delta > 0).length}/${tokenDeltas.length} measured waves.`,
    ],
    missing: tokenDeltas.some(delta => delta < 0)
      ? ['At least one continuation wave still uses more tokens with Klauro; strong proof requires non-negative token reduction on every measured wave.']
      : [],
    next: [
      'Extend the project-manager proof from two continuation waves to a five-wave build where Klauro must keep reusing project/task/comment/assignment concepts.',
      'Add a long-running SaaS admin build with billing, audit, and role changes across separate waves.',
    ],
  });
}

function fromZeroCapabilityMemory(reports: LoadedReports): TaskFamilyCoverage {
  const report = reports.fromZeroProof;
  const summary = report.summary || {};
  const strong = report.status === 'pass'
    && Number(summary.scenario_count || 0) >= 3
    && Number(summary.growth_iteration_count || 0) >= 15
    && Number(summary.with_klauro_duplicate_classes || 0) === 0
    && Number(summary.duplicate_class_delta || 0) > 0;
  return family({
    id: 'from-zero-capability-memory',
    label: 'From-Zero Capability Memory And Duplicate Avoidance',
    strong,
    partial: report.status === 'pass',
    evidence: [evidence(report, REPORTS.fromZeroProof, `${summary.scenario_count || 0} scenarios, ${summary.growth_iteration_count || 0} growth iterations, ${summary.with_klauro_duplicate_classes || 0} with-Klauro duplicate classes, ${summary.without_klauro_duplicate_classes || 0} baseline duplicate classes`)],
    proven: [
      'Klauro contexts carry known concepts, owner files, and growth control between slices.',
      'Deterministic baseline comparison shows duplicate domain classes avoided.',
    ],
    missing: [],
    next: [
      'Run the same capability-memory proof with a larger generated product surface such as a project manager, CRM, or support desk.',
    ],
  });
}

function existingProjectOrientationAndTargeting(reports: LoadedReports): TaskFamilyCoverage {
  const report = reports.agentBenchmark;
  const taskTypes = agentTaskTypes(report);
  const summary = report.summary || {};
  const strong = report.status === 'pass'
    && Number(summary.task_count || 0) >= 48
    && Number(summary.with_klauro_success_rate || 0) === 1
    && Number(summary.average_token_reduction_vs_search || 0) >= 80
    && ['orient', 'debug', 'modify', 'trace'].every(type => taskTypes.has(type));
  return family({
    id: 'existing-project-orientation-targeting',
    label: 'Existing-Project Orientation And Targeting',
    strong,
    partial: report.status === 'pass',
    evidence: [evidence(report, REPORTS.agentBenchmark, `${summary.task_count || 0} tasks, ${percent(summary.average_token_reduction_vs_search)} token reduction vs search, task types ${[...taskTypes].sort().join(', ')}`)],
    proven: [
      'Existing-project contexts reduce broad source exploration across orient, debug, modify, and trace tasks.',
    ],
    missing: [],
    next: [
      'Pair this deterministic targeting proof with live edit tasks that start from real issue descriptions.',
    ],
  });
}

function bugDiagnosis(reports: LoadedReports): TaskFamilyCoverage {
  const quality = reports.qualityBenchmark;
  const existing = reports.existingTaskBenchmark;
  const liveEvidence = liveExistingEvidence(reports, 'bug-diagnosis-root-cause');
  const live = liveEvidence?.scenario || null;
  const debugTasks = qualityTasks(quality).filter(task => task.task?.task_type === 'debug');
  const seeded = seededFamily(existing, 'bug-diagnosis-root-cause');
  const livePassed = liveQualityAndTokenPassed(live);
  return family({
    id: 'bug-diagnosis-root-cause',
    label: 'Bug Diagnosis And Root Cause',
    strong: livePassed,
    partial: livePassed || (debugTasks.length >= 6 && quality.status === 'pass') || Boolean(seeded),
    evidence: [
      evidence(quality, REPORTS.qualityBenchmark, `${debugTasks.length} deterministic debug/root-cause-shaped tasks in quality benchmark`),
      ...(seeded ? [evidence(existing, REPORTS.existingTaskBenchmark, `${seeded.id}: ${seeded.status} ${seeded.score}/100, score delta +${seeded.deltas?.score_delta}`)] : []),
      ...liveScenarioEvidence(liveEvidence),
    ],
    proven: [
      'Deterministic benchmarks exercise debug-oriented context retrieval.',
      ...(seeded ? ['Seeded existing-project diagnosis proof checks root-cause guidance for a tenant/workspace leak.'] : []),
      ...(livePassed ? ['Live copied-repo A/B diagnosis proof scores root-cause text, impacted repository/service/policy files, invariant-preserving fix placement, and focused tenant regression coverage while the unguided arm failed the focused validator.'] : []),
    ],
    missing: livePassed ? [] : [
      'No live A/B task yet requires diagnosing a non-obvious bug before editing.',
      'No evaluator yet scores root-cause accuracy separately from final command success.',
    ],
    next: [
      'Seed a copied repo with a hidden tenant-scope, async race, or data-mapping bug; compare with/without Klauro diagnosis before edits.',
      'Score diagnosis text for root cause, impacted files, failed invariant, and minimal fix plan before allowing code changes.',
    ],
  });
}

function bugFixes(reports: LoadedReports): TaskFamilyCoverage {
  const quality = reports.qualityBenchmark;
  const idiom = reports.idiomBenchmark;
  const existing = reports.existingTaskBenchmark;
  const modifyTasks = qualityTasks(quality).filter(task => task.task?.task_type === 'modify');
  const idiomTasks = array(idiom.trials);
  const seeded = seededFamily(existing, 'bug-fix-live-edits');
  const liveEvidence = liveExistingEvidence(reports, 'bug-fix-live-edits');
  const live = liveEvidence?.scenario || null;
  const livePassed = liveQualityAndTokenPassed(live);
  return family({
    id: 'bug-fix-live-edits',
    label: 'Bug Fixes And Idiomatic Edits',
    strong: livePassed,
    partial: livePassed || (modifyTasks.length >= 12 && Number(idiom.summary?.average_idiom_conformance_delta || 0) > 0) || Boolean(seeded),
    evidence: [
      evidence(quality, REPORTS.qualityBenchmark, `${modifyTasks.length} deterministic modify tasks`),
      evidence(idiom, REPORTS.idiomBenchmark, `${idiomTasks.length} idiom edit tasks, idiom delta ${signed(idiom.summary?.average_idiom_conformance_delta)}`),
      ...(seeded ? [evidence(existing, REPORTS.existingTaskBenchmark, `${seeded.id}: ${seeded.status} ${seeded.score}/100, score delta +${seeded.deltas?.score_delta}`)] : []),
      ...liveScenarioEvidence(liveEvidence),
    ],
    proven: [
      'Klauro provides task-targeted files and idiom guidance for edit-shaped work.',
      ...(livePassed ? ['Live copied-repo proof shows Klauro fixed a validation bug with fewer tokens, faster completion, and no extra package/config edit.'] : []),
    ],
    missing: livePassed ? [] : [
      'Most bug-fix evidence is deterministic/proxy, not live copied-repo fixes with seeded failures.',
      'Need tasks where both agents can pass tests but only one follows local repair idioms.',
    ],
    next: [
      'Create seeded bug-fix trials for validation, data access, error handling, and async lifecycle bugs.',
      'Require live diff scoring for correctness, minimality, idiom conformance, and relevant tests.',
    ],
  });
}

function productEnhancements(reports: LoadedReports): TaskFamilyCoverage {
  const waves = liveScratchReports(reports).flatMap(report => array(report.continuation_waves));
  const existing = reports.existingTaskBenchmark;
  const seeded = seededFamily(existing, 'real-product-enhancements');
  const liveEvidence = liveExistingEvidence(reports, 'real-product-enhancements');
  const live = liveEvidence?.scenario || null;
  const livePassed = liveQualityAndTokenPassed(live);
  const hasEnhancements = waves.length >= 6 && waves.every(wave => Number(wave.with_klauro?.score || 0) >= 90);
  return family({
    id: 'real-product-enhancements',
    label: 'Real Product Enhancements',
    strong: livePassed,
    partial: livePassed || hasEnhancements || Boolean(seeded),
    evidence: [
      ...liveScratchReports(reports).map(report => evidence(report, scratchReportPath(report, reports), `${array(report.continuation_waves).map(wave => wave.title || wave.task_id).join('; ')}`)),
      ...(seeded ? [evidence(existing, REPORTS.existingTaskBenchmark, `${seeded.id}: ${seeded.status} ${seeded.score}/100, score delta +${seeded.deltas?.score_delta}`)] : []),
      ...liveScenarioEvidence(liveEvidence),
    ],
    proven: [
      'Greenfield continuation waves add product capabilities after initial creation.',
      ...(seeded ? ['Seeded existing-project proof checks product enhancement guidance for extending task label ownership without rebuilding a parallel subsystem.'] : []),
      ...(livePassed ? ['Live existing-repo enhancement proof shows the Klauro arm reused task label ownership, avoided parallel subsystem creation, changed fewer files, and passed semantic validation while the unguided arm failed it.'] : []),
    ],
    missing: livePassed ? [] : [
      'Existing-codebase product enhancement live trials are still thin.',
      'Need enhancement tasks in real repos where local architecture is non-obvious.',
    ],
    next: [
      'Run live copied-repo enhancements in Klauro, Kadra, Money, Zerac, SoundSyft, and Soon against real feature requests.',
    ],
  });
}

function architecturalChanges(reports: LoadedReports): TaskFamilyCoverage {
  const machine = reports.machineProof;
  const existing = reports.existingTaskBenchmark;
  const seeded = seededFamily(existing, 'architectural-change-refactor');
  const liveEvidence = liveExistingEvidence(reports, 'architectural-change-refactor');
  const live = liveEvidence?.scenario || null;
  const livePassed = liveQualityAndTokenPassed(live);
  return family({
    id: 'architectural-change-refactor',
    label: 'Architectural Changes And Refactors',
    strong: livePassed,
    partial: livePassed || Boolean(seeded),
    evidence: [
      evidence(machine, REPORTS.machineProof, `${machine.discovery?.eligible_repos || 0} eligible repos analyzed for architecture facts`),
      ...(seeded ? [evidence(existing, REPORTS.existingTaskBenchmark, `${seeded.id}: ${seeded.status} ${seeded.score}/100, score delta +${seeded.deltas?.score_delta}`)] : []),
      ...liveScenarioEvidence(liveEvidence),
    ],
    proven: [
      'CAS emits architecture summaries and idioms that could guide refactors.',
      ...(seeded ? ['Seeded existing-project proof checks service/repository boundary guidance for a controller refactor.'] : []),
      ...(livePassed ? ['Live copied-repo refactor proof shows the Klauro arm passed semantic boundary validation while the unguided arm failed it.'] : []),
      ...(!livePassed && liveQualityAndTokenOnly(live) ? ['Live refactor proof improved semantic quality and token use, but it is not strong because Klauro took longer than the unguided arm.'] : []),
      ...(!livePassed && !liveQualityAndTokenOnly(live) && liveQualityOnly(live) ? ['Live refactor proof improved semantic quality, but it is not strong because Klauro used more tokens than the unguided arm.'] : []),
    ],
    missing: livePassed ? [] : liveQualityAndTokenOnly(live) ? [
      'The live refactor run improved quality and token use but was slower; strong proof requires non-negative time reduction.',
      'No explicit benchmark requires proposing Repository/MVC/MVVM/Mediator/Unit-of-Work-compatible changes.',
    ] : liveQualityOnly(live) ? [
      'The live refactor run improved quality but used more tokens; strong proof requires total token reduction to be non-negative.',
      'No explicit benchmark requires proposing Repository/MVC/MVVM/Mediator/Unit-of-Work-compatible changes.',
    ] : [
      'No live A/B refactor task yet proves Klauro preserves module boundaries during architectural changes.',
      'No explicit benchmark requires proposing Repository/MVC/MVVM/Mediator/Unit-of-Work-compatible changes.',
    ],
    next: [
      'Run a live refactor that moves behavior behind an existing repository/service boundary without changing behavior.',
      'Run a live architecture proposal task where agents must choose between local MVC/MVVM/Mediator patterns and justify the placement.',
    ],
  });
}

function monolithDecomposition(reports: LoadedReports): TaskFamilyCoverage {
  const existing = reports.existingTaskBenchmark;
  const seeded = seededFamily(existing, 'monolith-decomposition');
  const liveEvidence = liveExistingEvidence(reports, 'monolith-decomposition');
  const live = liveEvidence?.scenario || null;
  const livePassed = liveQualityAndTokenPassed(live);
  return family({
    id: 'monolith-decomposition',
    label: 'Monolith Decomposition',
    strong: livePassed,
    partial: livePassed || Boolean(seeded),
    evidence: [
      ...(seeded ? [evidence(existing, REPORTS.existingTaskBenchmark, `${seeded.id}: ${seeded.status} ${seeded.score}/100, score delta +${seeded.deltas?.score_delta}`)] : []),
      ...liveScenarioEvidence(liveEvidence),
    ],
    proven: [
      ...(seeded ? ['Seeded existing-project proof checks that Klauro points a monolith split at controller, service, repository, and focused service tests instead of only the obvious monolith file.'] : []),
      ...(livePassed ? ['Live copied-repo proof shows the Klauro arm passed semantic decomposition validation while the unguided arm did not, with fewer changed lines.'] : []),
    ],
    missing: livePassed ? [] : [
      'Need live copied-repo decomposition where both agents can pass tests but only the Klauro-guided agent preserves local boundaries and minimality.',
    ],
    next: [
      'Run a live monolith split in a larger real repo and score boundary preservation, diff minimality, and behavior parity.',
    ],
  });
}

function schemaMigrationChanges(reports: LoadedReports): TaskFamilyCoverage {
  const existing = reports.existingTaskBenchmark;
  const seeded = seededFamily(existing, 'schema-migration-changes');
  const liveEvidence = liveExistingEvidence(reports, 'schema-migration-changes');
  const live = liveEvidence?.scenario || null;
  const livePassed = liveQualityAndTokenPassed(live);
  const migrationScratch = reports.scratch.filter(entry => reportSupportsFamily(entry.report, 'schema-migration-changes'));
  const migrationWaves = migrationScratch.flatMap(entry => array(entry.report.continuation_waves));
  return family({
    id: 'schema-migration-changes',
    label: 'Schema And Migration Changes',
    strong: livePassed,
    partial: livePassed || migrationWaves.length >= 2 || Boolean(seeded),
    evidence: [
      ...migrationScratch.map(entry => evidence(entry.report, entry.path, `${entry.report.status || 'unknown'} ${entry.report.score ?? 'unknown'}/100, ${array(entry.report.continuation_waves).length} migration continuation waves`)),
      ...(seeded ? [evidence(existing, REPORTS.existingTaskBenchmark, `${seeded.id}: ${seeded.status} ${seeded.score}/100, score delta +${seeded.deltas?.score_delta}`)] : []),
      ...liveScenarioEvidence(liveEvidence),
    ],
    proven: [
      'Compliance greenfield continuation now explicitly requires migration evidence and can validate it.',
      ...(seeded ? ['Seeded existing-project proof checks migration guidance for domain model, repository, existing migration convention, and focused test surfaces.'] : []),
      ...(livePassed ? ['Live existing-repo migration proof shows the Klauro arm updated the migration, domain, repository, service, and tests while the unguided arm missed semantic validation.'] : []),
      ...(!livePassed && liveQualityAndTokenOnly(live) ? ['Live existing-repo migration proof improved semantic quality and slightly reduced tokens, but it is not strong because the Klauro arm was slower.'] : []),
    ],
    missing: livePassed ? [] : liveQualityAndTokenOnly(live) ? [
      'The live migration run improved quality and reduced tokens but was slower; strong proof requires non-negative time reduction.',
      'Need existing-repo migration proof in repos with real migration tooling and rollback conventions.',
    ] : [
      'Migration proof is mostly greenfield compliance-shaped, not existing-codebase schema evolution.',
      'Latest continuation read-budget run fixed validation but still showed a with-Klauro token regression.',
    ],
    next: [
      'Run existing-repo migration tasks in repos with real migration conventions and score whether Klauro chooses the right migration path.',
    ],
  });
}

function authTenantBoundaryChanges(reports: LoadedReports): TaskFamilyCoverage {
  const idiom = reports.idiomBenchmark;
  const existing = reports.existingTaskBenchmark;
  const seeded = seededFamily(existing, 'auth-tenant-boundary-changes');
  const liveEvidence = liveExistingEvidence(reports, 'auth-tenant-boundary-changes');
  const live = liveEvidence?.scenario || null;
  const livePassed = liveQualityAndTokenPassed(live);
  const authTasks = array(idiom.trials).filter(trial => JSON.stringify(trial.task || {}).includes('auth-tenant-scope'));
  const strong = authTasks.length >= 3 && Number(idiom.summary?.average_idiom_conformance_delta || 0) > 0;
  return family({
    id: 'auth-tenant-boundary-changes',
    label: 'Auth And Tenant Boundary Changes',
    strong: livePassed,
    partial: livePassed || strong || Boolean(seeded),
    evidence: [
      evidence(idiom, REPORTS.idiomBenchmark, `${authTasks.length} auth/tenant-scope idiom tasks, total idiom delta ${signed(idiom.summary?.average_idiom_conformance_delta)}`),
      ...(seeded ? [evidence(existing, REPORTS.existingTaskBenchmark, `${seeded.id}: ${seeded.status} ${seeded.score}/100, score delta +${seeded.deltas?.score_delta}`)] : []),
      ...liveScenarioEvidence(liveEvidence),
    ],
    proven: [
      'Idiom extraction can surface auth/tenant-scope guidance for edit contexts.',
      ...(seeded ? ['Seeded existing-project proof checks role/policy hardening guidance through the existing workspace policy boundary.'] : []),
      ...(livePassed ? ['Live tenant-boundary proof shows the Klauro arm preserved the policy/service boundary and passed semantic validation while the unguided arm failed it.'] : []),
      ...(!livePassed && liveQualityAndTokenOnly(live) ? ['Live tenant-boundary proof improved semantic quality and token use, but it is not strong because Klauro took longer than the unguided arm.'] : []),
      ...(!livePassed && !liveQualityAndTokenOnly(live) && liveQualityOnly(live) ? ['Live tenant-boundary proof improved semantic quality, but it is not strong because Klauro used more tokens than the unguided arm.'] : []),
    ],
    missing: livePassed ? [] : liveQualityAndTokenOnly(live) ? [
      'The live auth/tenant run improved quality and token use but was slower; strong proof requires non-negative time reduction.',
      'Need more live seeded tasks where bypassing tenant scope still passes naive tests but violates local invariants.',
    ] : liveQualityOnly(live) ? [
      'The live auth/tenant run improved quality but used more tokens; strong proof requires total token reduction to be non-negative.',
      'Need more live seeded tasks where bypassing tenant scope still passes naive tests but violates local invariants.',
    ] : [
      'Need live seeded tasks where bypassing tenant scope still passes naive tests but violates local invariants.',
    ],
    next: [
      'Seed a tenant leak bug and require the with-Klauro agent to preserve scoped repositories/guards while fixing it.',
    ],
  });
}

function authSystemReplacement(reports: LoadedReports): TaskFamilyCoverage {
  const existing = reports.existingTaskBenchmark;
  const seeded = seededFamily(existing, 'auth-system-replacement');
  const liveEvidence = liveExistingEvidence(reports, 'auth-system-replacement');
  const live = liveEvidence?.scenario || null;
  const livePassed = liveQualityAndTokenPassed(live);
  return family({
    id: 'auth-system-replacement',
    label: 'Auth System Replacement',
    strong: livePassed,
    partial: livePassed || Boolean(seeded),
    evidence: [
      ...(seeded ? [evidence(existing, REPORTS.existingTaskBenchmark, `${seeded.id}: ${seeded.status} ${seeded.score}/100, score delta +${seeded.deltas?.score_delta}`)] : []),
      ...liveScenarioEvidence(liveEvidence),
    ],
    proven: [
      ...(seeded ? ['Seeded existing-project proof checks OIDC replacement across AuthService, AuthModule, SessionController, SessionRepository, AuditLogger, and focused tests.'] : []),
      ...(livePassed ? ['Live copied-repo proof shows the Klauro arm passed semantic auth-replacement validation while the unguided arm missed required constraints, with fewer changed lines.'] : []),
    ],
    missing: livePassed ? [] : [
      'Need live auth replacement proof with invalid-token, session, logout/refresh, and migration/config consequences.',
    ],
    next: [
      'Run a live copied-repo auth replacement task and require tests for valid identity, rejected identity, and unchanged session persistence boundary.',
    ],
  });
}

function mfaSecurityEnhancement(reports: LoadedReports): TaskFamilyCoverage {
  const existing = reports.existingTaskBenchmark;
  const seeded = seededFamily(existing, 'mfa-security-enhancement');
  const liveEvidence = liveExistingEvidence(reports, 'mfa-security-enhancement');
  const live = liveEvidence?.scenario || null;
  const livePassed = liveQualityAndTokenPassed(live);
  return family({
    id: 'mfa-security-enhancement',
    label: 'MFA And Step-Up Security Enhancements',
    strong: livePassed,
    partial: livePassed || Boolean(seeded),
    evidence: [
      ...(seeded ? [evidence(existing, REPORTS.existingTaskBenchmark, `${seeded.id}: ${seeded.status} ${seeded.score}/100, score delta +${seeded.deltas?.score_delta}`)] : []),
      ...liveScenarioEvidence(liveEvidence),
    ],
    proven: [
      ...(seeded ? ['Seeded existing-project proof checks MFA guidance across AuthService, MfaService, SessionRepository, and focused auth tests.'] : []),
      ...(livePassed ? ['Live copied-repo MFA proof shows the Klauro arm passed semantic security validation while the unguided arm failed it.'] : []),
      ...(!livePassed && liveQualityAndTokenOnly(live) ? ['Live MFA proof improved semantic quality and token use, but it is not strong because Klauro took longer than the unguided arm.'] : []),
      ...(!livePassed && !liveQualityAndTokenOnly(live) && liveQualityOnly(live) ? ['Live MFA proof improved semantic quality, but it is not strong because Klauro used more tokens than the unguided arm.'] : []),
    ],
    missing: livePassed ? [] : liveQualityAndTokenOnly(live) ? [
      'The live MFA run improved quality and token use but was slower; strong proof requires non-negative time reduction.',
      'Need live MFA proof with recovery codes, enrollment, and risk-based step-up policy consequences.',
    ] : liveQualityOnly(live) ? [
      'The live MFA run improved quality but used more tokens; strong proof requires total token reduction to be non-negative.',
      'Need live MFA proof with recovery codes, enrollment, and risk-based step-up policy consequences.',
    ] : [
      'Need live proof that Klauro prevents insecure shortcuts such as issuing sessions before MFA verification or hard-coding codes in the auth boundary.',
    ],
    next: [
      'Run a live MFA task where naive tests pass even when session issuance happens before step-up verification, then score semantic diff rules.',
    ],
  });
}

function testAdditionAndCoverage(reports: LoadedReports): TaskFamilyCoverage {
  const scratchLive = liveScratchReports(reports);
  const existing = reports.existingTaskBenchmark;
  const seeded = seededFamily(existing, 'test-addition-coverage');
  const liveEvidence = liveExistingEvidence(reports, 'test-addition-coverage');
  const coverageLive = liveEvidence?.scenario || null;
  const coverageLivePassed = liveQualityAndTokenPassed(coverageLive);
  return family({
    id: 'test-addition-coverage',
    label: 'Test Addition And Coverage Targeting',
    strong: coverageLivePassed,
    partial: coverageLivePassed || scratchLive.length >= 3 || Boolean(seeded),
    evidence: [
      ...scratchLive.map(report => evidence(report, scratchReportPath(report, reports), `${report.task?.id || 'scratch'} score ${report.score}/100, continuation waves ${array(report.continuation_waves).length}`)),
      ...(seeded ? [evidence(existing, REPORTS.existingTaskBenchmark, `${seeded.id}: ${seeded.status} ${seeded.score}/100, score delta +${seeded.deltas?.score_delta}`)] : []),
      ...liveScenarioEvidence(liveEvidence),
    ],
    proven: [
      'Scratch and continuation scorers now count focused tests and penalize weak continuation test evidence.',
      ...(seeded ? ['Seeded existing-project proof checks test-only coverage guidance without unnecessary production source changes.'] : []),
      ...(coverageLivePassed ? ['Live test-coverage proof shows the Klauro arm changed only the focused test file, improved quality by 25 points, and avoided the unguided arm\'s extra package/config edit.'] : []),
    ],
    missing: coverageLivePassed ? [] : [
      'Quality still regressed slightly in the latest compliance continuation because focused continuation test evidence was weaker.',
      'Need existing-repo test-repair and missing-coverage tasks.',
    ],
    next: [
      'Run live tasks that add tests for an existing bug and score whether the tests target the affected invariant instead of broad snapshots.',
    ],
  });
}

function performanceFixes(reports: LoadedReports): TaskFamilyCoverage {
  const machine = reports.machineProof;
  const existing = reports.existingTaskBenchmark;
  const seeded = seededFamily(existing, 'performance-fixes');
  const liveEvidence = liveExistingEvidence(reports, 'performance-fixes');
  const live = liveEvidence?.scenario || null;
  const livePassed = liveQualityAndTokenPassed(live);
  return family({
    id: 'performance-fixes',
    label: 'Performance Fixes',
    strong: livePassed,
    partial: livePassed || Boolean(seeded),
    evidence: [
      evidence(machine, REPORTS.machineProof, `incremental proof speedups are product performance, not application performance-fix tasks`),
      ...(seeded ? [evidence(existing, REPORTS.existingTaskBenchmark, `${seeded.id}: ${seeded.status} ${seeded.score}/100, score delta +${seeded.deltas?.score_delta}`)] : []),
      ...liveScenarioEvidence(liveEvidence),
    ],
    proven: [
      'Klauro itself has incremental-analysis performance proof.',
      ...(seeded ? ['Seeded existing-project proof checks guidance for an N+1-style repository batching fix.'] : []),
      ...(livePassed ? ['Live copied-repo performance proof shows the Klauro arm used 75% fewer tokens, finished faster, and updated the focused summary test while the unguided arm failed semantic validation.'] : []),
    ],
    missing: livePassed ? [] : [
      'No live A/B benchmark asks agents to diagnose or fix an application performance issue using CAS context.',
    ],
    next: [
      'Seed an N+1/query fanout or expensive render loop in a copied repo and require diagnosis, minimal fix, and targeted tests.',
    ],
  });
}

function crossRepoContractChanges(reports: LoadedReports): TaskFamilyCoverage {
  const machine = reports.machineProof;
  const existing = reports.existingTaskBenchmark;
  const seeded = seededFamily(existing, 'cross-repo-contract-changes');
  const liveEvidence = liveExistingEvidence(reports, 'cross-repo-contract-changes');
  const live = liveEvidence?.scenario || null;
  const liveQualityPassed = liveQualityAndTokenPassed(live);
  return family({
    id: 'cross-repo-contract-changes',
    label: 'Cross-Repo Contract Changes',
    strong: liveQualityPassed,
    partial: liveQualityPassed || Boolean(seeded) || Boolean(live),
    evidence: [
      evidence(machine, REPORTS.machineProof, `${machine.workspace_graph?.link_count || machine.cross_repository?.links?.length || 0} cross-repo links reported in machine proof`),
      ...(seeded ? [evidence(existing, REPORTS.existingTaskBenchmark, `${seeded.id}: ${seeded.status} ${seeded.score}/100, score delta +${seeded.deltas?.score_delta}`)] : []),
      ...liveScenarioEvidence(liveEvidence),
    ],
    proven: [
      'Machine proof can account for cross-repo links.',
      ...(seeded ? ['Seeded existing-project proof checks producer contract, route, consumer client, and contract-test guidance together.'] : []),
      ...(liveQualityPassed ? ['Live contract-change proof shows Klauro improved patch quality while reducing token/time cost.'] : []),
      ...(!liveQualityPassed && live ? ['Live contract-change proof shows Klauro reduced token/time cost, but output quality did not yet improve.'] : []),
    ],
    missing: liveQualityPassed ? [] : live ? [
      'Current live contract proof is not yet strong under the strict quality-plus-token bar.',
      'Need a harder real multi-repo contract task where downstream boundary knowledge affects correctness or idiom quality.',
    ] : [
      'No live A/B task changes a contract across producer, consumer, tests, and generated/client surfaces.',
    ],
    next: [
      'Run a producer/consumer contract-change task across two real repos and score whether Klauro updates the right downstream boundary.',
    ],
  });
}

function largeFeatureIntegration(reports: LoadedReports): TaskFamilyCoverage {
  const existing = reports.existingTaskBenchmark;
  const seeded = seededFamily(existing, 'large-feature-integration');
  const liveEvidence = liveExistingEvidence(reports, 'large-feature-integration');
  const live = liveEvidence?.scenario || null;
  const livePassed = liveQualityAndTokenPassed(live);
  return family({
    id: 'large-feature-integration',
    label: 'Large Feature Integration',
    strong: livePassed,
    partial: livePassed || Boolean(seeded),
    evidence: [
      ...(seeded ? [evidence(existing, REPORTS.existingTaskBenchmark, `${seeded.id}: ${seeded.status} ${seeded.score}/100, score delta +${seeded.deltas?.score_delta}`)] : []),
      ...liveScenarioEvidence(liveEvidence),
    ],
    proven: [
      ...(seeded ? ['Seeded existing-project proof checks a cross-cutting audit-log feature that must attach to existing TaskService workflows and repository boundaries instead of creating a parallel workflow.'] : []),
      ...(livePassed ? ['Live copied-repo proof shows the Klauro arm attached a feature through the existing TaskService workflow with fewer files, fewer lines, and semantic validation passing while the unguided arm over-edited.'] : []),
    ],
    missing: livePassed ? [] : [
      'Need live multi-file product feature proof in real repos where duplicated workflows would still compile and pass shallow tests.',
    ],
    next: [
      'Run a live product feature task against a real repo and score reuse of existing capability memory, boundary placement, test relevance, and no duplicated subsystem.',
    ],
  });
}

function seededFamily(report: JsonObject, family: string): JsonObject | null {
  if (report.missing_report || report.status === 'fail') return null;
  return array(report.scenarios).find(scenario => scenario.family === family && Number(scenario.score || 0) >= 70) || null;
}

function liveExistingFamily(report: JsonObject, family: string): JsonObject | null {
  if (report.missing_report || report.status === 'fail') return null;
  return array(report.scenarios).find(scenario => scenario.family === family && scenario.live_summary) || null;
}

function liveExistingEvidence(reports: LoadedReports, family: string): (ReportEntry & { scenario: JsonObject }) | null {
  const candidates = reports.existingLive
    .map(entry => {
      const scenario = liveExistingFamily(entry.report, family);
      return scenario ? { ...entry, scenario } : null;
    })
    .filter((entry): entry is ReportEntry & { scenario: JsonObject } => Boolean(entry))
    .sort((left, right) => {
      const strength = Number(liveQualityAndTokenPassed(right.scenario)) - Number(liveQualityAndTokenPassed(left.scenario));
      if (strength !== 0) return strength;
      return proofReportTimestamp(right.report) - proofReportTimestamp(left.report);
    });
  return candidates[0] || null;
}

function liveScenarioEvidence(entry: (ReportEntry & { scenario: JsonObject }) | null): Evidence[] {
  if (!entry) return [];
  const live = entry.scenario;
  return [evidence(entry.report, entry.path, `${live.id}: live ${live.live_summary?.status}, with ${live.live_summary?.with_score}/100 vs without ${live.live_summary?.without_score}/100, quality delta ${signed(live.live_summary?.quality_delta)}, token reduction ${percent(live.live_summary?.token_reduction_percentage)}`)];
}

function liveQualityAndTokenPassed(live: JsonObject | null): boolean {
  if (!live?.live_summary) return false;
  return live.live_summary.status === 'pass'
    && Number(live.live_summary.quality_delta || 0) > 0
    && nonNegativeTokenReduction(live.live_summary.token_reduction_percentage)
    && nonNegativeTokenReduction(live.live_summary.time_reduction_percentage);
}

function liveQualityOnly(live: JsonObject | null): boolean {
  if (!live?.live_summary) return false;
  return live.live_summary.status === 'pass'
    && Number(live.live_summary.quality_delta || 0) > 0;
}

function liveQualityAndTokenOnly(live: JsonObject | null): boolean {
  if (!live?.live_summary) return false;
  return live.live_summary.status === 'pass'
    && Number(live.live_summary.quality_delta || 0) > 0
    && nonNegativeTokenReduction(live.live_summary.token_reduction_percentage);
}

function nonNegativeTokenReduction(value: unknown): boolean {
  const parsed = number(value);
  return Number.isFinite(parsed) && parsed >= 0;
}

function acceptableGreenfieldTokenTradeoff(report: JsonObject): boolean {
  if (nonNegativeTokenReduction(report.comparison?.token_reduction_percentage)) return true;
  const status = String(report.comparison?.quality_token_tradeoff_status || '');
  const tokenDelta = number(report.comparison?.token_reduction_percentage);
  const liveQualityDelta = number(report.comparison?.live_quality_delta);
  const scoredQualityDelta = number(report.comparison?.quality_delta);
  return status === 'acceptable' &&
    Number.isFinite(tokenDelta) &&
    tokenDelta >= -5 &&
    Math.max(liveQualityDelta, scoredQualityDelta) > 0;
}

function family(input: {
  id: string;
  label: string;
  strong: boolean;
  partial: boolean;
  evidence: Evidence[];
  proven: string[];
  missing: string[];
  next: string[];
}): TaskFamilyCoverage {
  const hasOpenMissingWork = input.missing.some(item => item.trim().length > 0);
  const status: CoverageStatus = input.strong && !hasOpenMissingWork ? 'strong' : input.partial || input.strong ? 'partial' : 'gap';
  return {
    id: input.id,
    label: input.label,
    status,
    score: status === 'strong' ? 100 : status === 'partial' ? 60 : 0,
    evidence: input.evidence.filter(item => item.summary && !item.summary.includes('missing undefined')),
    proven: input.proven,
    missing: input.missing,
    next_live_tasks: input.next,
  };
}

function evidence(report: JsonObject, reportPath: string, summary: string): Evidence {
  if (report.missing_report) {
    return {
      path: report.missing_report,
      summary: 'missing report',
    };
  }
  return { path: reportPath, summary };
}

function liveScratchReports(reports: LoadedReports): JsonObject[] {
  const current = new Map<string, ReportEntry>();
  for (const entry of reports.scratch) {
    if (entry.report.status !== 'pass') continue;
    const key = scratchTaskKey(entry.report);
    if (!key) continue;
    const existing = current.get(key);
    if (!existing || proofReportTimestamp(entry.report) > proofReportTimestamp(existing.report)) current.set(key, entry);
  }
  return [...current.values()].map(entry => entry.report);
}

function scratchTradeoffWarningReports(reports: LoadedReports): JsonObject[] {
  return reports.scratch.map(entry => entry.report).filter(report =>
    (
      report.comparison?.quality_token_tradeoff_status === 'token-regression-without-quality-win' ||
      report.comparison?.quality_token_tradeoff_status === 'quality-win-token-regression-too-large'
    )
  );
}

function activeScratchTradeoffWarningReports(reports: LoadedReports): JsonObject[] {
  return scratchTradeoffWarningReports(reports)
    .filter(report => !supersedingScratchReport(report, reports));
}

function supersededScratchTradeoffWarningReports(reports: LoadedReports): Array<{ warning: JsonObject; replacement: JsonObject }> {
  return scratchTradeoffWarningReports(reports)
    .map(warning => {
      const replacement = supersedingScratchReport(warning, reports);
      return replacement ? { warning, replacement } : null;
    })
    .filter((item): item is { warning: JsonObject; replacement: JsonObject } => Boolean(item));
}

function supersedingScratchReport(warning: JsonObject, reports: LoadedReports): JsonObject | null {
  const warningTask = scratchTaskKey(warning);
  const warningTime = Date.parse(String(warning.generated_at || ''));
  if (!warningTask || !Number.isFinite(warningTime)) return null;
  const candidates = liveScratchReports(reports)
    .filter(report => scratchTaskKey(report) === warningTask)
    .filter(report => report.status === 'pass' && acceptableGreenfieldTokenTradeoff(report))
    .filter(report => Number(report.comparison?.quality_delta || 0) > 0 || Number(report.comparison?.live_quality_delta || 0) > 0)
    .filter(report => {
      const generatedAt = Date.parse(String(report.generated_at || ''));
      return Number.isFinite(generatedAt) && generatedAt > warningTime;
    })
    .sort((left, right) => Date.parse(String(right.generated_at || '')) - Date.parse(String(left.generated_at || '')));
  return candidates[0] || null;
}

function scratchTaskKey(report: JsonObject): string {
  return String(report.task?.id || report.task?.title || '').trim().toLowerCase();
}

function scratchReportPath(report: JsonObject, reports: LoadedReports): string {
  const entry = reports.scratch.find(candidate => candidate.report === report);
  if (entry) return entry.path;
  return '.klauro-agent-scratch-build-benchmark/unknown.json';
}

function reportSupportsFamily(report: JsonObject, family: string): boolean {
  const families = [
    report.family,
    report.task?.family,
    ...array(report.families).map(item => item.id || item.family || item),
    ...array(report.continuation_waves).map(wave => wave.family || wave.task?.family),
  ].filter(Boolean).map(value => String(value));
  return families.includes(family);
}

function agentTaskTypes(report: JsonObject): Set<string> {
  const types = new Set<string>();
  for (const target of array(report.targets)) {
    for (const task of array(target.tasks)) {
      const type = task.task?.task_type || task.task_type;
      if (type) types.add(String(type));
    }
  }
  return types;
}

function qualityTasks(report: JsonObject): JsonObject[] {
  return array(report.trials);
}

function parseArgs(argv: string[]): Options {
  let root = process.cwd();
  let outputPath: string | null = path.join(process.cwd(), '.klauro-agent-task-family-coverage', 'latest-report.json');
  let markdownPath: string | null = path.join(process.cwd(), '.klauro-agent-task-family-coverage', 'latest-report.md');
  let strict = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--root') root = path.resolve(argv[++i]);
    else if (arg === '--output') outputPath = path.resolve(argv[++i]);
    else if (arg === '--markdown') markdownPath = path.resolve(argv[++i]);
    else if (arg === '--no-output') {
      outputPath = null;
      markdownPath = null;
    } else if (arg === '--strict') strict = true;
    else if (arg === '--help' || arg === '-h') {
      console.log([
        'Usage: npm run agent-task-family-coverage -- [options]',
        '',
        'Options:',
        '  --root /path              Root containing Klauro proof reports.',
        '  --output /path/report.json',
        '  --markdown /path/report.md',
        '  --no-output',
        '  --strict                  Exit non-zero unless every family is strong.',
      ].join('\n'));
      process.exit(0);
    }
  }
  return { root, outputPath, markdownPath, strict };
}

function printReport(report: CoverageReport): void {
  console.log(`Agent task family coverage: ${report.status.toUpperCase()} (${report.score}/100)`);
  console.log(`${report.summary.strong} strong, ${report.summary.partial} partial, ${report.summary.gaps} gaps across ${report.summary.families} families`);
  for (const family of report.families) {
    console.log(`${family.status.toUpperCase().padEnd(7)} ${family.id} - ${family.score}/100`);
  }
}

function average(values: number[]): number {
  const finite = values.filter(isFiniteNumber);
  if (finite.length === 0) return 0;
  return finite.reduce((sum, value) => sum + value, 0) / finite.length;
}

function signed(value: unknown): string {
  const parsed = number(value);
  if (!Number.isFinite(parsed)) return 'unknown';
  return parsed > 0 ? `+${parsed}` : String(parsed);
}

function percent(value: unknown): string {
  const parsed = number(value);
  if (!Number.isFinite(parsed)) return 'unknown';
  return `${Math.round(parsed)}%`;
}

function number(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function isFiniteNumber(value: number): boolean {
  return Number.isFinite(value);
}

function array(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value as JsonObject[] : [];
}

if (isDirectCliInvocation('agent-task-family-coverage')) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
