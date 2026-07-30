import { useMemo } from 'react';
import { useProjectCas } from './useProjectCas';
import { resolveSlug } from '@/shared/lib/slugs';

export type DataEntityKind =
  | 'persisted-entity'
  | 'api-response'
  | 'request-dto'
  | 'domain-shape'
  | 'value-object';

export interface DataEntityField {
  name: string;
  type: string;
  is_sensitive: boolean;
  validation?: string[];
}

export interface DataEntityLifecycle {
  created_by: string[];
  read_by: string[];
  updated_by: string[];
  deleted_by: string[];
}

export interface DataEntity {
  id: string;
  name: string;
  schema_source?: string;
  description?: string;
  description_source?: 'deterministic' | 'ai' | 'manual' | 'reused';
  kind?: DataEntityKind;
  kind_source?: 'framework-evidence' | 'shape-inference';
  /** Citation for `kind` — mandatory when the kind is evidence-sourced. */
  kind_evidence?: string;
  fields?: DataEntityField[];
  lifecycle: DataEntityLifecycle;
  transformations?: Array<{ from_node: string; to_node: string; transformation_type: string }>;
  invariants?: Array<{ description: string; enforced_by: string[]; source: string }>;
}

export interface DatabaseField {
  name: string;
  type: string;
  primary?: boolean;
  unique?: boolean;
  nullable?: boolean;
  default?: string;
  column?: string;
}

export type DatabaseRelationshipType = 'OneToOne' | 'OneToMany' | 'ManyToOne' | 'ManyToMany';

export interface DatabaseRelationship {
  type: DatabaseRelationshipType;
  target: string;
  field: string;
  inverse_field?: string;
  join_table?: string;
}

export interface DatabaseEntity {
  name: string;
  table?: string;
  source_file?: string;
  fields: DatabaseField[];
  relationships: DatabaseRelationship[];
}

export interface DatabaseSchema {
  orm?: string;
  entities: DatabaseEntity[];
  relationships_summary: string[];
}

export function useDataEntities(projectId: string | undefined) {
  const casQuery = useProjectCas(projectId);

  const entities = useMemo<DataEntity[]>(() => {
    const cas = casQuery.data?.status === 'ready' ? casQuery.data.cas : undefined;
    return (cas as { data_entities?: DataEntity[] } | undefined)?.data_entities ?? [];
  }, [casQuery.data]);

  const databaseSchema = useMemo<DatabaseSchema | undefined>(() => {
    const cas = casQuery.data?.status === 'ready' ? casQuery.data.cas : undefined;
    return (cas as { database_schema?: DatabaseSchema } | undefined)?.database_schema;
  }, [casQuery.data]);

  const databaseEntityByNameLower = useMemo(() => {
    const map = new Map<string, DatabaseEntity>();
    for (const entity of databaseSchema?.entities ?? []) map.set(entity.name.toLowerCase(), entity);
    return map;
  }, [databaseSchema]);

  return { ...casQuery, entities, databaseSchema, databaseEntityByNameLower };
}

export function useDataEntity(projectId: string | undefined, entityId: string | undefined) {
  const base = useDataEntities(projectId);
  const entity = useMemo(
    () => resolveSlug(entityId, base.entities),
    [base.entities, entityId],
  );
  const databaseEntity = useMemo(
    () => (entity ? base.databaseEntityByNameLower.get(entity.name.toLowerCase()) : undefined),
    [entity, base.databaseEntityByNameLower],
  );
  return { ...base, entity, databaseEntity };
}
