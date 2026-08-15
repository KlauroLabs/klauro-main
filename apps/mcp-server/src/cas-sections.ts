import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';

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
}

export interface CasSectionManifest {
  manifest_version: 1;
  cas_version: string;
  analysis_id: string;
  analysis_timestamp: string;
  sections: CasSectionDescriptor[];
  logical_fields: string[];
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

export function createCasSectionManifest(cas: CASOutput): CasSectionManifest {
  const fields = Object.keys(cas).sort();
  const grouped = new Map<CasSectionName, string[]>(CAS_SECTION_NAMES.map(name => [name, []]));
  for (const field of fields) grouped.get(casSectionForField(field))!.push(field);
  return {
    manifest_version: 1,
    cas_version: cas.cas_version,
    analysis_id: cas.analysis_id,
    analysis_timestamp: cas.analysis_timestamp,
    sections: CAS_SECTION_NAMES
      .map(name => ({ name, fields: grouped.get(name)! }))
      .filter(section => section.fields.length > 0),
    logical_fields: fields,
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
