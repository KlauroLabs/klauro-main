import { execFile } from 'child_process';
import * as path from 'path';
import { promisify } from 'util';

const run = promisify(execFile);

export interface TierStackSpan {
  line: number;
  column?: number;
  end_line?: number;
  end_column?: number;
}

export interface TierStackNode {
  id: string;
  name: string;
  kind: string;
  file: number;
  span: TierStackSpan;
  parent?: string;
  type_annotation?: string;
  documentation?: string;
  project?: string;
}

export interface TierStackEdge {
  source: string;
  target: string;
  kind: string;
}

export interface TierStackEntryPoint {
  id: string;
  kind: string;
  name: string;
  method?: string;
  path?: string;
  handler: string;
  file: number;
  line: number;
  registrar: string;
}

export interface TierStackExitPoint {
  id: string;
  kind: string;
  source: string;
  target: string;
  file: number;
  line: number;
}

export interface TierStackReference {
  field: string;
  entity: string;
  many?: boolean;
}

export interface TierStackEntity {
  id: string;
  declared_as: string;
  name?: string;
  description?: string;
  named_fields?: string[];
  declared_in?: string;
  fields: number;
  addressed_by: number;
  written_by: string[];
  read_by: string[];
  references?: TierStackReference[];
  project?: string;
}

export interface TierStackFlow {
  id: string;
  entry_point: string;
  kind: string;
  method?: string;
  operation: string;
  standing: string;
  name?: string;
  description?: string;
  steps?: Array<{ unit?: string; operation?: string }>;
  writes?: string[];
  reads?: string[];
}

export interface TierStackIndex {
  root: string;
  files: Array<{ path: string; kind: string; language?: string; extracted?: boolean }>;
  nodes: TierStackNode[];
  edges: TierStackEdge[];
  entry_points?: TierStackEntryPoint[];
  exit_points?: TierStackExitPoint[];
  dependencies?: {
    dependencies?: Array<{
      name: string;
      role?: string;
      category?: string;
      imports?: number;
      projects?: string[];
    }>;
    imported?: number;
    declared?: number;
  };
  architecture?: { shape?: string; routes?: number };
  comprehension?: {
    capabilities?: Array<{ id: string; name: string; description?: string }>;
    flows?: TierStackFlow[];
    entities?: TierStackEntity[];
  };
}

export function indexerPath(): string {
  return (
    process.env.KLAURO_INDEXER
    ?? path.resolve(__dirname, '../../../native/klauro-index/target/release/klauro-index')
  );
}

export const READABLE_BYTES = 0x1fffffe8;

export async function readTierStack(projectPath: string): Promise<TierStackIndex> {
  let stdout: Buffer;
  try {
    ({ stdout } = await run(indexerPath(), [projectPath, '--json'], {
      maxBuffer: READABLE_BYTES,
      encoding: 'buffer',
    }));
  } catch (held) {
    if (outgrewText(held)) {
      throw new Error(tooLarge(projectPath));
    }
    throw held;
  }
  if (stdout.length >= READABLE_BYTES) {
    throw new Error(tooLarge(projectPath, stdout.length));
  }
  return JSON.parse(stdout.toString('utf8')) as TierStackIndex;
}

export function outgrewText(held: unknown): boolean {
  const said = held instanceof Error ? held.message : String(held);
  return said.includes('maxBuffer') || said.includes('string longer than');
}

export function tooLarge(projectPath: string, bytes?: number): string {
  const size = bytes === undefined ? 'more' : `${(bytes / 1e9).toFixed(2)} GB`;
  return (
    `The tier stack described ${projectPath} in ${size} JSON than a string in this runtime `
    + `can hold (${(READABLE_BYTES / 1e9).toFixed(2)} GB). Reading the index in its own binary `
    + 'form would carry it; reading it as JSON cannot.'
  );
}
