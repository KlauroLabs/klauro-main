import type { CASDataEntity, CASDatabaseEntity, CASDatabaseRelationship, CASDatabaseSchema } from '../../types/cas.types';

type DataRelation = NonNullable<CASDataEntity['relations']>[number];

const SIDE_OF = {
  'N:1': { type: 'ManyToOne', inverse: '1:N' },
  '1:N': { type: 'OneToMany', inverse: 'N:1' },
  '1:1': { type: 'OneToOne', inverse: '1:1' },
  'N:M': { type: 'ManyToMany', inverse: 'N:M' },
} as const satisfies Record<string, { type: CASDatabaseRelationship['type']; inverse: string }>;

function sideOf(relation: DataRelation): (typeof SIDE_OF)[keyof typeof SIDE_OF] | undefined {
  if (relation.kind !== 'data' || relation.field === undefined) return undefined;
  return relation.cardinality === undefined ? undefined : SIDE_OF[relation.cardinality];
}

function databaseEntityOf(entity: CASDataEntity): CASDatabaseEntity {
  return {
    name: entity.name,
    source_file: entity.schema_source?.split(':')[0],
    fields: (entity.fields ?? []).map(field => ({ name: field.name, type: field.type })),
    relationships: (entity.relations ?? []).flatMap(relation => {
      const side = sideOf(relation);
      return side === undefined ? [] : [{ type: side.type, target: relation.target_name, field: relation.field as string }];
    }),
  };
}

function summaryOf(entities: CASDataEntity[]): string[] {
  const lines = new Set<string>();
  for (const entity of entities) {
    for (const relation of entity.relations ?? []) {
      if (sideOf(relation) === undefined || relation.cardinality === undefined) continue;
      lines.add(`${entity.name} ${relation.cardinality} ${relation.target_name}`);
      lines.add(`${relation.target_name} ${SIDE_OF[relation.cardinality as keyof typeof SIDE_OF].inverse} ${entity.name}`);
    }
  }
  return [...lines];
}

export function databaseSchemaOf(entities: CASDataEntity[]): CASDatabaseSchema | undefined {
  const relationships_summary = summaryOf(entities);
  if (relationships_summary.length === 0) return undefined;
  return { entities: entities.map(databaseEntityOf), relationships_summary };
}
