import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { renderWithProviders } from '../../test/renderWithProviders';
import { FlowsListPage } from './FlowsListPage';
import * as flowsHooks from '../../hooks/useFlows';
import * as summaryHooks from '../../hooks/useProjectSummary';
import type { FlowConcept } from '../../api';

const sampleFlow: FlowConcept = {
  flow_id: 'flow::a',
  name: 'Create Order',
  intent: 'Handles order creation.',
  entry_point: 'entry_http_a',
  role: 'core',
  entities: ['Order'],
  capability_relationships: [{ capability_id: 'cap_orders', role: 'primary', rationale: 'entry point is a listed operation' }],
  contract: { input: [], logic: '', side_effects: { state_changes: [], external_integrations: [] }, output: [], constraints: [] },
  steps: [
    { step_id: 's1', order: 0, name: 'Validate', description: '', contract: { input: [], logic: '', side_effects: { state_changes: [], external_integrations: [] }, output: [], constraints: [] }, functions: [] },
  ],
};

function mockFlows(overrides: Partial<ReturnType<typeof flowsHooks.useFlows>>) {
  vi.spyOn(flowsHooks, 'useFlows').mockReturnValue({
    isLoading: false,
    isError: false,
    flows: [],
    roleBreakdown: { core: 0, supporting: 0, infrastructure: 0, unknown: 0 },
    totalAvailable: undefined,
    gaps: [],
    ...overrides,
  } as ReturnType<typeof flowsHooks.useFlows>);
}

const routeProps = { route: '/codebases/p1/flows', path: '/codebases/:projectId/flows' };

describe('FlowsListPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(summaryHooks, 'useProjectSummary').mockReturnValue({
      isLoading: false,
      isError: false,
      data: { status: 'ready', project_id: 'p1', summary: { name: 'proof-of-concept', description: 'A test codebase.' } },
    } as ReturnType<typeof summaryHooks.useProjectSummary>);
  });

  it('renders a loading state', () => {
    mockFlows({ isLoading: true });
    renderWithProviders(<FlowsListPage />, routeProps);
    expect(screen.getByText(/Loading flows/i)).toBeInTheDocument();
  });

  it('renders an error state', () => {
    mockFlows({ isError: true });
    renderWithProviders(<FlowsListPage />, routeProps);
    expect(screen.getByText(/Could not load flows/i)).toBeInTheDocument();
  });

  it('renders an empty state when no flows are derivable', () => {
    mockFlows({ flows: [] });
    renderWithProviders(<FlowsListPage />, routeProps);
    expect(screen.getByText(/No flows found/i)).toBeInTheDocument();
  });

  it('renders the table with flow rows when data is present', () => {
    mockFlows({ flows: [sampleFlow], totalAvailable: 1 });
    renderWithProviders(<FlowsListPage />, routeProps);
    expect(screen.getByText('Create Order')).toBeInTheDocument();
    expect(screen.getByText('Core')).toBeInTheDocument();
    expect(screen.getByText('1 linked')).toBeInTheDocument();
  });

  it('filters rows by search text', async () => {
    mockFlows({ flows: [sampleFlow] });
    renderWithProviders(<FlowsListPage />, routeProps);
    const search = screen.getByPlaceholderText(/Search flows/i);
    fireEvent.change(search, { target: { value: 'nonexistent' } });
    expect(await screen.findByText(/No flows match/i)).toBeInTheDocument();
  });
});
