import { useMemo } from 'react';
import { useProjectCas } from './useProjectCas';
import { resolveSlug } from '../lib/slugs';

/**
 * Local mirror of CASDataEntity / CASDatabaseSchema
 * (packages/analyzer-core/src/types/cas.types.ts) — apps/app does not depend
 * on the analyzer-core package (see api.ts's own mirrored-interface
 * convention), so only the fields this lane consumes are redeclared here.
 *
 * Two CAS sections are combined, deliberately NOT re-derived:
 *  - `data_entities[]` — the domain view: fields (with sensitivity),
 *    lifecycle (who creates/reads/updates/deletes), and `kind` (the
 *    structural evidence for ORM/DTO/API-response/value-object — see
 *    EvidenceKindBadge).
 *  - `database_schema.entities[]` — the ORM view: PK/FK/nullable/unique
 *    field flags and evidence-gated relationships (OneToOne/OneToMany/
 *    ManyToOne/ManyToMany), the same shape get_erd reshapes server-side.
 * They are joined by name (case-insensitive) client-side; an entity absent
 * from database_schema has zero relationships — a real, common case
 * (relationship sparsity), not a loading gap. See docs/briefs/entities.md.
 */
export type DataEntityKind = 'persisted-entity' | 'api-response' | 'request-dto' | 'value-object';

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
  kind_source?: 'framework-evidence';
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

/**
 * Reads data_entities + database_schema out of the full CAS payload
 * (`useProjectCas`, an ui-scaffold-lane hook) — in-flight reuse per
 * LANE-COMMON.md's fabric protocol, following the same convention the
 * entry-points lane established for reading `cas.entry_points`.
 */
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

/** One entity plus its joined database_schema counterpart (if any).
 *  `entityId` is a `name~suffix` slug (src/lib/slugs.ts) or a legacy raw id —
 *  resolved against this codebase's own entity list, same pattern as
 *  useFlow.ts/useEntryPoint. EntityDetailPage redirects to the canonical
 *  slug once this resolves. */
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
