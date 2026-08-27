import type { CASNode, CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';

const ENTITY_NODE_TYPES = new Set(['class', 'interface', 'type', 'enum', 'model', 'entity', 'dto']);

export function hasRouteDomainContractEvidence(cas: CASOutput, route: string): boolean {
  if (route.includes(':param')) return true;
  const routeTerms = route
    .toLowerCase()
    .split('/')
    .filter(term => term && term !== 'api' && !/^v\d+$/.test(term) && term !== ':param')
    .map(normalizeDomainTerm);
  if (routeTerms.length !== 1) return true;
  const expected = routeTerms[0];
  const evidenceNames = [
    ...(cas.domain_concepts || []).map(concept => concept.name),
    ...(cas.entities || []).map(entity => entity.name),
    ...(cas.database_schema?.entities || []).map(entity => entity.name),
  ];
  return evidenceNames.some(name =>
    String(name)
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean)
      .map(normalizeDomainTerm)
      .includes(expected)
  );
}

function normalizeDomainTerm(value: string): string {
  if (/ies$/.test(value)) return `${value.slice(0, -3)}y`;
  if (/(?:ches|shes|xes|zes)$/.test(value)) return value.slice(0, -2);
  if (/s$/.test(value) && !/ss$/.test(value)) return value.slice(0, -1);
  return value;
}

export interface EntityContractEvidence {
  name: string;
  nodeIds: string[];
  fields: Map<string, string>;
}

export function entityVocabulary(cas: CASOutput): EntityContractEvidence[] {
  const names = new Map<string, string>();
  const fieldsByName = new Map<string, Map<string, string>>();
  for (const entity of cas.entities || []) {
    const key = entity.name.toLowerCase();
    names.set(key, entity.name);
    fieldsByName.set(key, entityFields(entity.fields || []));
  }
  for (const entity of cas.database_schema?.entities || []) {
    const key = entity.name.toLowerCase();
    if (!names.has(key)) names.set(key, entity.name);
    const fields = fieldsByName.get(key) || new Map<string, string>();
    for (const field of entity.fields || []) fields.set(normalizeEntityFieldName(field.name), normalizeEntityFieldType(field.type));
    fieldsByName.set(key, fields);
  }

  return [...names.entries()]
    .map(([key, name]) => ({
      name,
      nodeIds: cas.nodes
        .filter(node => ENTITY_NODE_TYPES.has(node.type) && node.name.toLowerCase() === key)
        .map(node => node.id)
        .slice(0, 5),
      fields: fieldsByName.get(key) || new Map<string, string>(),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function entityShapesCompatible(left: EntityContractEvidence, right: EntityContractEvidence): boolean {
  if (left.fields.size < 2 || right.fields.size < 2) return false;
  const sharedFields = [...left.fields.keys()].filter(field => right.fields.has(field));
  if (sharedFields.length < 2) return false;
  const coverage = sharedFields.length / Math.min(left.fields.size, right.fields.size);
  if (coverage < 0.75) return false;
  const compatibleTypes = sharedFields.filter(field => left.fields.get(field) === right.fields.get(field));
  return compatibleTypes.length / sharedFields.length >= 0.75;
}

export function entityTypeNodes(cas: CASOutput, name: string): CASNode[] {
  const key = name.toLowerCase();
  return cas.nodes
    .filter(node => ENTITY_NODE_TYPES.has(node.type) && node.name.toLowerCase() === key && !isNonRuntimeSourceFile(node.source?.file?.toLowerCase() || ''))
    .slice(0, 5);
}

export function isNonRuntimeSourceFile(file: string): boolean {
  if (!file) return false;
  return file.includes('/fixtures/') ||
    file.includes('/__tests__/') ||
    file.includes('/tests/') ||
    file.includes('/test/') ||
    file.endsWith('.spec.ts') ||
    file.endsWith('.test.ts') ||
    file.endsWith('.spec.js') ||
    file.endsWith('.test.js') ||
    file.endsWith('.spec.tsx') ||
    file.endsWith('.test.tsx');
}

function entityFields(fields: Array<{ name: string; type: string }>): Map<string, string> {
  return new Map(fields.map(field => [normalizeEntityFieldName(field.name), normalizeEntityFieldType(field.type)]));
}

function normalizeEntityFieldName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function normalizeEntityFieldType(value: string): string {
  return value.toLowerCase().replace(/[?\[\]|<>]/g, '').replace(/[^a-z0-9]+/g, '');
}
