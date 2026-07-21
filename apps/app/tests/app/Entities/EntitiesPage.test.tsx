import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { renderWithProviders } from '../../utils/renderWithProviders';
import { EntitiesPage } from '@/app/Entities/EntitiesPage';
import * as hooks from '@/shared/hooks/useEntities';
import type { DataEntity } from '@/shared/hooks/useEntities';

const sample: DataEntity[] = [
  {
    id: 'entity_widget',
    name: 'Widget',
    schema_source: 'src/database/entities/widget.entity.ts',
    kind: 'persisted-entity',
    kind_source: 'framework-evidence',
    fields: [{ name: 'id', type: 'string', is_sensitive: false }, { name: 'ownerEmail', type: 'string', is_sensitive: true }],
    lifecycle: { created_by: ['fn1'], read_by: ['fn2', 'fn3'], updated_by: [], deleted_by: [] },
  },
];

function mockQuery(overrides: Partial<ReturnType<typeof hooks.useDataEntities>>) {
  vi.spyOn(hooks, 'useDataEntities').mockReturnValue({
    isLoading: false,
    isError: false,
    entities: [],
    databaseSchema: undefined,
    databaseEntityByNameLower: new Map(),
    ...overrides,
  } as ReturnType<typeof hooks.useDataEntities>);
}

const routeProps = { route: '/codebases/p1/entities', path: '/codebases/:projectId/entities' };

describe('EntitiesPage', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('renders a loading state', () => {
    mockQuery({ isLoading: true });
    renderWithProviders(<EntitiesPage />, routeProps);
    expect(screen.getByText(/Loading entities/i)).toBeInTheDocument();
  });

  it('renders an error state', () => {
    mockQuery({ isError: true });
    renderWithProviders(<EntitiesPage />, routeProps);
    expect(screen.getByText(/Could not load entities/i)).toBeInTheDocument();
  });

  it('renders an honest empty state when there are truly no entities (e.g. no database)', () => {
    mockQuery({ entities: [] });
    renderWithProviders(<EntitiesPage />, routeProps);
    expect(screen.getByText(/No data entities found/i)).toBeInTheDocument();
  });

  it('renders the table with entities when data is present', () => {
    mockQuery({ entities: sample });
    renderWithProviders(<EntitiesPage />, routeProps);
    expect(screen.getByText('Widget')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument(); // field count
    expect(screen.getByText('ORM')).toBeInTheDocument(); // evidence kind badge
  });

  it('filters by search term', () => {
    mockQuery({ entities: sample });
    renderWithProviders(<EntitiesPage />, routeProps);
    const input = screen.getByPlaceholderText(/Search by name/i);
    fireEvent.change(input, { target: { value: 'nomatch' } });
    expect(screen.getByText(/No entities match/i)).toBeInTheDocument();
  });
});
