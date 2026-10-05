import type { EngineLinkCoverage } from '../core/link-coverage';
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

export interface TierStackParameter {
  name: string;
  type_annotation?: string;
  optional?: boolean;
  default_value?: string;
}

export interface TierStackSignature {
  parameters?: TierStackParameter[];
  return_type?: string;
  type_parameters?: string[];
  receiver?: string;
}

export interface TierStackModifiers {
  exported?: boolean;
  default_export?: boolean;
  is_async?: boolean;
  is_static?: boolean;
  abstract_member?: boolean;
  private_member?: boolean;
  protected_member?: boolean;
}

export interface TierStackNode {
  id: string;
  name: string;
  kind: string;
  file: number;
  span: TierStackSpan;
  parent?: string;
  signature?: TierStackSignature;
  modifiers?: TierStackModifiers;
  type_annotation?: string;
  documentation?: string;
  project?: string;
}

export interface TierStackEdge {
  source: string;
  target: string;
  kind: string;
  via?: 'name' | 'rule';
}

export interface TierStackUnshipped {
  role: 'tooling' | 'example' | 'benchmark' | 'test-support' | 'standalone-program';
  basis: 'shipping-evidence' | 'island' | 'name';
  evidence: string;
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
  unshipped?: TierStackUnshipped;
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
  terminality?: 'terminal' | 'proximal';
  touches?: string[];
  project?: string;
  grounding?: TierStackGrounding;
  confidence?: number;
  delivered?: Array<{ flow: string; role: string; rationale: string }>;
  also_in?: string[];
  composition_provenance?: TierStackCompositionSource[];
  parent_originated?: { kind: 'seam' | 'orphan'; evidence: string[] };
}

export interface TierStackCompositionSource {
  source_child: string;
  source_capability_id: string;
  disposition: 'promoted' | 'absorbed';
  weight?: number;
}

export interface TierStackShipDeclaration {
  declares: 'ship' | 'run' | 'identity';
  kind: string;
  at: string;
}

export interface TierStackTestCase {
  id: string;
  name: string;
  file: number;
  shape?: string;
  assertions?: number;
  project?: string;
}

export interface TierStackSubProject {
  id: string;
  name: string;
  root: string;
  files?: number;
  entry_points?: number;
  imports_crossing?: number;
  ship_backed?: boolean;
  runnable?: boolean;
  owner?: string;
  system?: string;
  depends_on?: string[];
}

export interface TierStackComposition {
  mode: 'derived';
  children: Array<{
    id: string;
    name: string;
    status: 'deployable' | 'executable' | 'library' | 'module';
    weight: number;
    weight_basis: { ship: number; activity: number; consumed_by_shipped: boolean; days_since_change?: number; notes: string[] };
  }>;
  seams: Array<{
    from: string;
    to: string;
    kind: 'http' | 'process' | 'ipc';
    communication: 'sync' | 'async' | 'passive';
    origin: 'product' | 'test';
    count: number;
    evidence: string[];
  }>;
  links?: EngineLinkCoverage[];
  dependencies: Array<{ from: string; to: string; count: number; evidence: string[] }>;
  orphan?: { project: string; files: number; declarations: number };
  promoted?: Array<{
    capability: string;
    name: string;
    from: TierStackCompositionSource[];
    parent_originated?: { kind: 'seam' | 'orphan'; evidence: string[] };
  }>;
  not_promoted?: Array<{ child: string; capability: string; reason: string }>;
}

export interface TierStackDeployable {
  id: string;
  name: string;
  root: string;
  category: 'shipped' | 'runnable' | 'library';
  declarations?: TierStackShipDeclaration[];
  ships?: string[];
  runs?: string;
  members?: string[];
  bundled_into?: string;
  units?: number;
  entry_points?: number;
  entered_at?: string[];
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

export interface TierStackRegion {
  unit: string;
  file: number;
  start_line: number;
  end_line: number;
}

export interface TierStackLogicalStep {
  id: string;
  kind: string;
  label: string;
  object?: string;
  doing?: string;
  when: string;
  regions: TierStackRegion[];
  description?: string;
}

export interface TierStackStepEdge {
  from: string;
  to: string;
  kind: string;
}

export interface TierStackFlow {
  id: string;
  entry_point: string;
  kind: string;
  method?: string;
  operation: string;
  standing: string;
  open?: number;
  cut?: boolean;
  name?: string;
  description?: string;
  path?: TierStackStep[];
  steps?: TierStackLogicalStep[];
  step_edges?: TierStackStepEdge[];
  writes?: string[];
  reads?: string[];
  changes?: string[];
  leads_into?: string[];
  reaches?: string[];
  project?: string;
  unshipped?: TierStackUnshipped;
}

export interface TierStackFileHistory {
  path: string;
  commits: number;
  fixes: number;
  recent: number;
  quarter: number;
  recent_authors: number;
  last: number;
  fix_percentile: number;
  churn_percentile: number;
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
  services?: Array<{ name: string; kind: string; projects?: string[] }>;
  patterns?: {
    found?: Array<{ pattern: string; family: string; evidence: string; count: number; examples?: string[]; projects?: string[] }>;
    conformance?: Array<{ paradigm: string; project?: string; population: number; following: number; departing?: string[] }>;
  };
  principles?: {
    solid?: Array<{ principle: string; reads_as: string; population: number; following: number; departing?: string[] }>;
    anti_patterns?: Array<{ anti_pattern: string; reads_as: string; count: number; examples?: string[] }>;
  };
  conformance?: {
    conventions?: Array<{ convention: string; shape: string; population: number; following: number; departing?: string[] }>;
  };
  roles?: { roles?: Array<{ node: string; role: string }> };
  scope?: { deployables?: TierStackDeployable[] };
  partition?: { sub_projects?: TierStackSubProject[] };
  composition?: TierStackComposition;
  verification?: { cases?: TierStackTestCase[] };
  dead?: Array<{ node: string; reason: string; callers: number; open?: string; unlinked?: number }>;
  history?: { commits?: number; fix_commits?: number; files?: TierStackFileHistory[] };
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

export async function readTierStack(projectPath: string, options: { enrich?: boolean } = {}): Promise<TierStackIndex> {
  let stdout: Buffer;
  try {
    ({ stdout } = await run(enginePath(), [projectPath], {
      maxBuffer: buffer.constants.MAX_LENGTH,
      encoding: 'buffer',
      env: options.enrich === false ? { ...process.env, KLAURO_ENRICH: '0' } : process.env,
    }));
  } catch (error) {
    const stderr = (error as { stderr?: Buffer }).stderr;
    const tail = stderr ? stderr.toString('utf8').trim().split('\n').slice(-3).join('\n') : '';
    throw new Error(tail || (error instanceof Error ? error.message : String(error)));
  }
  return readInterned(stdout) as TierStackIndex;
}
