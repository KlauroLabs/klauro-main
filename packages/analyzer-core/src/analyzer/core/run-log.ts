import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { CASAnalysisError } from '../../types/cas.types';

const DEFAULT_MAX_RUNS = 50;
const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
const MAX_WARNINGS_PER_RUN = 50;
const MAX_MESSAGE_CHARS = 500;

export interface AnalysisRunPhaseRecord {
  phase: string;
  started_at: string;
  duration_ms: number;
}

export interface AnalysisRunAnalyzerRecord {
  analyzer_id: string;
  analyzer_type: string;
  execution_time_ms?: number;
  nodes_contributed: number;
  edges_contributed: number;
  warning_count: number;
}

export interface AnalysisRunAiRecord {
  provider_configured: boolean;
  providers: string[];
  attempted: boolean;
  outcome: string;
  reason?: string;
  duration_ms?: number;
  description_source?: string;
}

export interface AnalysisRunWarningRecord {
  severity: CASAnalysisError['severity'];
  code: string;
  analyzer?: string;
  message: string;
}

export interface AnalysisRunTotals {
  nodes: number;
  edges: number;
  entry_points: number;
  exit_points: number;
  files: number;
  errors: number;
  warnings: number;
}

interface AnalysisRunBaseRecord {
  run_id: string;
  project_path: string;
  project_name: string;
  cas_version?: string;
}

export interface AnalysisRunStartRecord extends AnalysisRunBaseRecord {
  event: 'run-start';
  started_at: string;
}

export interface AnalysisRunFinalRecord extends AnalysisRunBaseRecord {
  event: 'run-complete' | 'run-failed';
  started_at: string;
  ended_at: string;
  duration_ms: number;
  phases: AnalysisRunPhaseRecord[];
  analyzers: AnalysisRunAnalyzerRecord[];
  ai?: AnalysisRunAiRecord;
  warnings: AnalysisRunWarningRecord[];
  warning_overflow: number;
  totals?: AnalysisRunTotals;
  error?: { message: string; stack_top?: string };
}

export type AnalysisRunRecord = AnalysisRunStartRecord | AnalysisRunFinalRecord;

export function getAnalysisLogDir(): string {
  if (process.env.KLAURO_LOG_DIR) return process.env.KLAURO_LOG_DIR;
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
  return path.join(home, '.klauro', 'logs');
}

export function getAnalysisRunLogPath(): string {
  return path.join(getAnalysisLogDir(), 'analysis-runs.jsonl');
}

function runLogDisabled(): boolean {
  return process.env.KLAURO_RUN_LOG === 'false' || process.env.KLAURO_RUN_LOG === '0';
}

function maxRuns(): number {
  const configured = Number(process.env.KLAURO_RUN_LOG_MAX_RUNS || '');
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_MAX_RUNS;
}

function maxBytes(): number {
  const configured = Number(process.env.KLAURO_RUN_LOG_MAX_BYTES || '');
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_MAX_BYTES;
}

function truncateMessage(message: string): string {
  if (message.length <= MAX_MESSAGE_CHARS) return message;
  return `${message.slice(0, MAX_MESSAGE_CHARS)}... [truncated]`;
}

function appendRecord(record: AnalysisRunRecord): void {
  const filePath = getAnalysisRunLogPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`);
  rotateRunLog(filePath);
}

function rotateRunLog(filePath: string): void {
  const stat = fs.statSync(filePath);
  const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(line => line.trim().length > 0);
  const runOrder: string[] = [];
  const seen = new Set<string>();
  const runIdOf = (line: string): string | undefined => {
    try {
      const parsed = JSON.parse(line);
      return typeof parsed.run_id === 'string' ? parsed.run_id : undefined;
    } catch {
      return undefined;
    }
  };
  for (const line of lines) {
    const runId = runIdOf(line);
    if (runId && !seen.has(runId)) {
      seen.add(runId);
      runOrder.push(runId);
    }
  }

  const runLimit = maxRuns();
  const byteLimit = maxBytes();
  if (runOrder.length <= runLimit && stat.size <= byteLimit) return;

  let keptRunIds = new Set(runOrder.slice(Math.max(0, runOrder.length - runLimit)));
  let keptLines = lines.filter(line => {
    const runId = runIdOf(line);
    return runId !== undefined && keptRunIds.has(runId);
  });

  let serialized = keptLines.length > 0 ? `${keptLines.join('\n')}\n` : '';
  let keptOrder = runOrder.filter(runId => keptRunIds.has(runId));
  while (Buffer.byteLength(serialized, 'utf8') > byteLimit && keptOrder.length > 1) {
    keptOrder = keptOrder.slice(1);
    keptRunIds = new Set(keptOrder);
    keptLines = keptLines.filter(line => {
      const runId = runIdOf(line);
      return runId !== undefined && keptRunIds.has(runId);
    });
    serialized = keptLines.length > 0 ? `${keptLines.join('\n')}\n` : '';
  }

  fs.writeFileSync(filePath, serialized);
}

export class AnalysisRunLog {
  private readonly base: AnalysisRunBaseRecord;
  private readonly startedAtMs: number;
  private readonly phases: AnalysisRunPhaseRecord[] = [];
  private analyzers: AnalysisRunAnalyzerRecord[] = [];
  private ai?: AnalysisRunAiRecord;
  private warnings: AnalysisRunWarningRecord[] = [];
  private warningOverflow = 0;
  private finalized = false;

  constructor(projectPath: string, runId: string, casVersion?: string) {
    this.base = {
      run_id: runId,
      project_path: projectPath,
      project_name: path.basename(projectPath),
      cas_version: casVersion,
    };
    this.startedAtMs = Date.now();
    this.write({
      ...this.base,
      event: 'run-start',
      started_at: new Date(this.startedAtMs).toISOString(),
    });
  }

  recordPhase(phase: string, startedAtMs: number, durationMs: number): void {
    this.phases.push({
      phase,
      started_at: new Date(startedAtMs).toISOString(),
      duration_ms: durationMs,
    });
  }

  recordAnalyzers(contributions: Array<{
    analyzer_id: string;
    analyzer_type?: string;
    contribution_type?: string;
    execution_time_ms?: number;
    nodes_created?: number;
    edges_created?: number;
    warnings?: unknown[];
  }>): void {
    this.analyzers = contributions.map(contribution => ({
      analyzer_id: contribution.analyzer_id,
      analyzer_type: contribution.analyzer_type || contribution.contribution_type || 'unknown',
      execution_time_ms: contribution.execution_time_ms,
      nodes_contributed: contribution.nodes_created || 0,
      edges_contributed: contribution.edges_created || 0,
      warning_count: Array.isArray(contribution.warnings) ? contribution.warnings.length : 0,
    }));
  }

  recordAi(record: AnalysisRunAiRecord): void {
    this.ai = record;
  }

  recordWarnings(analysisErrors: CASAnalysisError[]): void {
    this.warnings = analysisErrors.slice(0, MAX_WARNINGS_PER_RUN).map(error => ({
      severity: error.severity,
      code: error.code,
      analyzer: error.analyzer,
      message: truncateMessage(error.message),
    }));
    this.warningOverflow = Math.max(0, analysisErrors.length - MAX_WARNINGS_PER_RUN);
  }

  complete(totals: AnalysisRunTotals): void {
    this.finalize('run-complete', totals);
  }

  fail(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const stackTop = error instanceof Error && error.stack
      ? error.stack.split('\n').slice(0, 3).join('\n')
      : undefined;
    this.finalize('run-failed', undefined, { message: truncateMessage(message), stack_top: stackTop });
  }

  private finalize(
    event: 'run-complete' | 'run-failed',
    totals?: AnalysisRunTotals,
    error?: { message: string; stack_top?: string }
  ): void {
    if (this.finalized) return;
    this.finalized = true;
    const endedAtMs = Date.now();
    this.write({
      ...this.base,
      event,
      started_at: new Date(this.startedAtMs).toISOString(),
      ended_at: new Date(endedAtMs).toISOString(),
      duration_ms: endedAtMs - this.startedAtMs,
      phases: this.phases,
      analyzers: this.analyzers,
      ai: this.ai,
      warnings: this.warnings,
      warning_overflow: this.warningOverflow,
      totals,
      error,
    });
  }

  private write(record: AnalysisRunRecord): void {
    if (runLogDisabled()) return;
    try {
      appendRecord(record);
    } catch {
      // Run logging must never break or fail an analysis.
    }
  }
}

export function readRecentRunRecords(limit = DEFAULT_MAX_RUNS): AnalysisRunRecord[] {
  const filePath = getAnalysisRunLogPath();
  if (!fs.existsSync(filePath)) return [];
  const records: AnalysisRunRecord[] = [];
  for (const line of fs.readFileSync(filePath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      // Skip lines corrupted by interrupted writes.
    }
  }
  return records.slice(Math.max(0, records.length - limit * 2));
}
