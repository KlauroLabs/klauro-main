import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';






















export const SEMANTIC_DATASET_SCHEMA_VERSION = 'e1.1';


const RAW_OUTPUT_EXCERPT_MAX = 800;






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





export interface SemanticDecisionRecord {

  ts: number;
  decision_type: SemanticDecisionType;

  prompt_version?: string;
  model?: string;
  provider?: string;




  input_evidence_digest?: Record<string, unknown>;

  raw_output_excerpt?: string;
  parse_ok?: boolean;
  gate_verdict?: SemanticGateVerdict;
  gate_reason?: string;

  mechanical_corrections?: string[];
  final_outcome?: SemanticFinalOutcome;
  confidence?: number;
}


export interface StoredSemanticDecision extends SemanticDecisionRecord {
  schema_version: string;
}






export function semanticDatasetEnabled(): boolean {
  const flag = process.env.KLAURO_SEMANTIC_DATASET;
  if (flag === '1' || flag === 'true') return true;
  const dir = process.env.KLAURO_SEMANTIC_DATASET_DIR;
  return typeof dir === 'string' && dir.trim().length > 0;
}


export function resolveSemanticDatasetDir(): string {
  const override = process.env.KLAURO_SEMANTIC_DATASET_DIR;
  if (typeof override === 'string' && override.trim().length > 0) return override.trim();
  return path.join(os.homedir(), '.klauro', 'semantic-dataset');
}


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








export function recordSemanticDecision(record: SemanticDecisionRecord): void {
  try {
    if (!semanticDatasetEnabled()) return;
    const dir = resolveSemanticDatasetDir();
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${dayStamp(record.ts)}.jsonl`);
    fs.appendFileSync(file, `${JSON.stringify(toStored(record))}\n`);
  } catch {

  }
}





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
