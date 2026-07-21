import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '../../test/renderWithProviders';
import { WorkspacePage } from './WorkspacePage';
import * as workspaceAnalysisHooks from '../../hooks/useWorkspaceAnalysis';
import * as workspacesHooks from '../../hooks/useWorkspaces';
import * as authHooks from '../../auth/AuthProvider';
import type { WorkspaceAnalysisResponse, AppStateData } from '../../api';

function mockAnalysis(overrides: Partial<ReturnType<typeof workspaceAnalysisHooks.useWorkspaceAnalysis>>) {
  vi.spyOn(workspaceAnalysisHooks, 'useWorkspaceAnalysis').mockReturnValue({
    isLoading: false,
    isError: false,
    data: undefined,
    refetch: vi.fn(),
    ...overrides,
  } as ReturnType<typeof workspaceAnalysisHooks.useWorkspaceAnalysis>);
}

const emptyAppData: AppStateData = {
  user: { id: 'u1', email: 'claudia@example.com' },
  workspaces: [],
  projectsByWorkspace: {},
  membersByWorkspace: {},
  revisionsByProject: {},
};

// Envelope regression fixture: the graph fields (codebases, runtime_links,
// summary…) live under `analysis`, never at the response root — this is the
// exact shape LANE-COMMON.md's CRITICAL ENVELOPE RULE warns about.
const readyResponse: WorkspaceAnalysisResponse = {
  status: 'ready',
  workspace_id: 'ws1',
  workspace_name: 'Soon',
  generated_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
  member_project_ids: ['p1', 'p2'],
  member_project_names: ['Backend', 'Frontend'],
  enrichment: { status: 'ai' },
  analysis: {
    workspace_narrative: { title: 'Soon', description: 'Fintech backend and web app.' },
    codebases: [
      { id: 'cb1', name: 'Backend', path: 'account-project:p1', languages: ['TypeScript'], frameworks: ['NestJS'] },
      { id: 'cb2', name: 'Frontend', path: 'account-project:p2', languages: ['TypeScript'], frameworks: ['React'] },
    ],
    applications: [
      { id: 'app1', codebase_id: 'cb1', name: 'api', kind: 'service', deployable: true },
      // A cross-member duplicate that must never be treated as a standalone
      // repository/application in any list this page renders.
      { id: 'app2', codebase_id: 'cb2', name: 'api', kind: 'service', merged_into: 'app1' },
    ],
    runtime_components: [
      { id: 'rc1', codebase_id: 'cb1', application_id: 'app1', name: 'API Gateway' },
      { id: 'rc2', codebase_id: 'cb2', application_id: 'app2', name: 'Web App' },
    ],
    runtime_links: [{ id: 'rl1', codebase_id: 'cb1', source_component_id: 'rc2', target_component_id: 'rc1', kind: 'http-call' }],
    summary: { codebases: 2, applications: 2, capabilities: 12, entities: 162 },
    // Untyped-but-real extras (see workspaceHelpers.getGraphExtras).
    inputs: [
      { project_id: 'p1', codebase_id: 'cb1', cas_generated_at: new Date(Date.now() - 27 * 60 * 1000).toISOString() },
      { project_id: 'p2', codebase_id: 'cb2', cas_generated_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() },
    ],
    activity: { contributors: [{ name: 'Michael Rivera', projects: ['p1'], source: 'cas' }] },
  } as WorkspaceAnalysisResponse['analysis'],
};

describe('WorkspacePage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(authHooks, 'useAuth').mockReturnValue({
      token: 'tok',
      user: { id: 'u1', email: 'claudia@example.com' },
      loading: false,
      signOut: vi.fn(),
      signInWithPassword: vi.fn(),
      registerWithPassword: vi.fn(),
    } as ReturnType<typeof authHooks.useAuth>);
    vi.spyOn(workspacesHooks, 'useWorkspaces').mockReturnValue({
      isLoading: false,
      isError: false,
      data: emptyAppData,
    } as ReturnType<typeof workspacesHooks.useWorkspaces>);
  });

  function renderPage() {
    return renderWithProviders(<WorkspacePage />, { route: '/workspaces/ws1', path: '/workspaces/:workspaceId' });
  }

  it('renders a loading state', () => {
    mockAnalysis({ isLoading: true });
    renderPage();
    expect(screen.getByText(/Loading this workspace/i)).toBeInTheDocument();
  });

  it('renders an error state', () => {
    mockAnalysis({ isError: true });
    renderPage();
    expect(screen.getByText(/Could not load this workspace/i)).toBeInTheDocument();
  });

  it('renders an empty state when there is no analysis yet', () => {
    mockAnalysis({ data: { status: 'none', workspace_id: 'ws1' } });
    renderPage();
    expect(screen.getByText(/No analysis yet/i)).toBeInTheDocument();
  });

  it('reads graph fields from the analysis envelope, not the response root', () => {
    mockAnalysis({ data: readyResponse });
    renderPage();
    // Title comes from workspace_name at the envelope root; description and
    // repositories come from analysis.* — both must render, proving the hook
    // consumer destructures `.analysis` rather than the root.
    expect(screen.getByRole('heading', { name: 'Soon' })).toBeInTheDocument();
    expect(screen.getByText('Fintech backend and web app.')).toBeInTheDocument();
    expect(screen.getAllByText('API Gateway').length).toBeGreaterThan(0);
  });

  it('excludes merged_into application rows and never surfaces them as a repository', () => {
    mockAnalysis({ data: readyResponse });
    renderPage();
    // The workspace screen has no Figma-designed application/deployable list
    // (see DESIGN-NOTES.md) — the merged_into row's synthetic name "api" must
    // not appear as its own repository card; only the two real codebases do.
    expect(screen.getAllByRole('heading', { level: 3 })).toHaveLength(2);
    expect(screen.getByRole('heading', { name: 'Backend', level: 3 })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Frontend', level: 3 })).toBeInTheDocument();
  });

  it('renders the repository grid with freshness and a codebase link', () => {
    mockAnalysis({ data: readyResponse });
    renderPage();
    expect(screen.getByText(/Last analyzed - 27m ago/)).toBeInTheDocument();
    // The codebase link is a `name~suffix` slug (src/lib/slugs.ts), not the
    // raw project id, per LANE-COMMON item 6 — RepositoryCard mints it from
    // the codebase's own {id, name}.
    expect(screen.getByRole('link', { name: /Open Backend/i })).toHaveAttribute('href', '/codebases/backend~p1');
  });
});
