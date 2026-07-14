import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * E1 — AI-decision instrumentation → versioned local dataset (docs/SEMANTIC-MODEL.md).
 *
 * Every comprehension AI call logs (normalized evidence digest, prompt version,
 * structured decision, gate verdict, mechanical corrections, final outcome) to a
 * versioned local JSONL store — the future distillation corpus for a distilled
 * semantic encoder. Encoder training itself is DEFERRED until the dataset exists
 * at scale; this module ONLY records.
 *
 * DOCTRINE (non-negotiable):
 * - PURELY OBSERVATIONAL. `recordSemanticDecision` must NEVER change comprehension
 *   behavior or output. It is env-gated OFF by default (cheap no-op) and every
 *   write path is wrapped so a logging failure (bad path, full disk) can never
 *   throw into the comprehension path.
 * - NO SECRETS. The record carries a COMPACT evidence DIGEST (sizes/counts/key
 *   names) and a truncated output excerpt — never tokens, API keys, or full source.
 * - DETERMINISTIC, VERSIONED SCHEMA. Bump SEMANTIC_DATASET_SCHEMA_VERSION when the
 *   record shape changes so the corpus stays interpretable across versions.
 */

/** Bump when the record shape changes. */
export const SEMANTIC_DATASET_SCHEMA_VERSION = 'e1.1';

/** Hard cap on any free-text excerpt persisted to the dataset. */
const RAW_OUTPUT_EXCERPT_MAX = 800;

/**
 * The kind of comprehension decision being logged. Open-ended (string) so new
 * call sites can add a type without a schema bump; the listed literals are the
 * currently-wired sites.
 */
export type SemanticDecisionType =
  | 'system_description'
  | 'capability_catalog'
  | 'workspace_narrative'
  | 'workspace_item_descriptions'
  | 'ai_provider_attempt'
  | 'step_naming'
  | (string & {});

export type SemanticGateVerdict = 'accepted' | 'rejected' | 'degraded';
export type SemanticFinalOutcome = 'ai' | 'degraded' | 'error';

/**
 * One comprehension AI decision. `ts` is passed in by the caller (Date.now is
 * unavailable in some execution contexts) — this module never reads the clock.
 */
export interface SemanticDecisionRecord {
  /** Caller-supplied epoch millis. Governs which daily file the record lands in. */
  ts: number;
  decision_type: SemanticDecisionType;
  /** Stable identifier for the prompt contract that produced this decision. */
  prompt_version?: string;
  model?: string;
  provider?: string;
  /**
   * COMPACT summary of the evidence package — sizes/counts/key names, enough to
   * reconstruct the decision context. NEVER secrets, tokens, or full source.
   */
  input_evidence_digest?: Record<string, unknown>;
  /** Truncated excerpt of the model's raw output. */
  raw_output_excerpt?: string;
  parse_ok?: boolean;
  gate_verdict?: SemanticGateVerdict;
  gate_reason?: string;
  /** What mechanical repair applied, e.g. ['trim', 'strip', 'reprompt']. */
  mechanical_corrections?: string[];
  final_outcome?: SemanticFinalOutcome;
  confidence?: number;
}

/** The persisted line shape: the record plus the schema stamp. */
export interface StoredSemanticDecision extends SemanticDecisionRecord {
  schema_version: string;
}

/**
 * Logging is ON only when explicitly opted in — either KLAURO_SEMANTIC_DATASET=1
 * or an explicit KLAURO_SEMANTIC_DATASET_DIR. Off by default so normal/CI runs
 * never write.
 */
export function semanticDatasetEnabled(): boolean {
  const flag = process.env.KLAURO_SEMANTIC_DATASET;
  if (flag === '1' || flag === 'true') return true;
  const dir = process.env.KLAURO_SEMANTIC_DATASET_DIR;
  return typeof dir === 'string' && dir.trim().length > 0;
}

/** Versioned store root. KLAURO_SEMANTIC_DATASET_DIR overrides ~/.klauro/semantic-dataset. */
export function resolveSemanticDatasetDir(): string {
  const override = process.env.KLAURO_SEMANTIC_DATASET_DIR;
  if (typeof override === 'string' && override.trim().length > 0) return override.trim();
  return path.join(os.homedir(), '.klauro', 'semantic-dataset');
}

/** YYYY-MM-DD partition derived from the caller-supplied timestamp (UTC). */
function dayStamp(ts: number): string {
  const millis = typeof ts === 'number' && Number.isFinite(ts) ? ts : 0;
  return new Date(millis).toISOString().slice(0, 10);
}

function truncate(value: string | undefined, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…[+${value.length - max}]`;
}

function toStored(record: SemanticDecisionRecord): StoredSemanticDecision {
  return {
    schema_version: SEMANTIC_DATASET_SCHEMA_VERSION,
    ...record,
    raw_output_excerpt: truncate(record.raw_output_excerpt, RAW_OUTPUT_EXCERPT_MAX),
  };
}

/**
 * Append one comprehension decision to the versioned local dataset.
 *
 * A no-op unless opted in via env (see semanticDatasetEnabled). Every failure is
 * swallowed: this is observational instrumentation and MUST NOT perturb the
 * comprehension path.
 */
export function recordSemanticDecision(record: SemanticDecisionRecord): void {
  try {
    if (!semanticDatasetEnabled()) return;
    const dir = resolveSemanticDatasetDir();
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${dayStamp(record.ts)}.jsonl`);
    fs.appendFileSync(file, `${JSON.stringify(toStored(record))}\n`);
  } catch {
    // Observational only. A disk/path failure must NEVER throw into comprehension.
  }
}

/**
 * Read back the records for a given day. Test/analysis helper only — the
 * comprehension path never reads the dataset.
 */
export function readSemanticDataset(ts: number, dir = resolveSemanticDatasetDir()): StoredSemanticDecision[] {
  try {
    const file = path.join(dir, `${dayStamp(ts)}.jsonl`);
    const raw = fs.readFileSync(file, 'utf8');
    return raw
      .split('\n')
      .filter(line => line.trim().length > 0)
      .map(line => JSON.parse(line) as StoredSemanticDecision);
  } catch {
    return [];
  }
}
