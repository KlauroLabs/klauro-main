import { describe, it, expect } from 'vitest';
import { clusterKeyFor, computeErdLayout } from '@/shared/components/entities/erdLayout';
import type { DataEntity, DatabaseEntity } from '@/shared/hooks/useEntities';

function entity(id: string, name: string, schema_source?: string, fieldCount = 2): DataEntity {
  return {
    id,
    name,
    schema_source,
    fields: Array.from({ length: fieldCount }, (_, i) => ({ name: `f${i}`, type: 'string', is_sensitive: false })),
    lifecycle: { created_by: [], read_by: [], updated_by: [], deleted_by: [] },
  };
}

describe('clusterKeyFor', () => {
  it('derives a module label from a src-relative path', () => {
    expect(clusterKeyFor('packages/analyzer-core/src/database/entities/analysis-result.entity.ts')).toBe('database/entities');
  });

  it('falls back to "other" when no source path is known', () => {
    expect(clusterKeyFor(undefined)).toBe('other');
  });
});

describe('computeErdLayout', () => {
  it('is a pure function: identical inputs produce identical positions', () => {
    const entities = [entity('a', 'A'), entity('b', 'B')];
    const first = computeErdLayout(entities, new Map());
    const second = computeErdLayout(entities, new Map());
    expect(first.nodes).toEqual(second.nodes);
  });

  it('places every entity as a node, with no relationships when database_schema has none', () => {
    const entities = [entity('a', 'A'), entity('b', 'B')];
    const layout = computeErdLayout(entities, new Map());
    expect(layout.nodes).toHaveLength(2);
    expect(layout.edges).toHaveLength(0);
  });

  it('draws an edge only when the target entity is also in view', () => {
    const entities = [entity('a', 'A'), entity('b', 'B')];
    const dbA: DatabaseEntity = { name: 'A', fields: [], relationships: [{ type: 'OneToMany', target: 'B', field: 'bs' }] };
    const byName = new Map([['a', dbA]]);
    const layout = computeErdLayout(entities, byName);
    expect(layout.edges).toHaveLength(1);
    expect(layout.edges[0]).toMatchObject({ source: 'a', target: 'b', type: 'OneToMany' });
  });

  it('drops an edge whose target is outside the current view', () => {
    const entities = [entity('a', 'A')];
    const dbA: DatabaseEntity = { name: 'A', fields: [], relationships: [{ type: 'ManyToOne', target: 'NotHere', field: 'x' }] };
    const layout = computeErdLayout(entities, new Map([['a', dbA]]));
    expect(layout.edges).toHaveLength(0);
  });

  it('clusters into columns by module once past the "large" threshold', () => {
    const many = Array.from({ length: 12 }, (_, i) => entity(`e${i}`, `E${i}`, i < 6 ? 'src/database/entities/x.ts' : 'src/auth/y.ts'));
    const layout = computeErdLayout(many, new Map());
    expect(layout.clusters.length).toBeGreaterThan(1);
  });

  it('does not cluster a small entity set', () => {
    const few = [entity('a', 'A', 'src/database/entities/a.ts'), entity('b', 'B', 'src/auth/b.ts')];
    const layout = computeErdLayout(few, new Map());
    expect(layout.clusters).toHaveLength(1);
  });
});
