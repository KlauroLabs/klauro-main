import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '../../utils/renderWithProviders';
import { EntryPointsPage } from '@/app/EntryPoints/EntryPointsPage';
import * as hooks from '@/shared/hooks/useEntryPoints';
import type { EntryPoint } from '@/shared/hooks/useEntryPoints';

const sample: EntryPoint[] = [
  {
    id: 'a',
    source_node: 'na',
    type: 'http',
    name: 'createWidget',
    description: 'Creates a widget.',
    trigger: { method: 'post', path: '/v1/widgets' },
    security: { authenticated: true },
  },
];

function mockQuery(overrides: Partial<ReturnType<typeof hooks.useEntryPointsForDeployable>>) {
  vi.spyOn(hooks, 'useEntryPointsForDeployable').mockReturnValue({
    isLoading: false,
    isError: false,
    allEntryPoints: [],
    deployables: [],
    entryPoints: [],
    familyCounts: [],
    ...overrides,
  } as ReturnType<typeof hooks.useEntryPointsForDeployable>);
}

const routeProps = { route: '/codebases/p1/entry-points', path: '/codebases/:projectId/entry-points' };

describe('EntryPointsPage', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('renders a loading state', () => {
    mockQuery({ isLoading: true });
    renderWithProviders(<EntryPointsPage />, routeProps);
    expect(screen.getByText(/Loading entry points/i)).toBeInTheDocument();
  });

  it('renders an error state', () => {
    mockQuery({ isError: true });
    renderWithProviders(<EntryPointsPage />, routeProps);
    expect(screen.getByText(/Could not load entry points/i)).toBeInTheDocument();
  });

  it('renders an empty state when the deployable truly has no entry points', () => {
    mockQuery({ allEntryPoints: [], entryPoints: [] });
    renderWithProviders(<EntryPointsPage />, routeProps);
    expect(screen.getByText(/No entry points found/i)).toBeInTheDocument();
  });

  it('renders the family mix and table when data is present', () => {
    mockQuery({
      allEntryPoints: sample,
      entryPoints: sample,
      deployables: [{ id: 'api', name: 'API server' }],
      familyCounts: [{ family: 'request-wait', count: 1, kinds: [{ kind: 'http', count: 1 }] }],
    });
    renderWithProviders(<EntryPointsPage />, routeProps);
    expect(screen.getByText('createWidget')).toBeInTheDocument();
    expect(screen.getByText('POST /v1/widgets')).toBeInTheDocument();
    expect(screen.getByText('Request & wait')).toBeInTheDocument();
  });
});
