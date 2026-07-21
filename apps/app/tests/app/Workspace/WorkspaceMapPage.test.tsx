import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '../../utils/renderWithProviders';
import { WorkspaceMapPage } from '@/app/Workspace/WorkspaceMapPage';
import * as workspaceAnalysisHooks from '@/shared/hooks/useWorkspaceAnalysis';
import type { WorkspaceAnalysisResponse } from '@/shared/api/index';

const routeProps = { route: '/workspaces/ws1/map', path: '/workspaces/:workspaceId/map' };

function mockAnalysis(overrides: Partial<ReturnType<typeof workspaceAnalysisHooks.useWorkspaceAnalysis>>) {
  vi.spyOn(workspaceAnalysisHooks, 'useWorkspaceAnalysis').mockReturnValue({
    isLoading: false,
    isError: false,
    data: undefined,
    refetch: vi.fn(),
    ...overrides,
  } as ReturnType<typeof workspaceAnalysisHooks.useWorkspaceAnalysis>);
}

const readyResponse: WorkspaceAnalysisResponse = {
  status: 'ready',
  workspace_id: 'ws1',
  analysis: {
    codebases: [
      { id: 'cb-a', primary_domain: 'fintech' },
      { id: 'cb-b', primary_domain: 'infra' },
    ],
    applications: [
      { id: 'app-a', codebase_id: 'cb-a', name: 'API', kind: 'service' },
      { id: 'app-b', codebase_id: 'cb-b', name: 'Worker', kind: 'worker' },
    ],
    runtime_components: [
      { id: 'rc-a', codebase_id: 'cb-a', application_id: 'app-a', name: 'API' },
      { id: 'rc-b', codebase_id: 'cb-b', application_id: 'app-b', name: 'Worker' },
    ],
    runtime_links: [
      { id: 'l1', codebase_id: 'cb-a', source_component_id: 'rc-a', target_component_id: 'rc-b', kind: 'queue', evidence: ['publish'] },
    ],
  },
};

describe('WorkspaceMapPage', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('renders a loading state', () => {
    mockAnalysis({ isLoading: true });
    renderWithProviders(<WorkspaceMapPage />, routeProps);
    expect(screen.getByText(/Loading the system map/i)).toBeInTheDocument();
  });

  it('renders an error state', () => {
    mockAnalysis({ isError: true });
    renderWithProviders(<WorkspaceMapPage />, routeProps);
    expect(screen.getByText(/Could not load this workspace's system map/i)).toBeInTheDocument();
  });

  it('renders an empty state when there is no analysis', () => {
    mockAnalysis({ data: { status: 'none', workspace_id: 'ws1' } });
    renderWithProviders(<WorkspaceMapPage />, routeProps);
    expect(screen.getByText(/No analysis yet/i)).toBeInTheDocument();
  });

  it('renders an empty state when the analysis has no applications', () => {
    mockAnalysis({ data: { status: 'ready', workspace_id: 'ws1', analysis: {} } });
    renderWithProviders(<WorkspaceMapPage />, routeProps);
    expect(screen.getByText(/No applications detected/i)).toBeInTheDocument();
  });

  it('renders the diagram, perspective switcher, and relationship count when data is present', () => {
    mockAnalysis({ data: readyResponse });
    renderWithProviders(<WorkspaceMapPage />, routeProps);
    expect(screen.getByRole('img', { name: 'Workspace system map' })).toBeInTheDocument();
    expect(screen.getByText(/2 applications/)).toBeInTheDocument();
    expect(screen.getByText(/1 relationship/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Domain' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Exposure' })).toBeInTheDocument();
  });
});
