import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '../../utils/renderWithProviders';
import { FileNodesPage } from '@/app/Functions/FileNodesPage';
import * as hooks from '@/shared/hooks/useFileNodes';
import type { CasNode } from '@/shared/hooks/useFileNodes';

const sample: CasNode[] = [
  { id: 'function_a.ts_apiRequest_0', name: 'apiRequest', type: 'function', source: { file: 'src/a.ts', line: 10 } },
  { id: 'class_a.ts_Widget_1', name: 'Widget', type: 'interface', source: { file: 'src/a.ts', line: 2 } },
];

function mockQuery(overrides: Partial<ReturnType<typeof hooks.useNodesForFile>>) {
  vi.spyOn(hooks, 'useNodesForFile').mockReturnValue({
    isLoading: false,
    isError: false,
    nodes: [],
    ...overrides,
  } as unknown as ReturnType<typeof hooks.useNodesForFile>);
}

const routeProps = { route: '/codebases/p1/functions/file/src/a.ts', path: '/codebases/:projectId/functions/file/*' };

describe('FileNodesPage', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('renders a loading state', () => {
    mockQuery({ isLoading: true });
    renderWithProviders(<FileNodesPage />, routeProps);
    expect(screen.getByText(/Loading file/i)).toBeInTheDocument();
  });

  it('renders an error state', () => {
    mockQuery({ isError: true });
    renderWithProviders(<FileNodesPage />, routeProps);
    expect(screen.getByText(/Could not load this file/i)).toBeInTheDocument();
  });

  it('renders an empty state when the file has no browsable nodes', () => {
    mockQuery({ nodes: [] });
    renderWithProviders(<FileNodesPage />, routeProps);
    expect(screen.getByText(/No nodes found for this file/i)).toBeInTheDocument();
  });

  it('groups the file nodes by type', () => {
    mockQuery({ nodes: sample });
    renderWithProviders(<FileNodesPage />, routeProps);
    expect(screen.getByText('function')).toBeInTheDocument();
    expect(screen.getByText('interface')).toBeInTheDocument();
    expect(screen.getByText('apiRequest')).toBeInTheDocument();
    expect(screen.getByText('Widget')).toBeInTheDocument();
  });
});
