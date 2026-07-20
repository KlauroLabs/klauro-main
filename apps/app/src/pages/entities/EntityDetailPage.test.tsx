import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '../../test/renderWithProviders';
import { EntityDetailPage } from './EntityDetailPage';
import * as hooks from '../../hooks/useEntities';
import type { DataEntity, DatabaseEntity } from '../../hooks/useEntities';

const widget: DataEntity = {
  id: 'entity_widget',
  name: 'Widget',
  schema_source: 'src/database/entities/widget.entity.ts',
  description: 'A thing customers order.',
  kind: 'persisted-entity',
  fields: [{ name: 'id', type: 'string', is_sensitive: false }],
  lifecycle: { created_by: ['method_class_x_ts_WidgetService_0_create_10'], read_by: [], updated_by: [], deleted_by: [] },
};

const widgetSchema: DatabaseEntity = {
  name: 'Widget',
  fields: [{ name: 'id', type: 'string', primary: true }],
  relationships: [],
};

function mockQuery(overrides: Partial<ReturnType<typeof hooks.useDataEntity>>) {
  vi.spyOn(hooks, 'useDataEntity').mockReturnValue({
    isLoading: false,
    isError: false,
    entities: [widget],
    entity: undefined,
    databaseEntity: undefined,
    databaseSchema: undefined,
    databaseEntityByNameLower: new Map(),
    ...overrides,
  } as ReturnType<typeof hooks.useDataEntity>);
}

const routeProps = { route: '/codebases/p1/entities/entity_widget', path: '/codebases/:projectId/entities/:entityId' };

describe('EntityDetailPage', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('renders a loading state', () => {
    mockQuery({ isLoading: true });
    renderWithProviders(<EntityDetailPage />, routeProps);
    expect(screen.getByText(/Loading entity/i)).toBeInTheDocument();
  });

  it('renders an honest not-found state when the entity id has no match', () => {
    mockQuery({ entity: undefined });
    renderWithProviders(<EntityDetailPage />, routeProps);
    expect(screen.getByText(/Entity not found/i)).toBeInTheDocument();
  });

  it('renders fields, description, and lineage for a found entity', () => {
    mockQuery({ entity: widget, databaseEntity: widgetSchema });
    renderWithProviders(<EntityDetailPage />, routeProps);
    expect(screen.getByRole('heading', { name: 'Widget' })).toBeInTheDocument();
    expect(screen.getByText('A thing customers order.')).toBeInTheDocument();
    expect(screen.getByText('id')).toBeInTheDocument();
    expect(screen.getByText(/No ORM relations found/i)).toBeInTheDocument();
  });
});
