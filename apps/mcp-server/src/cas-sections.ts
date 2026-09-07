import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import type { SubCasNodeIndex } from './deployable-analysis';

export const CAS_SECTION_NAMES = [
  'identity',
  'tree',
  'graph',
  'calls',
  'facts',
  'comprehension',
  'tests',
  'runtime',
  'quality',
  'supplemental',
] as const;

export type CasSectionName = typeof CAS_SECTION_NAMES[number];

export interface CasSectionDescriptor {
  name: CasSectionName;
  fields: string[];
  file?: string;
  bytes?: number;
  sha256?: string;
}

export interface CasTreeProjectionV1 {
  format: 'derived-deployable-references';
  version: 1;
  children: Array<{ id: string; file: string; bytes: number; sha256: string }>;
}

export interface CasTreeNodeDescriptor {
  id: string;
  parent_id: string | null;
  child_ids: string[];
  logical_fields: string[];
  sections: CasSectionDescriptor[];
}

export interface CasTreeProjectionV2 {
  format: 'recursive-cas-section-references';
  version: 2;
  root_id: string;
  nodes: CasTreeNodeDescriptor[];
  sub_cas_nodes?: SubCasNodeIndex;
}

export function validateCasTreeProjection(projection: CasTreeProjectionV2): void {
  if (!projection.root_id) throw new Error('Recursive CAS tree projection requires a root id');
  const byId = new Map<string, CasTreeNodeDescriptor>();
  for (const node of projection.nodes) {
    if (!node.id) throw new Error('Recursive CAS tree projection contains a node without an id');
    if (byId.has(node.id)) throw new Error(`Recursive CAS tree projection contains duplicate id ${node.id}`);
    byId.set(node.id, node);
  }
  const root = byId.get(projection.root_id);
  if (!root) throw new Error(`Recursive CAS tree projection root ${projection.root_id} is missing`);
  if (root.parent_id !== null) throw new Error('Recursive CAS tree projection root cannot have a parent');
  const visited = new Set<string>();
  const active = new Set<string>();
  const stack: Array<{ id: string; exit: boolean }> = [{ id: projection.root_id, exit: false }];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current.exit) {
      active.delete(current.id);
      continue;
    }
    if (active.has(current.id)) throw new Error(`Recursive CAS tree projection contains a cycle at ${current.id}`);
    if (visited.has(current.id)) throw new Error(`Recursive CAS tree projection reaches ${current.id} through more than one parent`);
    const node = byId.get(current.id);
    if (!node) throw new Error(`Recursive CAS tree projection references missing child ${current.id}`);
    visited.add(current.id);
    active.add(current.id);
    stack.push({ id: current.id, exit: true });
    for (let index = node.child_ids.length - 1; index >= 0; index -= 1) {
      const childId = node.child_ids[index];
      const child = byId.get(childId);
      if (!child) throw new Error(`Recursive CAS tree projection references missing child ${childId}`);
      if (child.parent_id !== node.id) throw new Error(`Recursive CAS tree projection child ${childId} has parent ${String(child.parent_id)} instead of ${node.id}`);
      stack.push({ id: childId, exit: false });
    }
  }
  if (visited.size !== projection.nodes.length) throw new Error('Recursive CAS tree projection contains unreachable nodes');
}

export interface CasSectionManifest {
  manifest_version: 1;
  cas_version: string;
  analysis_id: string;
  analysis_timestamp: string;
  sections: CasSectionDescriptor[];
  logical_fields: string[];
  collection_totals?: Record<string, number>;
  collection_bytes?: Record<string, number>;
  tree_projection?: CasTreeProjectionV1 | CasTreeProjectionV2;
  compact_graph?: {
    format: 'klauro-compact-cas-graph';
    version: 1;
    node_count: number;
    vertex_count: number;
    edge_count: number;
    limits: {
      maxNodes: number;
      maxVertices: number;
      maxEdges: number;
      maxStrings: number;
      maxStringBytes: number;
      maxPageSize: number;
      maxTraversalNodes: number;
      maxTraversalEdges: number;
      maxTraversalDepth: number;
    };
    columns: Record<string, CasRawColumnDescriptor>;
  };
  record_store?: import('./cas-record-store').CasRecordStoreDescriptor;
  semantic_store?: import('./cas-record-store').CasSemanticStoreDescriptor;
  compact_search?: {
    format: 'klauro-compact-cas-search';
    version: 2 | 3;
    node_count: number;
    description_chunk_nodes: number;
    shard_count: number;
    nonempty_shards: number[];
    posting_records: number;
    posting_runs: number;
    columns: Record<string, CasRawColumnDescriptor>;
  };
}

export interface CasRawColumnDescriptor {
  file: string;
  encoding: 'uint8' | 'uint32-le';
  length: number;
  bytes: number;
  sha256: string;
}

const IDENTITY_FIELDS = new Set([
  'cas_version',
  'id',
  'parent_id',
  'label',
  'composition_mode',
  'analysis_id',
  'analysis_timestamp',
  'analyzer_build',




  'parser_fingerprint',
  'derived_fingerprint',
  'base_commit',
  'branch',
  'track',
  'system',
  'layers_ready',
  'analysis_phases',
  'timings',
  'validation',
  'ai_enrichment',
  'ai_enrichment_error',
  'analysis_source',
]);

const EXPLICIT_SECTIONS: Partial<Record<string, CasSectionName>> = {
  children: 'tree',
  nodes: 'graph',
  edges: 'graph',
  index: 'graph',
  method_calls: 'calls',
  call_chains: 'calls',
  reachability_index: 'calls',
  analysis_facts: 'facts',
  runtime_static_links: 'facts',
};

export const CAS_SECTION_PROFILES = {
  identity: ['identity'],
  tree: ['identity', 'tree'],
  summary: ['identity', 'comprehension', 'tests', 'runtime', 'quality'],
  system_overview: ['identity', 'facts', 'comprehension', 'tests', 'runtime', 'quality', 'supplemental'],
  graph_search: ['identity', 'graph'],
  node_detail: ['identity', 'graph', 'calls', 'facts', 'comprehension', 'quality', 'supplemental'],
  call_graph: ['identity', 'graph', 'calls'],
  full: [...CAS_SECTION_NAMES],
} as const satisfies Record<string, readonly CasSectionName[]>;

export function casSectionForField(field: string): CasSectionName {
  if (IDENTITY_FIELDS.has(field)) return 'identity';
  const explicit = EXPLICIT_SECTIONS[field];
  if (explicit) return explicit;
  if (/test|coverage|mock|fixture/i.test(field)) return 'tests';
  if (/runtime|telemetry|communication|consistency|deploy|distribution|infrastructure|cicd|pipeline/i.test(field)) return 'runtime';
  if (/capabil|flow|step|entit|journey|intent|domain|purpose|product|behavior_surface|semantic|terminality/i.test(field)) return 'comprehension';
  if (/risk|health|pattern|architecture|idiom|invariant|security|quality|error|conflict|principle|paradigm|stability/i.test(field)) return 'quality';
  return 'supplemental';
}

export function measureCasCollections(cas: CASOutput): { totals: Record<string, number>; bytes: Record<string, number> } {
  const totals: Record<string, number> = {};
  const bytes: Record<string, number> = {};
  for (const field of Object.keys(cas).sort()) {
    const value = (cas as unknown as Record<string, unknown>)[field];
    if (value === undefined) continue;
    if (Array.isArray(value)) totals[field] = value.length;
    bytes[field] = Buffer.byteLength(JSON.stringify(value) ?? 'null', 'utf8');
  }
  return { totals, bytes };
}

export function createCasSectionManifest(cas: CASOutput): CasSectionManifest {
  const fields = Object.keys(cas).sort();
  const grouped = new Map<CasSectionName, string[]>(CAS_SECTION_NAMES.map(name => [name, []]));
  for (const field of fields) grouped.get(casSectionForField(field))!.push(field);
  const measured = measureCasCollections(cas);
  return {
    manifest_version: 1,
    cas_version: cas.cas_version,
    analysis_id: cas.analysis_id,
    analysis_timestamp: cas.analysis_timestamp,
    sections: CAS_SECTION_NAMES
      .map(name => ({ name, fields: grouped.get(name)! }))
      .filter(section => section.fields.length > 0),
    logical_fields: fields,
    collection_totals: measured.totals,
    collection_bytes: measured.bytes,
  };
}

export function selectCasSections(
  cas: CASOutput,
  requested: readonly CasSectionName[],
): Partial<CASOutput> {
  const selected = new Set<CasSectionName>(['identity', ...requested]);
  const output: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(cas)) {
    if (selected.has(casSectionForField(field))) output[field] = value;
  }
  return output as Partial<CASOutput>;
}

export function selectExactCasSection(cas: CASOutput, section: CasSectionName): Partial<CASOutput> {
  const output: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(cas)) {
    if (casSectionForField(field) === section) output[field] = value;
  }
  return output as Partial<CASOutput>;
}

export function hydrateCasSections(parts: ReadonlyArray<Partial<CASOutput>>): CASOutput {
  return Object.assign({}, ...parts) as CASOutput;
}

export function parseCasSectionNames(value: string | null | undefined): CasSectionName[] {
  if (!value) return [];
  const names = value.split(',').map(item => item.trim()).filter(Boolean);
  const allowed = new Set<string>(CAS_SECTION_NAMES);
  const unknown = names.filter(name => !allowed.has(name));
  if (unknown.length > 0) throw new Error(`Unknown CAS section(s): ${unknown.join(', ')}`);
  return [...new Set(names)] as CasSectionName[];
}
