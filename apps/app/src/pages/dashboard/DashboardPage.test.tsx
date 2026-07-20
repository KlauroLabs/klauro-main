import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '../../test/renderWithProviders';
import { DashboardPage } from './DashboardPage';
import * as workspacesHooks from '../../hooks/useWorkspaces';
import * as workspaceAnalysisHooks from '../../hooks/useWorkspaceAnalysis';
import * as authHooks from '../../auth/AuthProvider';
import type { AppStateData } from '../../api';

function mockWorkspaces(overrides: Partial<ReturnType<typeof workspacesHooks.useWorkspaces>>) {
  vi.spyOn(workspacesHooks, 'useWorkspaces').mockReturnValue({
    isLoading: false,
    isError: false,
    data: undefined,
    ...overrides,
  } as ReturnType<typeof workspacesHooks.useWorkspaces>);
}

const emptyAppData: AppStateData = {
  user: { id: 'u1', email: 'claudia@example.com' },
  workspaces: [],
  projectsByWorkspace: {},
  membersByWorkspace: {},
  revisionsByProject: {},
};

const sampleAppData: AppStateData = {
  user: { id: 'u1', email: 'claudia@example.com', name: 'Claudia Rivera' },
  workspaces: [
    { id: 'ws1', name: 'Soon', role: 'owner', project_count: 4, user_count: 5 },
  ],
  projectsByWorkspace: {
    ws1: [{ id: 'p1', workspace_id: 'ws1', name: 'Settlement' }],
  },
  membersByWorkspace: { ws1: [] },
  revisionsByProject: {
    p1: [
      {
        analysis_id: 'a1',
        analysis_revision: 1,
        source: 'cli',
        generated_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
        files: 10,
        bytes: 1000,
        nodes: 100,
        edges: 50,
      },
    ],
  },
};

describe('DashboardPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(authHooks, 'useAuth').mockReturnValue({
      token: 'tok',
      user: sampleAppData.user,
      loading: false,
      signOut: vi.fn(),
      signInWithPassword: vi.fn(),
      registerWithPassword: vi.fn(),
    } as ReturnType<typeof authHooks.useAuth>);
    vi.spyOn(workspaceAnalysisHooks, 'useWorkspaceAnalysis').mockReturnValue({
      isLoading: false,
      isError: false,
      data: undefined,
    } as ReturnType<typeof workspaceAnalysisHooks.useWorkspaceAnalysis>);
  });

  it('renders a loading state', () => {
    mockWorkspaces({ isLoading: true });
    renderWithProviders(<DashboardPage />);
    expect(screen.getByText(/Loading your workspaces/i)).toBeInTheDocument();
  });

  it('renders an error state', () => {
    mockWorkspaces({ isError: true });
    renderWithProviders(<DashboardPage />);
    expect(screen.getByText(/Could not load your workspaces/i)).toBeInTheDocument();
  });

  it('renders an empty state when the account has no workspaces', () => {
    mockWorkspaces({ data: emptyAppData });
    renderWithProviders(<DashboardPage />);
    expect(screen.getByText(/No workspaces yet/i)).toBeInTheDocument();
  });

  it('renders workspace cards, jump-back-in, and the search entry when data is present', () => {
    mockWorkspaces({ data: sampleAppData });
    renderWithProviders(<DashboardPage />);
    expect(screen.getByText(/Good (morning|afternoon|evening) Claudia/)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Search workspace, repositories, entities/i)).toBeInTheDocument();
    expect(screen.getAllByText('Soon').length).toBeGreaterThan(0);
    expect(screen.getByText('Settlement')).toBeInTheDocument();
    expect(screen.getByText('Jump Back In')).toBeInTheDocument();
    expect(screen.getByText('Change Activity')).toBeInTheDocument();
  });
});
