import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '../../test/renderWithProviders';
import { JumpBackInCard, type JumpBackInTarget } from './JumpBackInCard';
import * as projectSummaryHooks from '../../hooks/useProjectSummary';
import * as recentViews from '../../hooks/useRecentProjectViews';

function mockSummary(overrides: Partial<ReturnType<typeof projectSummaryHooks.useProjectSummary>>) {
  vi.spyOn(projectSummaryHooks, 'useProjectSummary').mockReturnValue({
    isLoading: false,
    isError: false,
    data: undefined,
    ...overrides,
  } as ReturnType<typeof projectSummaryHooks.useProjectSummary>);
}

const target: JumpBackInTarget = {
  project: { id: 'p1', workspace_id: 'ws1', name: 'Settlement' },
  workspaceId: 'ws1',
  workspaceName: 'Soon',
};

describe('JumpBackInCard', () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => window.localStorage.clear());

  it('renders an honest "—" for Capabilities and Last Opened when neither is available', () => {
    mockSummary({});
    renderWithProviders(<JumpBackInCard target={target} />);
    expect(screen.getByText('Settlement')).toBeInTheDocument();
    expect(screen.getByText('Last Opened —')).toBeInTheDocument();
  });

  it('wires Capabilities from useProjectSummary when the summary is ready', () => {
    mockSummary({
      data: { status: 'ready', project_id: 'p1', summary: { capabilities: 7 } },
    });
    renderWithProviders(<JumpBackInCard target={target} />);
    expect(screen.getByText('7')).toBeInTheDocument();
  });

  it('wires Last Opened from client-side recency tracking once the project has been visited', () => {
    mockSummary({});
    vi.spyOn(recentViews, 'getLastOpenedAt').mockReturnValue(new Date(Date.now() - 60 * 60 * 1000).toISOString());
    renderWithProviders(<JumpBackInCard target={target} />);
    expect(screen.getByText('Last Opened 1h ago')).toBeInTheDocument();
  });
});
