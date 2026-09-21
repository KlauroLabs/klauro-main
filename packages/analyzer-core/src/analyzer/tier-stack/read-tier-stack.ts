import * as buffer from 'buffer';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';

import { readInterned } from './read-interned';

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

export type TierStackDeclaration = 'type' | 'foreign key' | 'decorator' | 'call';

export interface TierStackReference {
  field: string;
  entity: string;
  many?: boolean;
  declared_by: TierStackDeclaration;
}

export interface TierStackField {
  name: string;
  declared_as?: string;
}

export interface TierStackEntity {
  id: string;
  declared_as: string;
  name?: string;
  description?: string;
  named_fields?: TierStackField[];
  declared_in?: string;
  fields: number;
  addressed_by: number;
  written_by: string[];
  read_by: string[];
  references?: TierStackReference[];
  project?: string;
}

export interface TierStackGrounding {
  supported: number;
  invented: number;
  specific: number;
  outcome: number;
  universal?: number;
}

export interface TierStackCapability {
  id: string;
  name?: string;
  description?: string;
  audience?: string;
  records?: string[];
  changes?: string[];
  flows?: string[];
  surfaces?: string[];
  standing?: 'published' | 'provisional';
  grounding?: TierStackGrounding;
}

export interface TierStackProduct {
  project?: string;
  description: string;
  grounding: TierStackGrounding;
}

export interface TierStackStep {
  unit: string;
  depth: number;
  leaves?: string[];
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
  steps?: TierStackStep[];
  writes?: string[];
  reads?: string[];
  changes?: string[];
  leads_into?: string[];
}

export interface TierStackIndex {
  root: string;
  files: Array<{ path: string; kind: string; language?: string; extracted?: boolean; generated?: boolean }>;
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
  architecture?: { shape?: string; routes?: number; serving?: number };
  roles?: { roles?: Array<{ node: string; role: string }> };
  comprehension?: {
    products?: TierStackProduct[];
    capabilities?: TierStackCapability[];
    flows?: TierStackFlow[];
    entities?: TierStackEntity[];
  };
}

export function resolveEngine(directory = __dirname): string | null {
  const candidates = [
    path.join(directory, 'native', 'klauro-engine'),
    path.resolve(directory, '../../../native/klauro-engine/target/release/klauro-engine'),
  ];
  return candidates.find(candidate => fs.existsSync(candidate)) ?? null;
}

export function enginePath(): string {
  const found = process.env.KLAURO_ENGINE ?? resolveEngine();
  if (!found) {
    throw new Error(
      'The analyzer binary is not installed beside this build. Set KLAURO_ENGINE, or build '
      + 'packages/analyzer-core/native/klauro-engine for this platform.'
    );
  }
  return found;
}

export async function readTierStack(projectPath: string): Promise<TierStackIndex> {
  const { stdout } = await run(enginePath(), [projectPath], {
    maxBuffer: buffer.constants.MAX_LENGTH,
    encoding: 'buffer',
  });
  return readInterned(stdout) as TierStackIndex;
}
