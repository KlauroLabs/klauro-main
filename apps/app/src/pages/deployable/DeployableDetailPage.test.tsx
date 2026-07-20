import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '../../test/renderWithProviders';
import { DeployableDetailPage } from './DeployableDetailPage';
import * as hooks from '../../hooks/useDasUnits';
import type { DasUnitSummary } from './dasIndex';

const unitA: DasUnitSummary = {
  id: 'das:container:services-api:api',
  name: 'api',
  root_path: 'services/api',
  member_root_paths: [],
  tier: 1,
  kind: 'container',
  boundary_evidence: ['services/api/Dockerfile'],
  member_deployable_ids: ['dep:container:services-api:api'],
};
const unitB: DasUnitSummary = {
  id: 'das:container:services-worker:worker',
  name: 'worker',
  root_path: 'services/worker',
  member_root_paths: [],
  tier: 1,
  kind: 'container',
  boundary_evidence: [],
  member_deployable_ids: ['dep:container:services-worker:worker'],
};

function mockIndex(overrides: Partial<ReturnType<typeof hooks.useDasIndex>>) {
  vi.spyOn(hooks, 'useDasIndex').mockReturnValue({
    isLoading: false,
    isError: false,
    promoted: false,
    units: [],
    evidence: [],
    nodes: [],
    dataEntities: [],
    ...overrides,
  } as ReturnType<typeof hooks.useDasIndex>);
}

function mockSlice(overrides: Partial<ReturnType<typeof hooks.useDasUnitSlice>>) {
  vi.spyOn(hooks, 'useDasUnitSlice').mockReturnValue({
    isLoading: false,
    isError: false,
    promoted: false,
    units: [],
    evidence: [],
    nodes: [],
    dataEntities: [],
    entryPoints: [],
    capabilities: [],
    files: [],
    entities: [],
    ...overrides,
  } as ReturnType<typeof hooks.useDasUnitSlice>);
}

const routeProps = {
  route: `/codebases/p1/deployables/${unitA.id}`,
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
    mockSlice({ promoted: false, units: [] });
    renderWithProviders(<DeployableDetailPage />, routeProps);
    expect(screen.getByText(/hasn't promoted/i)).toBeInTheDocument();
  });

  it('renders the unit overview, ship evidence, and section stack for a promoted unit', () => {
    mockIndex({ promoted: true, units: [unitA, unitB] });
    mockSlice({
      promoted: true,
      units: [unitA, unitB],
      entryPoints: [],
      capabilities: [],
      files: ['services/api/handler.ts'],
      entities: [],
    });
    renderWithProviders(<DeployableDetailPage />, routeProps);
    expect(screen.getByRole('heading', { name: 'api' })).toBeInTheDocument();
    expect(screen.getByText('services/api/Dockerfile')).toBeInTheDocument();
    expect(screen.getByText(/Orphan node count/i)).toBeInTheDocument();
  });

  it('hides the picker when only one unit exists', () => {
    mockIndex({ promoted: true, units: [unitA] });
    mockSlice({ promoted: true, units: [unitA] });
    renderWithProviders(<DeployableDetailPage />, routeProps);
    expect(screen.queryByLabelText('Deployable unit')).not.toBeInTheDocument();
  });
});
