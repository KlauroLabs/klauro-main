import type {
  CASDatabaseEntity,
  CASDatabaseField,
  CASDatabaseRelationship,
} from '../../types/cas.types';

export interface DatabaseEntityEvidence {
  entity: CASDatabaseEntity;
  sourceKind: 'model' | 'ddl';
}

interface EntityGroup {
  evidence: DatabaseEntityEvidence[];
  firstPosition: number;
}

function normalized(value: string | undefined): string {
  return (value || '').trim().toLowerCase();
}

function entityIdentity(evidence: DatabaseEntityEvidence): string {
  const table = normalized(evidence.entity.table);
  if (table) return `table:${table}`;
  return `source:${normalized(evidence.entity.name)}:${normalized(evidence.entity.source_file)}`;
}

function mergeFields(evidence: DatabaseEntityEvidence[]): CASDatabaseField[] {
  const byName = new Map<string, CASDatabaseField[]>();
  const logicalNamesByColumn = new Map<string, string>();
  for (const item of evidence) {
    if (item.sourceKind !== 'model') continue;
    for (const field of item.entity.fields) {
      if (field.column) logicalNamesByColumn.set(normalized(field.column), normalized(field.name));
    }
  }
  for (const item of evidence) {
    for (const field of item.entity.fields) {
      const key = logicalNamesByColumn.get(normalized(field.name)) || normalized(field.name);
      if (!key) continue;
      const fields = byName.get(key) || [];
      fields.push(field);
      byName.set(key, fields);
    }
  }

  return [...byName.values()].map(fields => {
    const preferred = fields.find(field => normalized(field.type) !== 'unknown') || fields[0];
    const typeVariants = [...new Set(fields
      .map(field => field.type?.trim())
      .filter((type): type is string => Boolean(type) && normalized(type) !== 'unknown'))];
    const nullableValues = fields.map(field => field.nullable).filter(value => value !== undefined);
    const nullable = nullableValues.includes(false)
      ? false
      : nullableValues.includes(true)
        ? true
        : undefined;
    const defaultField = fields.find(field => field.default !== undefined);
    const columnField = fields.find(field => field.column);
    return {
      name: preferred.name,
      type: preferred.type || 'unknown',
      ...(fields.some(field => field.primary) ? { primary: true } : {}),
      ...(fields.some(field => field.unique) ? { unique: true } : {}),
      ...(nullable !== undefined ? { nullable } : {}),
      ...(defaultField ? { default: defaultField.default } : {}),
      ...(columnField ? { column: columnField.column } : {}),
      ...(typeVariants.length > 1 ? { type_variants: typeVariants } : {}),
    };
  });
}

function mergeRelationships(evidence: DatabaseEntityEvidence[]): CASDatabaseRelationship[] {
  const relationships = new Map<string, CASDatabaseRelationship>();
  for (const item of evidence) {
    for (const relationship of item.entity.relationships) {
      const key = [relationship.type, relationship.target, relationship.field]
        .map(normalized)
        .join(':');
      if (!relationships.has(key)) relationships.set(key, relationship);
    }
  }
  return [...relationships.values()];
}

function mergeGroup(group: EntityGroup): CASDatabaseEntity {
  const model = group.evidence.find(item => item.sourceKind === 'model');
  const first = model || group.evidence[0];
  const sourceFiles = [...new Set(group.evidence
    .map(item => item.entity.source_file)
    .filter((file): file is string => Boolean(file)))];
  const table = group.evidence.find(item => item.entity.table)?.entity.table;
  return {
    name: first.entity.name,
    ...(table ? { table } : {}),
    ...(first.entity.source_file ? { source_file: first.entity.source_file } : {}),
    ...(sourceFiles.length > 1 ? { source_files: sourceFiles } : {}),
    fields: mergeFields(group.evidence),
    relationships: mergeRelationships(group.evidence),
  };
}

export function normalizeDatabaseEntities(input: DatabaseEntityEvidence[]): CASDatabaseEntity[] {
  const groupsByIdentity = new Map<string, EntityGroup>();
  input.forEach((evidence, position) => {
    const key = entityIdentity(evidence);
    const group = groupsByIdentity.get(key);
    if (group) group.evidence.push(evidence);
    else groupsByIdentity.set(key, { evidence: [evidence], firstPosition: position });
  });

  const groups = [...groupsByIdentity.values()];
  const byName = new Map<string, EntityGroup[]>();
  for (const group of groups) {
    const key = normalized(group.evidence[0].entity.name);
    const named = byName.get(key) || [];
    named.push(group);
    byName.set(key, named);
  }

  const removed = new Set<EntityGroup>();
  for (const named of byName.values()) {
    const modelGroups = named.filter(group => group.evidence.some(item => item.sourceKind === 'model'));
    const ddlGroups = named.filter(group => group.evidence.every(item => item.sourceKind === 'ddl'));
    if (modelGroups.length !== 1 || ddlGroups.length !== 1) continue;
    modelGroups[0].evidence.push(...ddlGroups[0].evidence);
    modelGroups[0].firstPosition = Math.min(modelGroups[0].firstPosition, ddlGroups[0].firstPosition);
    removed.add(ddlGroups[0]);
  }

  return groups
    .filter(group => !removed.has(group))
    .sort((left, right) => left.firstPosition - right.firstPosition)
    .map(mergeGroup);
}

export function databaseFieldsFromAttributes(attributes: Record<string, unknown>): CASDatabaseField[] {
  const rawFields = [attributes.fields, attributes.columns]
    .filter(Array.isArray)
    .flat() as Array<Record<string, unknown>>;
  return rawFields
    .filter(field => typeof field.name === 'string' && field.name.trim())
    .map(field => ({
      name: String(field.name),
      type: typeof field.type === 'string' && field.type.trim() ? field.type.trim() : 'unknown',
      ...(field.primary === true || field.primary_key === true ? { primary: true } : {}),
      ...(field.unique === true ? { unique: true } : {}),
      ...(typeof field.nullable === 'boolean' ? { nullable: field.nullable } : {}),
      ...(field.default !== undefined ? { default: String(field.default) } : {}),
      ...(typeof field.column === 'string' ? { column: field.column } : {}),
    }));
}
