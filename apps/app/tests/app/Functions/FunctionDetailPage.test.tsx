import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '../../utils/renderWithProviders';
import { FunctionDetailPage } from '@/app/Functions/FunctionDetailPage';
import * as nodeHooks from '@/shared/hooks/useNode';
import * as callerHooks from '@/shared/hooks/useCallers';
import * as calleeHooks from '@/shared/hooks/useCallees';
import type { CasNode } from '@/shared/hooks/useFileNodes';

const detailed: CasNode = {
  id: 'function_a.ts_apiRequest_0',
  name: 'apiRequest',
  type: 'function',
  qualified_name: 'function_apps/app/src/api.ts_apiRequest_0',
  description: 'Sends a JSON request and parses the response.',
  description_source: 'deterministic',
  source: { file: 'apps/app/src/api.ts', line: 352, end_line: 362 },
  signature: { parameters: [{ name: 'path', type: 'string' }, { name: 'token', type: 'string' }], return_type: 'Promise<T>' },
  metadata: { is_exported: true, is_async: true },
  tags: ['http'],
};

function mockNode(overrides: Partial<ReturnType<typeof nodeHooks.useNode>>) {
  vi.spyOn(nodeHooks, 'useNode').mockReturnValue({
    isLoading: false,
    isError: false,
    node: undefined,
    fileSiblings: [],
    ...overrides,
  } as unknown as ReturnType<typeof nodeHooks.useNode>);
}

function mockCallers(callers: ReturnType<typeof callerHooks.useCallers>['callers'] = []) {
  vi.spyOn(callerHooks, 'useCallers').mockReturnValue({ callers } as ReturnType<typeof callerHooks.useCallers>);
}

function mockCallees(callees: ReturnType<typeof calleeHooks.useCallees>['callees'] = []) {
  vi.spyOn(calleeHooks, 'useCallees').mockReturnValue({ callees } as ReturnType<typeof calleeHooks.useCallees>);
}

const routeProps = { route: '/codebases/p1/functions/n1', path: '/codebases/:projectId/functions/:nodeId' };

describe('FunctionDetailPage', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('renders a loading state', () => {
    mockNode({ isLoading: true });
    mockCallers();
    mockCallees();
    renderWithProviders(<FunctionDetailPage />, routeProps);
    expect(screen.getByText(/Loading node/i)).toBeInTheDocument();
  });

  it('renders an error state', () => {
    mockNode({ isError: true });
    mockCallers();
    mockCallees();
    renderWithProviders(<FunctionDetailPage />, routeProps);
    expect(screen.getByText(/Could not load this node/i)).toBeInTheDocument();
  });

  it('renders a not-found empty state when the id resolves to nothing', () => {
    mockNode({ node: undefined });
    mockCallers();
    mockCallees();
    renderWithProviders(<FunctionDetailPage />, routeProps);
    expect(screen.getByText(/Node not found/i)).toBeInTheDocument();
  });

  it('renders a fully-populated node with signature, callers, and callees', () => {
    mockNode({ node: detailed, fileSiblings: [] });
    mockCallers([{ id: 'function_a.ts_caller_1', node: { ...detailed, id: 'function_a.ts_caller_1', name: 'signIn' }, line: 5 }]);
    mockCallees([{ id: 'function_a.ts_fetch_2', node: { ...detailed, id: 'function_a.ts_fetch_2', name: 'fetch' }, line: 20 }]);
    renderWithProviders(<FunctionDetailPage />, routeProps);
    expect(screen.getAllByText('apiRequest').length).toBeGreaterThan(0);
    expect(screen.getByText(/Sends a JSON request/i)).toBeInTheDocument();
    expect(screen.getByText('signIn')).toBeInTheDocument();
    expect(screen.getByText('fetch')).toBeInTheDocument();
  });

  it('renders an unresolved caller honestly (edge present, node not independently browsable)', () => {
    mockNode({ node: detailed, fileSiblings: [] });
    mockCallers([{ id: 'exit_api_fetch_356' }]);
    mockCallees();
    renderWithProviders(<FunctionDetailPage />, routeProps);
    expect(screen.getByText('exit_api_fetch_356')).toBeInTheDocument();
  });

  it('renders an empty relationship state when nothing calls or is called', () => {
    mockNode({ node: detailed, fileSiblings: [] });
    mockCallers([]);
    mockCallees([]);
    renderWithProviders(<FunctionDetailPage />, routeProps);
    expect(screen.getByText(/Nothing in this analysis calls this node/i)).toBeInTheDocument();
    expect(screen.getByText(/doesn't call anything else/i)).toBeInTheDocument();
  });
});
