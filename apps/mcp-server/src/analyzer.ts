export { getAnalysis } from './analysis-access';
import { partitionAnalysisDiagnostics } from '../../../packages/analyzer-core/src/analyzer/core/analysis-diagnostics';
import type { CASOutput, ChangeReport } from '../../../packages/analyzer-core/src/types/cas.types';
import { buildCompletedAnalysisLayersReady } from './layered-analysis';
import { saveAnalysisWithSourceCoverage as saveAnalysis } from './source-coverage';
import { beginForegroundAnalysis } from './foreground-analysis';
import { registerHostedBackgroundPreflight, withHostedForegroundPermit } from './hosted-background-queue';
import * as fs from 'fs-extra';
import * as nodeFs from 'fs';
import * as path from 'path';
import { fork, type ChildProcess } from 'child_process';
import {
  getAnalysisRunLogPath,
  readRecentRunRecords,
  type AnalysisRunFinalRecord,
  type AnalysisRunRecord,
  type AnalysisRunStartRecord,
} from '../../../packages/analyzer-core/src/analyzer/core/run-log';
import { resolveAnalysisHeapMb, type AnalysisHeapResolution } from './analysis-heap';
import { readContainerMemory } from './analysis-memory';
import { recorded } from './analysis-run-record';
import {
  AnalysisLoopBreakerError,
  readRebuildAttempt,
  recordingRebuild,
  type RebuildAttempt,
} from './analysis-rebuild-attempt';
export { AnalysisLoopBreakerError } from './analysis-rebuild-attempt';
import { changesBetween } from './analysis-change-report';
import { analysisWorkerExecArgv, resolveAnalysisWorkerEntry } from './analysis-worker-channel';
export { analysisWorkerExecArgv } from './analysis-worker-channel';
import {
  executeHostedAnalysis,
  reserveHostedAnalysisOrThrow,
  type HostedAnalysisAdmissionMetadata,
  type HostedAnalysisTicket,
} from './hosted-analysis-admission';
import {
  getAnalysisVersionInfo,
  loadAnalysis,
  saveAnalysisSnapshot,
  getAnalysisEntry,
  withProjectAnalysisLock,
  withProjectAnalysisLockIfAvailable,
} from './storage';
import { clearFreshnessSummaryCache } from './freshness';
import { publishStructuralLayer } from './structural-layer';
import { recordAnalysisStage, timeAnalysisStage } from './analysis-phase-timings';
import { describeAnalysisVersion } from './analysis-version';
import { applyStoredElementDescriptions, validateDescription } from './description-enrichment';
import { isLanguageBuiltinName } from '../../../packages/analyzer-core/src/analyzer/core/language-builtins';
import { analyzeWithTierStack } from '../../../packages/analyzer-core/src/analyzer/tier-stack';




























function aiInterpretationWasUnavailable(output: CASOutput): boolean {
  const generation = output.enhanced_system_purpose?.description_generation;
  return generation?.status === 'ai_skipped' && generation.attempted === false;
}









export function preservePreviousAIDescriptions(
  previousOutput: CASOutput | null | undefined,
  output: CASOutput
): CASOutput {
  const previousPurpose = previousOutput?.enhanced_system_purpose;
  const purpose = output.enhanced_system_purpose;
  if (!previousPurpose || !purpose) return output;
  if (!aiInterpretationWasUnavailable(output)) return output;

  const previousCapabilities = new Map(
    (previousOutput?.capabilities || []).map(capability => [capability.id, capability])
  );
  for (const capability of output.capabilities || []) {
    const previous = previousCapabilities.get(capability.id);
    if (previous?.description &&
      capabilityReuseSubjectsMatch(previous, capability) &&
      validateDescription(previous.description, { kind: 'capability', name: capability.name, target: capability }, output).ok &&
      (previous.description_source === 'ai' || previous.description_source === 'manual' || previous.description_source === 'reused')) {
      capability.description = previous.description;
      capability.description_source = 'reused';
      capability.description_generation = {
        status: 'reused_previous',
        attempted: false,
        reason: previous.description_generation?.status,
        generated_at: new Date().toISOString(),
        may_be_stale: true,
      };
    }
  }

  if (!previousPurpose.inferred_description ||
    !(previousPurpose.description_source === 'ai' || previousPurpose.description_source === 'reused')) {
    return output;
  }
  if (hasLowLevelExternalServicePollution(previousPurpose.inferred_description) ||
    hasStaleNarrativePattern(previousPurpose.inferred_description, previousPurpose, output)) {
    return output;
  }
  purpose.inferred_description = previousPurpose.inferred_description;
  purpose.description_source = 'reused';
  purpose.description_generation = {
    status: 'reused_previous',
    attempted: false,
    reason: 'ai-unavailable-on-full-rebuild',
    generated_at: new Date().toISOString(),
    may_be_stale: true,
  };
  if (previousPurpose.primary_domain &&
    (previousPurpose.domain_source === 'ai' || previousPurpose.domain_source === 'reused')) {
    purpose.primary_domain = previousPurpose.primary_domain;
    purpose.domain_source = 'reused';
  }
  return output;
}

function capabilityReuseSubjectsMatch(previous: any, current: any): boolean {
  const previousName = normalizeCapabilityReuseSubject(previous?.name);
  const currentName = normalizeCapabilityReuseSubject(current?.name);
  if (!previousName || !currentName || previousName !== currentName) return false;
  const previousDomains = new Set((previous?.related_domains || []).map((domain: unknown) => normalizeCapabilityReuseSubject(domain)).filter(Boolean));
  const currentDomains = (current?.related_domains || []).map((domain: unknown) => normalizeCapabilityReuseSubject(domain)).filter(Boolean);
  if (previousDomains.size === 0 || currentDomains.length === 0) return true;
  return currentDomains.some((domain: string) => previousDomains.has(domain));
}

function normalizeCapabilityReuseSubject(value: unknown): string {
  return String(value || '')
    .toLowerCase()
    .replace(/\b(management|capability|workflow|reporting|analysis|generation|settlement|rebalancing|authentication|commands|handlers|tasks)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function hasLowLevelExternalServicePollution(description: string): boolean {
  if (/\b(?:connects to|connected to|calls out to)\b[^.]*\b(?:Self|gtk|objc_sys|[A-Z][A-Za-z0-9]*(?:Data|Decl|Item|Pool|Size))\b/.test(description)) {
    return true;
  }
  if (/\bexternal services? like\b/i.test(description)) {
    const candidates = description
      .split(/[,\s.()]+/)
      .map(token => token.trim())
      .filter(Boolean);
    if (candidates.some(candidate => isLanguageBuiltinName(candidate))) return true;
  }
  return false;
}

const PURPOSE_EVIDENCE_STOP_WORDS = new Set([
  'application', 'applications', 'capability', 'capabilities', 'management', 'manager', 'platform',
  'service', 'services', 'software', 'system', 'systems', 'tool', 'tools', 'workflow', 'workflows',
]);

function purposeEvidenceTokens(values: unknown[]): Set<string> {
  const tokens = new Set<string>();
  for (const value of values) {
    for (const token of String(value || '').toLowerCase().split(/[^a-z0-9]+/)) {
      if (token.length > 2 && !PURPOSE_EVIDENCE_STOP_WORDS.has(token)) tokens.add(token);
    }
  }
  return tokens;
}

function hasPurposeEvidenceDrift(previousPurpose: CASOutput['enhanced_system_purpose'], output: CASOutput): boolean {
  const currentPurpose = output.enhanced_system_purpose;
  if (!previousPurpose || !currentPurpose) return false;
  const previousTokens = purposeEvidenceTokens([
    previousPurpose.primary_domain,
    ...(previousPurpose.core_concepts || []),
  ]);
  const currentTokens = purposeEvidenceTokens([
    currentPurpose.primary_domain,
    ...(currentPurpose.core_concepts || []),
    ...(output.capabilities || []).flatMap(capability => [capability.name, ...(capability.related_domains || [])]),
  ]);
  if (previousTokens.size === 0 || currentTokens.size < 2) return false;
  return ![...currentTokens].some(token => previousTokens.has(token));
}

function hasStaleNarrativePattern(
  description: string,
  previousPurpose: CASOutput['enhanced_system_purpose'],
  output: CASOutput,
): boolean {
  if (/\b(?:manages|coordinates?)\s+[^.]{3,140}\s+workflows\b/i.test(description)) return true;
  if (/\bworkflows?\s+to\s+produce\s+and\s+manage\b/i.test(description)) return true;
  if (/\bmain (?:grounded |product )?concepts are\b/i.test(description)) return true;
  if (/\bservice records?\b/i.test(description)) return true;
  return hasPurposeEvidenceDrift(previousPurpose, output);
}

export async function analyzeProject(projectPath: string, displayName?: string, options: { reuseStoredContext?: boolean; persist?: boolean } = {}): Promise<CASOutput> {
  if (!(await fs.pathExists(projectPath))) {
    throw new Error(`Project path does not exist: ${projectPath}`);
  }

  const sizeHint = await estimateProjectSizeHint(projectPath);
  return withProjectAnalysisLock(projectPath, () => withAnalysisLane(async () => {
    const analyzed = await recorded(projectPath, () => analyzeWithTierStack(projectPath, displayName));
    const result = options.reuseStoredContext === false
      ? analyzed
      : await applyStoredElementDescriptions(projectPath, preservePreviousAIDescriptions(
        await loadAnalysis(projectPath, { preferCache: true }).catch(() => null), analyzed
      ));
    result.layers_ready = buildCompletedAnalysisLayersReady(result);
    if (options.persist !== false) await timeAnalysisStage(result, 'save', async () => {
      await saveAnalysis(projectPath, result);
      clearFreshnessSummaryCache();
      await saveAnalysisSnapshot(projectPath, result);
    });

    return result;
  }, sizeHint, projectPath));
}
















export interface LayeredAnalysisResult {
  l0: Promise<CASOutput>;
  rest: Promise<CASOutput>;
}













export async function analyzeProjectLayered(
  projectPath: string,
  displayName?: string,



















  forceFullRebuild?: boolean,
): Promise<LayeredAnalysisResult> {
  if (!(await fs.pathExists(projectPath))) {
    throw new Error(`Project path does not exist: ${projectPath}`);
  }

  const { computeL0Index, buildL0OnlyCas } = await import('./layered-analysis.js');

  const l0Promise = (async () => {
    const l0Index = await computeL0Index(projectPath);
    const l0Cas = buildL0OnlyCas(projectPath, displayName, l0Index);
    const lockAttempt = await withProjectAnalysisLockIfAvailable(projectPath, async () => {
      const existing = forceFullRebuild
        ? null
        : await loadAnalysis(projectPath, { preferCache: true }).catch(() => null);
      if (existing && existing.layers_ready?.complete === true && (existing.nodes?.length ?? 0) > 0) {
        return;
      }
      await saveAnalysis(projectPath, l0Cas);
      clearFreshnessSummaryCache();
    }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[Klauro] L0 index save failed for ${projectPath} (${message}); continuing to full analysis`);
      return { acquired: false as const };
    });
    if (!lockAttempt.acquired) {
      console.error(`[Klauro] L0 index save skipped for ${projectPath}: analysis.lock is already held by an in-progress analysis; the full analysis will supersede the L0 index anyway`);
    }
    return l0Cas;
  })();

  const restPromise = l0Promise.then(async () => {
    const previous = forceFullRebuild
      ? null
      : await loadAnalysis(projectPath, { preferCache: true }).catch(() => null);
    const hasCompletePrevious = !forceFullRebuild && Boolean(
      previous && previous.layers_ready?.complete === true && (previous.nodes?.length ?? 0) > 0
    );
    const structuralMs = await publishStructuralLayer(projectPath, displayName);
    const analyzed = hasCompletePrevious
      ? await analyzeProjectIncremental(projectPath, displayName)
          .then(incremental => incremental.output)
          .catch(async (error: unknown) => {
            if (error instanceof AnalysisLoopBreakerError) throw error;
            const message = error instanceof Error ? error.message : String(error);
            console.error(`[Klauro] warm incremental pass failed for ${projectPath} (${message}); falling back to a full analysis`);
            return analyzeProject(projectPath, displayName);
          })
      : await analyzeProject(projectPath, displayName, { reuseStoredContext: !forceFullRebuild });

    recordAnalysisStage(analyzed, 'structural', structuralMs);
    analyzed.layers_ready = buildCompletedAnalysisLayersReady(analyzed);
    await saveAnalysis(projectPath, analyzed, 'main', { deferSegmentedWrite: true });
    clearFreshnessSummaryCache();
    return analyzed;
  });

  return { l0: l0Promise, rest: restPromise };
}
















export interface IncrementalAnalysisResult {
  output: CASOutput;
  changeReport: ChangeReport;
  wasFullRebuild: boolean;
  fullRebuildReason?: string;
  previousCasVersion?: string;
}





































const DEFAULT_ANALYSIS_LANES = 2;
const PER_LANE_RAM_FACTOR = 1.4;
const HOST_RESERVE_MB = 1536;

function deriveAnalysisLaneCountFromHost(): number {
  const heap = resolveAnalysisHeapMb();
  const perLaneMb = Math.max(1, Math.round(heap.heapMb * PER_LANE_RAM_FACTOR));
  const usableMb = heap.totalRamMb - HOST_RESERVE_MB;
  if (usableMb <= 0) return 1;
  const byRam = Math.floor(usableMb / perLaneMb);




  return Math.max(1, Math.min(DEFAULT_ANALYSIS_LANES, byRam));
}

function getAnalysisLaneCount(): number {
  const raw = process.env.KLAURO_ANALYSIS_CONCURRENCY ?? process.env.KLAURO_ANALYSIS_LANES;
  if (raw === undefined || raw === '') return deriveAnalysisLaneCountFromHost();
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : deriveAnalysisLaneCountFromHost();
}












const DEFAULT_MEMORY_RSS_LIMIT_BYTES = 5 * 1024 * 1024 * 1024;
const DEFAULT_MEMORY_CONTAINER_RATIO = 0.7;

function getMemoryRssLimitBytes(): number {
  const raw = process.env.KLAURO_ANALYSIS_MEMORY_RSS_LIMIT_BYTES;
  const parsed = raw !== undefined && raw !== '' ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MEMORY_RSS_LIMIT_BYTES;
}

function getMemoryContainerRatio(): number {
  const raw = process.env.KLAURO_ANALYSIS_MEMORY_CONTAINER_RATIO;
  const parsed = raw !== undefined && raw !== '' ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 1 ? parsed : DEFAULT_MEMORY_CONTAINER_RATIO;
}







let memoryGuardOverrideForTests: (() => boolean) | null = null;

function isMemoryTight(): boolean {
  if (memoryGuardOverrideForTests) return memoryGuardOverrideForTests();
  const container = readContainerMemory();
  if (container) return container.usage === null || container.usage / container.limit > getMemoryContainerRatio();
  return process.memoryUsage().rss > getMemoryRssLimitBytes();
}



export function __setMemoryGuardOverrideForTests(override: boolean | null): void {
  memoryGuardOverrideForTests = override === null ? null : () => override;
}












const DEFAULT_QUEUE_MAX_WAIT_MS = 15 * 60 * 1000;

function getQueueMaxWaitMs(): number {
  const raw = process.env.KLAURO_ANALYSIS_QUEUE_MAX_WAIT_MS;
  const parsed = raw !== undefined && raw !== '' ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_QUEUE_MAX_WAIT_MS;
}

interface LaneWaiter {
  resolve: () => void;



  sizeHint: number;
  enqueuedAt: number;
}







function createLanePool(getCapacity: () => number) {
  let permitsInUse = 0;
  let waiters: LaneWaiter[] = [];





  function pickNextWaiterIndex(): number {
    if (waiters.length === 0) return -1;
    const now = Date.now();
    const maxWaitMs = getQueueMaxWaitMs();

    let promotedIdx = -1;
    let promotedEnqueuedAt = Infinity;
    for (let i = 0; i < waiters.length; i++) {
      const waiter = waiters[i];
      if (now - waiter.enqueuedAt >= maxWaitMs && waiter.enqueuedAt < promotedEnqueuedAt) {
        promotedIdx = i;
        promotedEnqueuedAt = waiter.enqueuedAt;
      }
    }
    if (promotedIdx !== -1) return promotedIdx;

    let bestIdx = 0;
    for (let i = 1; i < waiters.length; i++) {
      const candidate = waiters[i];
      const best = waiters[bestIdx];
      if (
        candidate.sizeHint < best.sizeHint ||
        (candidate.sizeHint === best.sizeHint && candidate.enqueuedAt < best.enqueuedAt)
      ) {
        bestIdx = i;
      }
    }
    return bestIdx;
  }

  function acquire(sizeHint: number): Promise<void> {
    const capacity = getCapacity();


    const effectiveCapacity = permitsInUse >= 1 && isMemoryTight() ? 1 : capacity;
    if (permitsInUse < effectiveCapacity) {
      permitsInUse += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      waiters.push({ resolve, sizeHint, enqueuedAt: Date.now() });
    });
  }

  function release(): void {
    const idx = pickNextWaiterIndex();
    if (idx !== -1) {


      const [waiter] = waiters.splice(idx, 1);
      waiter.resolve();
      return;
    }
    permitsInUse = Math.max(0, permitsInUse - 1);
  }

  function reset(): void {
    permitsInUse = 0;
    waiters = [];
  }

  function inUse(): number {
    return permitsInUse;
  }

  return { acquire, release, reset, inUse };
}


































const DEFAULT_INTERPRETATION_LANES = 4;

function getAiEnrichmentLaneCount(): number {
  const raw = process.env.KLAURO_INTERPRETATION_CONCURRENCY ?? process.env.KLAURO_INTERPRETATION_LANES;
  if (raw === undefined || raw === '') return DEFAULT_INTERPRETATION_LANES;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : DEFAULT_INTERPRETATION_LANES;
}

const deterministicLanePool = createLanePool(getAnalysisLaneCount);
const aiEnrichmentLanePool = createLanePool(getAiEnrichmentLaneCount);

function acquireLanePermit(sizeHint: number): Promise<void> {
  return deterministicLanePool.acquire(sizeHint);
}

function releaseLanePermit(): void {
  deterministicLanePool.release();
}

function acquireAiEnrichmentLanePermit(sizeHint: number): Promise<void> {
  return aiEnrichmentLanePool.acquire(sizeHint);
}

function releaseAiEnrichmentLanePermit(): void {
  aiEnrichmentLanePool.release();
}






async function estimateProjectSizeHint(projectPath: string): Promise<number> {
  try {
    const nodeCount = (await getAnalysisEntry(projectPath))?.node_count;
    if (typeof nodeCount === 'number' && Number.isFinite(nodeCount)) return nodeCount;
  } catch {   }
  return Number.POSITIVE_INFINITY;
}




const DEFAULT_ANALYSIS_WATCHDOG_MS = 30 * 60_000;

function getAnalysisWatchdogMs(): number {
  const raw = process.env.KLAURO_ANALYSIS_WATCHDOG_MS;
  const parsed = raw !== undefined && raw !== '' ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_ANALYSIS_WATCHDOG_MS;
}













function isDoomedRebuildReason(reason: string | undefined): boolean {
  if (!reason) return false;
  return /worker-oom|reached heap limit|javascript heap out of memory|fatal error|killed by signal|exhausting its heap/i.test(reason);
}

async function guardAgainstDoomedVersionRebuild(
  projectPath: string,
  versionInfo: { stored_version?: string; current_version: string },
): Promise<void> {
  if (!versionInfo.stored_version || versionInfo.stored_version === versionInfo.current_version) return;
  const previousAttempt = await readRebuildAttempt(projectPath);
  if (
    previousAttempt?.state === 'failed' &&
    previousAttempt.stored_version === versionInfo.stored_version &&
    previousAttempt.current_version === versionInfo.current_version &&
    isDoomedRebuildReason(previousAttempt.reason)
  ) {
    const message = [
      `loop-breaker: refusing to auto-retrigger the version-rebuild for ${projectPath}`,
      `(stored_version=${versionInfo.stored_version} -> current_version=${versionInfo.current_version}).`,
      `The previous attempt (finished ${previousAttempt.finished_at ?? previousAttempt.started_at}) already FAILED`,
      `with a worker-OOM reason: ${previousAttempt.reason}.`,
      `Auto-retriggering an identical rebuild would repeat the same crash indefinitely`,
      `(the 2026-07-18 infinite-crash-loop incident). Leaving the failed attempt record in place;`,
      `a human or agent must explicitly re-trigger (e.g. a force_full reanalyze) after addressing`,
      `the cause (raise KLAURO_ANALYSIS_HEAP_MB, or fix the hang).`,
    ].join(' ');
    console.error(`[Klauro] ${message}`);
    throw new AnalysisLoopBreakerError(message);
  }
}

export async function checkDoomedVersionRebuild(projectPath: string): Promise<string | null> {
  try {
    const entry = await getAnalysisEntry(projectPath).catch(() => null);
    if (!entry) return null;
    const versionInfo = describeAnalysisVersion(entry.cas_version);
    await guardAgainstDoomedVersionRebuild(projectPath, versionInfo);
    return null;
  } catch (error) {
    if (error instanceof AnalysisLoopBreakerError) return error.message;
    return null;
  }
}







function describeLastRunLogState(projectPath: string): string {
  try {
    const records = readRecentRunRecords();
    const finishedRunIds = new Set(
      records.filter((r): r is AnalysisRunFinalRecord => r.event === 'run-complete' || r.event === 'run-failed')
        .map(r => r.run_id)
    );
    const openStarts = records
      .filter((r): r is AnalysisRunStartRecord => r.event === 'run-start' && r.project_path === projectPath && !finishedRunIds.has(r.run_id));
    const latest = openStarts[openStarts.length - 1];
    if (!latest) return 'no open run-log entry found (run log records phases only at completion, so a hung run has nothing further to show)';
    return `run ${latest.run_id} started at ${latest.started_at}, never reached run-complete/run-failed (run log has no live in-progress phase, only phases-at-completion)`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `run log unreadable (${message})`;
  }
}








async function withPoolPermit<T>(
  acquire: (sizeHint: number) => Promise<void>,
  release: () => void,
  fn: () => Promise<T>,
  sizeHint: number,
  projectPath: string,
  watchdogLabel: string
): Promise<T> {
  await acquire(sizeHint);
  const startedAtMs = Date.now();
  const watchdogMs = getAnalysisWatchdogMs();
  const timer = setTimeout(() => {
    const elapsedMinutes = Math.round((Date.now() - startedAtMs) / 60_000);
    console.error(
      `[Klauro] SLOW ${watchdogLabel}: ${projectPath} has been running ${elapsedMinutes}m, exceeding ` +
      `KLAURO_ANALYSIS_WATCHDOG_MS=${watchdogMs}ms. Last known state: ${describeLastRunLogState(projectPath)}. ` +
      `The analysis remains in progress and retains its lock and lane; elapsed time never truncates or fails CAS work.`
    );
  }, watchdogMs);
  timer.unref();
  try {
    return await fn();
  } finally {
    clearTimeout(timer);
    release();
  }
}














function withLanePermit<T>(
  fn: () => Promise<T>,
  sizeHint: number = Number.POSITIVE_INFINITY,
  projectPath: string = 'analysis'
): Promise<T> {
  return withPoolPermit(acquireLanePermit, releaseLanePermit, fn, sizeHint, projectPath, 'ANALYSIS');
}







function withInterpretationLanePermit<T>(
  fn: () => Promise<T>,
  sizeHint: number = Number.POSITIVE_INFINITY,
  projectPath: string = 'analysis'
): Promise<T> {
  return withPoolPermit(acquireAiEnrichmentLanePermit, releaseAiEnrichmentLanePermit, fn, sizeHint, projectPath, 'interpretation');
}








function withAnalysisLane<T>(
  fn: () => Promise<T>,
  sizeHint?: number,
  describe?: string
): Promise<T> {
  return withLanePermit(fn, sizeHint, describe);
}




export function __resetAnalysisLanesForTests(): void {
  deterministicLanePool.reset();
  aiEnrichmentLanePool.reset();
  memoryGuardOverrideForTests = null;
}




export function __withLanePermitForTests<T>(fn: () => Promise<T>, sizeHint?: number, describe?: string): Promise<T> {
  return withLanePermit(fn, sizeHint, describe);
}




export function __withInterpretationLanePermitForTests<T>(fn: () => Promise<T>, sizeHint?: number, describe?: string): Promise<T> {
  return withInterpretationLanePermit(fn, sizeHint, describe);
}





export function __withOuterWorkerWatchdogForTests(
  projectPath: string,
  run: () => Promise<AnalysisRunSummary>
): Promise<AnalysisRunSummary> {
  return withOuterWorkerWatchdog(projectPath, run);
}




export async function __readInternalRebuildAttemptForTests(projectPath: string): Promise<RebuildAttempt | null> {
  return readRebuildAttempt(projectPath);
}



export function __getLanePermitsInUseForTests(): number {
  return deterministicLanePool.inUse();
}



export function __getAiEnrichmentLanePermitsInUseForTests(): number {
  return aiEnrichmentLanePool.inUse();
}

export async function analyzeProjectIncremental(
  projectPath: string,
  displayName?: string,
): Promise<IncrementalAnalysisResult> {
  const previous = await loadAnalysis(projectPath, { preferCache: true }).catch(() => null);
  const entry = await getAnalysisEntry(projectPath).catch(() => null);
  const version = entry ? describeAnalysisVersion(entry.cas_version) : null;
  const rebuilding = version !== null && version.stored_version !== version.current_version;
  if (version) await guardAgainstDoomedVersionRebuild(projectPath, version);
  const previousCasVersion = previous ? getAnalysisVersionInfo(previous).stored_version : undefined;
  const analyze = () => analyzeProject(projectPath, displayName);
  const output = rebuilding && version
    ? await recordingRebuild(projectPath, version, analyze)
    : await analyze();
  return {
    output,
    changeReport: changesBetween(previous, output),
    wasFullRebuild: true,
    previousCasVersion,
  };
}

export interface AnalysisChangeSummary {
  files_changed: number;
  nodes_added: number;
  nodes_modified: number;
  nodes_deleted: number;
  risk_level: string;
}

export interface AnalysisRunSummary {
  analysisType: 'full' | 'incremental';
  name: string;
  nodes: number;
  edges: number;
  entryPoints: number;
  analyzersRun: number;
  errors: number;
  warnings: number;
  information: number;
  phases: unknown[];
  casVersion?: string;
  previousCasVersion?: string;
  wasFullRebuild: boolean;
  fullRebuildReason?: string;
  changeSummary?: AnalysisChangeSummary;
  changeReport?: ChangeReport;
}
function summarizeOutput(projectPath: string, output: CASOutput): Omit<AnalysisRunSummary, 'analysisType' | 'wasFullRebuild'> {
  const diagnostics = partitionAnalysisDiagnostics(output.analysis_errors);
  return {
    name: output.system?.name || projectPath.split('/').pop() || projectPath,
    nodes: output.nodes?.length || 0,
    edges: output.edges?.length || 0,
    entryPoints: output.entry_points?.length || 0,
    analyzersRun: output.analyzer_contributions?.length || 0,
    errors: diagnostics.errors.length,
    warnings: diagnostics.warnings.length,
    information: diagnostics.information.length,
    phases: output.analysis_phases || [],
    casVersion: output.cas_version,
  };
}

export function summarizeFullAnalysis(projectPath: string, output: CASOutput): AnalysisRunSummary {
  return {
    ...summarizeOutput(projectPath, output),
    analysisType: 'full',
    wasFullRebuild: true,
  };
}

function trimChangeReportForTransfer(report: ChangeReport, wasFullRebuild: boolean): ChangeReport {
  if (!wasFullRebuild) return report;
  const emptiedDetails = Object.fromEntries(
    Object.entries(report.details || {}).map(([key, value]) => [key, Array.isArray(value) ? [] : value]),
  ) as unknown as ChangeReport['details'];
  return { ...report, details: emptiedDetails };
}

export function summarizeIncrementalAnalysis(projectPath: string, result: IncrementalAnalysisResult): AnalysisRunSummary {
  return {
    ...summarizeOutput(projectPath, result.output),
    analysisType: result.wasFullRebuild ? 'full' : 'incremental',
    wasFullRebuild: result.wasFullRebuild,
    fullRebuildReason: result.fullRebuildReason,
    previousCasVersion: result.previousCasVersion,
    changeReport: trimChangeReportForTransfer(result.changeReport, result.wasFullRebuild),
    changeSummary: result.wasFullRebuild ? undefined : {
      files_changed: result.changeReport.summary.filesAdded +
        result.changeReport.summary.filesModified +
        result.changeReport.summary.filesDeleted,
      nodes_added: result.changeReport.summary.nodesAdded,
      nodes_modified: result.changeReport.summary.nodesModified,
      nodes_deleted: result.changeReport.summary.nodesDeleted,
      risk_level: result.changeReport.impact.riskLevel,
    },
  };
}









export interface LayeredJobPhaseEvent {
  phase: 'l0' | 'rest';
  status: 'succeeded' | 'failed';
  error?: string;
}




export interface LayeredRunSummary {
  name: string;
  nodes: number;
  edges: number;
  entryPoints: number;
  analyzersRun: number;
  errors: number;
  casVersion?: string;
  failedLayers: Array<{ layer: string; error?: string }>;
  stageTimingsMs?: Record<string, number>;
}

export function summarizeLayeredAnalysis(projectPath: string, output: CASOutput): LayeredRunSummary {
  const base = summarizeOutput(projectPath, output);
  return {
    name: base.name,
    nodes: base.nodes,
    edges: base.edges,
    entryPoints: base.entryPoints,
    analyzersRun: base.analyzersRun,
    errors: base.errors,
    casVersion: base.casVersion,
    failedLayers: (output.layers_ready?.layers || [])
      .filter(layer => layer.status === 'error')
      .map(layer => ({ layer: layer.layer, ...(layer.error ? { error: layer.error } : {}) })),
    ...(output.timings?.stages ? { stageTimingsMs: output.timings.stages } : {}),
  };
}

export interface RunAnalysisOptions {
  forceFull?: boolean;







  displayName?: string;
}

export async function runAnalysisInProcess(projectPath: string, options: RunAnalysisOptions = {}): Promise<AnalysisRunSummary> {
  if (options.forceFull) {
    const output = await analyzeProject(projectPath, options.displayName);
    return summarizeFullAnalysis(projectPath, output);
  }
  const result = await analyzeProjectIncremental(projectPath, options.displayName);
  return summarizeIncrementalAnalysis(projectPath, result);
}

export function analysisRunsInProcess(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.KLAURO_ANALYSIS_IN_PROCESS === '1' || env.KLAURO_ANALYSIS_IN_PROCESS === 'true';
}

interface WorkerAnalyzeRequest {
  type: 'analyze';
  id: number;
  projectPath: string;
  forceFull: boolean;
  displayName?: string;
  env: Record<string, string>;
}









interface WorkerLayeredRequest {
  type: 'layered';
  id: number;
  projectPath: string;
  displayName?: string;
  env: Record<string, string>;
  analysisFocus?: import('./analysis-focus').AnalysisFocus;
  repoFacts?: import('./remote-source').RepoFacts;
  repoFactsUnavailable?: boolean;

  forceFullRebuild?: boolean;
}

interface WorkerResultMessage<T = AnalysisRunSummary> {
  type: 'result';
  id: number;
  summary: T;
}

interface WorkerErrorMessage {
  type: 'error';
  id: number;
  message: string;
  stackTop?: string;
}






interface WorkerPhaseMessage extends LayeredJobPhaseEvent {
  type: 'phase';
  id: number;
}

type WorkerResponse = WorkerResultMessage | WorkerErrorMessage | WorkerPhaseMessage;

interface PendingWorkerJob<T = AnalysisRunSummary> {
  projectPath: string;
  startedAtMs: number;
  resolve: (summary: T) => void;
  reject: (error: Error) => void;

  onPhase?: (event: LayeredJobPhaseEvent) => void;
}

interface WorkerHandle {
  child: ChildProcess;
  remote: boolean;
  heap: AnalysisHeapResolution;
  stderrTail: string;
  idleTimer?: NodeJS.Timeout;




  pending: Map<number, PendingWorkerJob<any>>;
}

const WORKER_STDERR_TAIL_CHARS = 4096;

let workerHandle: WorkerHandle | null = null;
let nextWorkerJobId = 1;

const DEFAULT_ANALYSIS_WORKER_IDLE_MS = 0;

export function resolveAnalysisWorkerIdleMs(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = env.KLAURO_ANALYSIS_WORKER_IDLE_MS;
  const parsed = raw !== undefined && raw !== '' ? Number(raw) : NaN;
  if (parsed === -1) return null;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_ANALYSIS_WORKER_IDLE_MS;
}

function clearWorkerIdleTimer(handle: WorkerHandle): void {
  if (!handle.idleTimer) return;
  clearTimeout(handle.idleTimer);
  handle.idleTimer = undefined;
}

function scheduleWorkerIdleShutdown(handle: WorkerHandle): void {
  clearWorkerIdleTimer(handle);
  if (handle.pending.size > 0 || workerHandle !== handle) return;
  if (handle.remote) {
    workerHandle = null;
    if (handle.child.connected) handle.child.disconnect();
    return;
  }
  const idleMs = resolveAnalysisWorkerIdleMs();
  if (idleMs === null) return;
  handle.idleTimer = setTimeout(() => {
    handle.idleTimer = undefined;
    if (workerHandle !== handle || handle.pending.size > 0) return;
    workerHandle = null;
    handle.child.disconnect();
  }, idleMs);
  handle.idleTimer.unref();
}


function collectKlauroEnvSnapshot(): Record<string, string> {
  const snapshot: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('KLAURO_') && value !== undefined) snapshot[key] = value;
  }
  return snapshot;
}

function spawnAnalysisWorker(heap: AnalysisHeapResolution): WorkerHandle {
  const remote = Boolean(process.env.KLAURO_ANALYSIS_WORKER_SOCKET);
  const child = fork(resolveAnalysisWorkerEntry(remote ? 'analysis-worker-proxy' : 'analysis-worker'), [], {
    execArgv: [...analysisWorkerExecArgv(process.execArgv), `--max-old-space-size=${remote ? 64 : heap.heapMb}`],
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: process.env,
  });

  const handle: WorkerHandle = { child, remote, heap, stderrTail: '', pending: new Map() };

  const captureOutput = (chunk: Buffer) => {
    process.stderr.write(chunk);
    handle.stderrTail = (handle.stderrTail + chunk.toString()).slice(-WORKER_STDERR_TAIL_CHARS);
  };
  child.stdout?.on('data', captureOutput);
  child.stderr?.on('data', captureOutput);

  child.on('message', (message: WorkerResponse) => {
    const job = handle.pending.get(message.id);
    if (!job) return;
    if (message.type === 'phase') {



      job.onPhase?.({ phase: message.phase, status: message.status, error: message.error });
      return;
    }
    handle.pending.delete(message.id);
    if (message.type === 'result') {
      job.resolve(message.summary);
    } else {
      const error = new Error(message.message);
      if (message.stackTop) error.stack = `${message.message}\n${message.stackTop}`;
      job.reject(error);
    }
    scheduleWorkerIdleShutdown(handle);
  });

  child.on('error', (error) => {
    failPendingWorkerJobs(handle, null, null, `worker process error: ${error.message}`);
  });

  child.on('exit', (code, signal) => {
    if (workerHandle === handle) workerHandle = null;
    failPendingWorkerJobs(handle, code, signal);
  });

  return handle;
}


function workerLooksOutOfMemory(handle: WorkerHandle, code: number | null, signal: NodeJS.Signals | null): boolean {
  if (/Reached heap limit|JavaScript heap out of memory|FATAL ERROR/i.test(handle.stderrTail)) return true;
  return signal === 'SIGABRT' || code === 134;
}
function buildWorkerCrashMessage(
  handle: WorkerHandle,
  job: PendingWorkerJob,
  code: number | null,
  signal: NodeJS.Signals | null,
  detail?: string,
): string {
  const exitDescription = detail
    ? detail
    : signal
      ? `killed by signal ${signal}`
      : `exited with code ${code}`;
  const oom = workerLooksOutOfMemory(handle, code, signal);
  const heap = handle.heap;
  const heapSource = heap.source === 'env' ? 'from KLAURO_ANALYSIS_HEAP_MB' : 'default';
  return [
    `Analysis worker for ${job.projectPath} ${exitDescription}${oom ? ' after exhausting its heap' : ''}.`,
    handle.remote
      ? 'The isolated worker service or its IPC proxy ended; inspect both service logs and their separate memory budgets before retrying.'
      : oom
      ? `The worker heap was ${heap.heapMb} MB (${heapSource}); inspect the shared container memory budget before changing KLAURO_ANALYSIS_HEAP_MB or retrying the complete analysis.`
      : 'The process ended without heap-exhaustion evidence; inspect the worker lifecycle and service logs before retrying.',
    `A run-failed record was written to ${getAnalysisRunLogPath()}; inspect service health because the worker and API may share a container memory limit.`,
  ].join(' ');
}

function failPendingWorkerJobs(
  handle: WorkerHandle,
  code: number | null,
  signal: NodeJS.Signals | null,
  detail?: string,
): void {
  for (const [id, job] of handle.pending) {
    handle.pending.delete(id);
    const message = buildWorkerCrashMessage(handle, job, code, signal, detail);
    try {
      finalizeWorkerRunFailure(job.projectPath, job.startedAtMs, message);
    } catch {

    }
    job.reject(new Error(message));
  }
}

function readRunLogRecords(): AnalysisRunRecord[] {
  const logPath = getAnalysisRunLogPath();
  if (!nodeFs.existsSync(logPath)) return [];
  const records: AnalysisRunRecord[] = [];
  for (const line of nodeFs.readFileSync(logPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line) as AnalysisRunRecord);
    } catch {

    }
  }
  return records;
}

export function finalizeWorkerRunFailure(projectPath: string, jobStartedAtMs: number, message: string): void {
  const records = readRunLogRecords();
  const finalized = new Set(
    records
      .filter(record => record.event === 'run-complete' || record.event === 'run-failed')
      .map(record => record.run_id),
  );
  const orphans = records.filter((record): record is AnalysisRunStartRecord =>
    record.event === 'run-start' &&
    record.project_path === projectPath &&
    !finalized.has(record.run_id) &&
    Date.parse(record.started_at) >= jobStartedAtMs - 60_000,
  );

  const nowIso = new Date().toISOString();
  const failures: AnalysisRunFinalRecord[] = orphans.length > 0
    ? orphans.map(start => ({
      run_id: start.run_id,
      project_path: start.project_path,
      project_name: start.project_name,
      cas_version: start.cas_version,
      event: 'run-failed',
      started_at: start.started_at,
      ended_at: nowIso,
      duration_ms: Math.max(0, Date.now() - Date.parse(start.started_at)),
      phases: [],
      analyzers: [],
      warnings: [],
      warning_overflow: 0,
      error: { message },
    }))
    : [{
      run_id: `analysis_worker_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
      project_path: projectPath,
      project_name: path.basename(projectPath),
      event: 'run-failed',
      started_at: new Date(jobStartedAtMs).toISOString(),
      ended_at: nowIso,
      duration_ms: Math.max(0, Date.now() - jobStartedAtMs),
      phases: [],
      analyzers: [],
      warnings: [],
      warning_overflow: 0,
      error: { message },
    }];

  const logPath = getAnalysisRunLogPath();
  nodeFs.mkdirSync(path.dirname(logPath), { recursive: true });
  nodeFs.appendFileSync(logPath, failures.map(record => `${JSON.stringify(record)}\n`).join(''));
}

function ensureAnalysisWorker(): WorkerHandle {
  const heap = resolveAnalysisHeapMb();
  if (workerHandle && (workerHandle.heap.heapMb !== heap.heapMb || workerHandle.remote !== Boolean(process.env.KLAURO_ANALYSIS_WORKER_SOCKET))) {
    shutdownAnalysisWorker();
  }
  if (!workerHandle) {
    workerHandle = spawnAnalysisWorker(heap);
  }
  clearWorkerIdleTimer(workerHandle);
  return workerHandle;
}

export function prewarmAnalysisWorker(): void {
  if (analysisRunsInProcess()) return;
  ensureAnalysisWorker();
}

export function shutdownAnalysisWorker(): void {
  if (!workerHandle) return;
  const handle = workerHandle;
  workerHandle = null;
  clearWorkerIdleTimer(handle);
  handle.child.removeAllListeners('exit');
  handle.child.kill();
  failPendingWorkerJobs(handle, null, 'SIGTERM', 'was shut down while a job was running');
}

async function stopIdleAnalysisWorkerForBackground(): Promise<void> {
  const handle = workerHandle;
  if (!handle || handle.pending.size > 0) return;
  workerHandle = null;
  clearWorkerIdleTimer(handle);
  const exited = new Promise<void>((resolve, reject) => {
    handle.child.once('exit', () => resolve());
    handle.child.once('error', reject);
  });
  if (handle.child.connected) handle.child.disconnect();
  if (handle.child.exitCode === null && handle.child.signalCode === null) handle.child.kill('SIGTERM');
  await exited;
}

registerHostedBackgroundPreflight(stopIdleAnalysisWorkerForBackground);

export function __analysisWorkerRunningForTests(): boolean {
  return workerHandle !== null;
}

function dispatchWorkerJob(projectPath: string, options: RunAnalysisOptions): Promise<AnalysisRunSummary> {
  const handle = ensureAnalysisWorker();
  const id = nextWorkerJobId++;
  return new Promise<AnalysisRunSummary>((resolve, reject) => {
    handle.pending.set(id, { projectPath, startedAtMs: Date.now(), resolve, reject });
    const request: WorkerAnalyzeRequest = {
      type: 'analyze',
      id,
      projectPath,
      forceFull: Boolean(options.forceFull),
      displayName: options.displayName,
      env: collectKlauroEnvSnapshot(),
    };
    handle.child.send(request, (error) => {
      if (error) {
        const job = handle.pending.get(id);
        if (job) {
          handle.pending.delete(id);
          reject(new Error(`Failed to dispatch analysis to worker: ${error.message}`));
        }
      }
    });
  });
}

export interface RunLayeredAnalysisOptions {
  displayName?: string;
  analysisFocus?: import('./analysis-focus').AnalysisFocus;
  repoFacts?: import('./remote-source').RepoFacts;
  repoFactsUnavailable?: boolean;
  onPhase?: (event: LayeredJobPhaseEvent) => void;
  forceAiRefresh?: boolean;
  forceFullRebuild?: boolean;
  admission?: HostedAnalysisTicket;
  onAdmissionUpdate?: (metadata: HostedAnalysisAdmissionMetadata) => void;
}

function dispatchLayeredWorkerJob(projectPath: string, options: RunLayeredAnalysisOptions): Promise<LayeredRunSummary> {
  const handle = ensureAnalysisWorker();
  const id = nextWorkerJobId++;
  return new Promise<LayeredRunSummary>((resolve, reject) => {
    const startedAtMs = Date.now();
    const job: PendingWorkerJob<LayeredRunSummary> = {
      projectPath,
      startedAtMs,
      resolve,
      reject,
      onPhase: options.onPhase,
    };
    handle.pending.set(id, job);
    const envSnapshot = collectKlauroEnvSnapshot();
    if (options.forceAiRefresh) envSnapshot.KLAURO_FORCE_AI_REFRESH = '1';
    const request: WorkerLayeredRequest = {
      type: 'layered',
      id,
      projectPath,
      displayName: options.displayName,
      env: envSnapshot,
      analysisFocus: options.analysisFocus,
      repoFacts: options.repoFacts,
      repoFactsUnavailable: options.repoFactsUnavailable,
      forceFullRebuild: options.forceFullRebuild,
    };
    handle.child.send(request, (error) => {
      if (error) {
        const job = handle.pending.get(id);
        if (job) {
          handle.pending.delete(id);
          reject(new Error(`Failed to dispatch layered analysis to worker: ${error.message}`));
        }
      }
    });
  });
}





async function withOuterWorkerWatchdog<T>(
  projectPath: string,
  run: () => Promise<T>
): Promise<T> {
  const startedAtMs = Date.now();
  const watchdogMs = getAnalysisWatchdogMs();
  const timer = setTimeout(() => {
    const elapsedMinutes = Math.round((Date.now() - startedAtMs) / 60_000);
    console.error(
      `[Klauro] SLOW ANALYSIS: ${projectPath} (worker-dispatched) has been running ${elapsedMinutes}m, ` +
      `exceeding KLAURO_ANALYSIS_WATCHDOG_MS=${watchdogMs}ms. The worker remains authoritative and in progress.`
    );
  }, watchdogMs);
  timer.unref();
  try {
    return await run();
  } finally {
    clearTimeout(timer);
  }
}

















function queueWorkerJob<T>(
  projectPath: string,
  label: string,
  dispatch: () => Promise<T>,
  admission?: HostedAnalysisTicket,
  onAdmissionUpdate?: (metadata: HostedAnalysisAdmissionMetadata) => void,
): Promise<T> {
  const queuedAt = Date.now();
  const ticket = admission ?? reserveHostedAnalysisOrThrow();
  return executeHostedAnalysis(ticket, () => withHostedForegroundPermit(async () => {
    const queueWaitMs = Date.now() - queuedAt;
    const dispatchedAt = Date.now();
    const endForegroundAnalysis = beginForegroundAnalysis();
    const report = (outcome: string): void => {
      console.error(
        `[Klauro] analysis pipeline (${label}, ${outcome}): queue_wait=${queueWaitMs}ms ` +
        `worker=${Date.now() - dispatchedAt}ms total=${Date.now() - queuedAt}ms`,
      );
    };
    return withOuterWorkerWatchdog(projectPath, dispatch).then(
      result => { report('ok'); return result; },


      error => { report('FAILED'); throw error; },
    ).finally(endForegroundAnalysis);
  }), onAdmissionUpdate);
}

export async function runAnalysis(projectPath: string, options: RunAnalysisOptions = {}): Promise<AnalysisRunSummary> {
  if (analysisRunsInProcess()) {
    return runAnalysisInProcess(projectPath, options);
  }
  return queueWorkerJob(projectPath, 'analyze', () => dispatchWorkerJob(projectPath, options));
}












export async function runLayeredAnalysis(
  projectPath: string,
  options: RunLayeredAnalysisOptions = {},
): Promise<LayeredRunSummary> {
  if (analysisRunsInProcess()) {
    const previousForceAiRefresh = process.env.KLAURO_FORCE_AI_REFRESH;
    if (options.forceAiRefresh) process.env.KLAURO_FORCE_AI_REFRESH = '1';
    else delete process.env.KLAURO_FORCE_AI_REFRESH;
    try {
      const { withAnalysisFocus } = await import('./analysis-focus.js');
      return await withAnalysisFocus(options.analysisFocus, async () => {
      const layered = await analyzeProjectLayered(projectPath, options.displayName, options.forceFullRebuild);
      try {
        await layered.l0;
        options.onPhase?.({ phase: 'l0', status: 'succeeded' });
      } catch (error) {
        options.onPhase?.({ phase: 'l0', status: 'failed', error: error instanceof Error ? error.message : String(error) });
      }
      let analyzed: CASOutput;
      try {
        analyzed = await layered.rest;
        const { applyLayeredAnalysisMetadata } = await import('./layered-analysis-metadata.js');
        applyLayeredAnalysisMetadata(analyzed, options);
        options.onPhase?.({ phase: 'rest', status: 'succeeded' });
      } catch (error) {
        options.onPhase?.({ phase: 'rest', status: 'failed', error: error instanceof Error ? error.message : String(error) });
        throw error;
      }
      if (options.repoFacts || options.repoFactsUnavailable) {
        await saveAnalysis(projectPath, analyzed, 'main', { deferSegmentedWrite: true });
      }
      return summarizeLayeredAnalysis(projectPath, analyzed);
      });
    } finally {
      if (previousForceAiRefresh === undefined) delete process.env.KLAURO_FORCE_AI_REFRESH;
      else process.env.KLAURO_FORCE_AI_REFRESH = previousForceAiRefresh;
    }
  }
  const run = queueWorkerJob(
    projectPath,
    'layered',
    () => dispatchLayeredWorkerJob(projectPath, options),
    options.admission,
    options.onAdmissionUpdate,
  );
  return run;
}
