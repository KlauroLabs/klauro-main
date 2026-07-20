import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '../../test/renderWithProviders';
import { FlowDetailPage } from './FlowDetailPage';
import * as flowHooks from '../../hooks/useFlow';
import * as summaryHooks from '../../hooks/useProjectSummary';
import * as entryPointHooks from '../../hooks/useEntryPoints';
import type { FlowConcept } from '../../api';

const sampleFlow: FlowConcept = {
  flow_id: 'flow::a',
  name: 'Create Order',
  intent: 'Handles order creation end to end.',
  entry_point: 'entry_http_a',
  role: 'core',
  entities: ['Order', 'Customer'],
  capability_relationships: [{ capability_id: 'cap_orders', role: 'primary', rationale: 'entry point is a listed operation' }],
  contract: {
    input: ['OrderRequest'],
    logic: '',
    side_effects: { state_changes: ['Order created'], external_integrations: ['Stripe'] },
    output: ['OrderResponse'],
    constraints: ['Payment must be authorized before capture.'],
  },
  steps: [
    {
      step_id: 's1',
      order: 0,
      name: 'Validate Payment',
      description: 'Ensures the payment method is valid.',
      contract: { input: ['PaymentMethod'], logic: '', side_effects: { state_changes: [], external_integrations: ['Stripe'] }, output: ['ValidationResult'], constraints: [] },
      functions: [{ function_id: 'function:src/payment.ts:verify' }],
    },
    {
      step_id: 's2',
      order: 1,
      name: 'Process Payment',
      description: 'Charges the customer.',
      contract: { input: [], logic: '', side_effects: { state_changes: [], external_integrations: [] }, output: [], constraints: [] },
      functions: [],
    },
  ],
};

function mockFlow(overrides: Partial<ReturnType<typeof flowHooks.useFlow>>) {
  vi.spyOn(flowHooks, 'useFlow').mockReturnValue({
    isLoading: false,
    isError: false,
    flow: undefined,
    capabilityLinks: [],
    ...overrides,
  } as ReturnType<typeof flowHooks.useFlow>);
}

const routeProps = { route: '/codebases/p1/flows/flow::a', path: '/codebases/:projectId/flows/:flowId' };

describe('FlowDetailPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(summaryHooks, 'useProjectSummary').mockReturnValue({
      isLoading: false,
      isError: false,
      data: { status: 'ready', project_id: 'p1', summary: { name: 'proof-of-concept' } },
    } as ReturnType<typeof summaryHooks.useProjectSummary>);
    vi.spyOn(entryPointHooks, 'useEntryPoint').mockReturnValue({
      isLoading: false,
      isError: false,
      allEntryPoints: [],
      deployables: [],
      entryPoint: undefined,
    } as unknown as ReturnType<typeof entryPointHooks.useEntryPoint>);
  });

  it('renders a loading state', () => {
    mockFlow({ isLoading: true });
    renderWithProviders(<FlowDetailPage />, routeProps);
    expect(screen.getByText(/Loading flow/i)).toBeInTheDocument();
  });

  it('renders an error state', () => {
    mockFlow({ isError: true });
    renderWithProviders(<FlowDetailPage />, routeProps);
    expect(screen.getByText(/Could not load this flow/i)).toBeInTheDocument();
  });

  it('renders a not-found state when the flow id has no match', () => {
    mockFlow({ flow: undefined });
    renderWithProviders(<FlowDetailPage />, routeProps);
    expect(screen.getByText(/Flow not found/i)).toBeInTheDocument();
  });

  it('renders the flow header, step chain, and data sections when present', () => {
    mockFlow({ flow: sampleFlow });
    renderWithProviders(<FlowDetailPage />, routeProps);
    expect(screen.getByRole('heading', { name: 'Create Order' })).toBeInTheDocument();
    expect(screen.getByText(sampleFlow.intent)).toBeInTheDocument();
    expect(screen.getAllByText('Validate Payment').length).toBeGreaterThan(0);
    expect(screen.getByText('Process Payment')).toBeInTheDocument();
    expect(screen.getByText('OrderRequest')).toBeInTheDocument();
    expect(screen.getByText('OrderResponse')).toBeInTheDocument();
    expect(screen.getByText(/Payment must be authorized before capture/)).toBeInTheDocument();
    expect(screen.getByText(/Order created/)).toBeInTheDocument();
  });
});
