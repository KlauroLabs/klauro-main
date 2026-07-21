import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '../../utils/renderWithProviders';
import { DeployableDetailPage } from '@/app/Deployable/DeployableDetailPage';
import * as hooks from '@/shared/hooks/useDasUnits';
import { encodeSlug } from '@/shared/lib/slugs';
import type { RemoteDasUnit } from '@/shared/hooks/useDasUnits';

const unitA: RemoteDasUnit = {
  id: 'das:container:services-api:api',
  name: 'api',
  root_path: 'services/api',
  member_root_paths: [],
  tier: 1,
  kind: 'container',
  boundary_evidence: ['services/api/Dockerfile'],
  node_count: 12,
  entry_point_count: 3,
  exit_point_count: 1,
};
const unitB: RemoteDasUnit = {
  id: 'das:container:services-worker:worker',
  name: 'worker',
  root_path: 'services/worker',
  member_root_paths: [],
  tier: 1,
  kind: 'container',
  boundary_evidence: [],
  node_count: 5,
  entry_point_count: 0,
  exit_point_count: 0,
};

function mockIndex(overrides: Partial<ReturnType<typeof hooks.useDasUnitIndex>>) {
  vi.spyOn(hooks, 'useDasUnitIndex').mockReturnValue({
    isLoading: false,
    isError: false,
    promoted: false,
    units: [],
    orphanNodeCount: 0,
    orphanNodeIds: [],
    ...overrides,
  } as ReturnType<typeof hooks.useDasUnitIndex>);
}

function mockSlice(overrides: Partial<ReturnType<typeof hooks.useDasUnitSlice>>) {
  vi.spyOn(hooks, 'useDasUnitSlice').mockReturnValue({
    isLoading: false,
    isError: false,
    entryPoints: [],
    capabilities: [],
    files: [],
    entities: [],
    shipEvidence: undefined,
    ...overrides,
  } as ReturnType<typeof hooks.useDasUnitSlice>);
}

const routeProps = {
  route: `/codebases/p1/deployables/${encodeSlug(unitA)}`,
  path: '/codebases/:projectId/deployables/:dasUnitId',
};

describe('DeployableDetailPage', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('renders a loading state', () => {
    mockIndex({ isLoading: true });
    mockSlice({ isLoading: true });
    renderWithProviders(<DeployableDetailPage />, routeProps);
    expect(screen.getByText(/Loading deployable analysis/i)).toBeInTheDocument();
  });

  it('renders an error state', () => {
    mockIndex({ isError: true });
    mockSlice({ isError: true });
    renderWithProviders(<DeployableDetailPage />, routeProps);
    expect(screen.getByText(/Could not load this codebase/i)).toBeInTheDocument();
  });

  it('renders the not-promoted explanation when fewer than 2 units qualify', () => {
    mockIndex({ promoted: false, units: [] });
    mockSlice({});
    renderWithProviders(<DeployableDetailPage />, routeProps);
    expect(screen.getByText(/hasn't promoted/i)).toBeInTheDocument();
  });

  it('resolves the unit slug and renders the unit overview, ship evidence, and section stack', () => {
    mockIndex({ promoted: true, units: [unitA, unitB], orphanNodeCount: 2 });
    mockSlice({
      entryPoints: [],
      capabilities: [],
      files: ['services/api/handler.ts'],
      entities: [],
      shipEvidence: { ports: [8080] },
    });
    renderWithProviders(<DeployableDetailPage />, routeProps);
    expect(screen.getByRole('heading', { name: 'api' })).toBeInTheDocument();
    expect(screen.getByText('services/api/Dockerfile')).toBeInTheDocument();
    expect(screen.getByText(/Orphan node count: 2/i)).toBeInTheDocument();
    expect(screen.getByText('8080')).toBeInTheDocument();
  });

  it('reports zero orphans honestly rather than omitting the notice', () => {
    mockIndex({ promoted: true, units: [unitA, unitB], orphanNodeCount: 0 });
    mockSlice({});
    renderWithProviders(<DeployableDetailPage />, routeProps);
    expect(screen.getByText(/Orphan node count: 0/i)).toBeInTheDocument();
  });

  it('hides the picker when only one unit exists', () => {
    mockIndex({ promoted: true, units: [unitA], orphanNodeCount: 0 });
    mockSlice({});
    renderWithProviders(<DeployableDetailPage />, routeProps);
    expect(screen.queryByLabelText('Deployable unit')).not.toBeInTheDocument();
  });
});
