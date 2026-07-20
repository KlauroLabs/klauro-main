import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '../../test/renderWithProviders';
import { FunctionsPage } from './FunctionsPage';
import * as hooks from '../../hooks/useFileNodes';
import type { CasNode } from '../../hooks/useFileNodes';

const sample: CasNode[] = [
  { id: 'function_a.ts_apiRequest_0', name: 'apiRequest', type: 'function', source: { file: 'src/a.ts', line: 10 }, description: 'Fetches from the API.' },
  { id: 'class_a.ts_Widget_1', name: 'Widget', type: 'interface', source: { file: 'src/a.ts', line: 2 } },
];

function mockQuery(overrides: Partial<ReturnType<typeof hooks.useFilteredNodes>>) {
  vi.spyOn(hooks, 'useFilteredNodes').mockReturnValue({
    isLoading: false,
    isError: false,
    allNodes: [],
    filteredNodes: [],
    types: [],
    files: [],
    ...overrides,
  } as unknown as ReturnType<typeof hooks.useFilteredNodes>);
}

const routeProps = { route: '/codebases/p1/functions', path: '/codebases/:projectId/functions' };

describe('FunctionsPage', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('renders a loading state', () => {
    mockQuery({ isLoading: true });
    renderWithProviders(<FunctionsPage />, routeProps);
    expect(screen.getByText(/Loading nodes/i)).toBeInTheDocument();
  });

  it('renders an error state', () => {
    mockQuery({ isError: true });
    renderWithProviders(<FunctionsPage />, routeProps);
    expect(screen.getByText(/Could not load nodes/i)).toBeInTheDocument();
  });

  it('renders an empty state when the codebase truly has no nodes', () => {
    mockQuery({ allNodes: [], filteredNodes: [] });
    renderWithProviders(<FunctionsPage />, routeProps);
    expect(screen.getByText(/No nodes found/i)).toBeInTheDocument();
  });

  it('renders the node table when data is present', () => {
    mockQuery({
      allNodes: sample,
      filteredNodes: sample,
      types: [{ value: 'function', count: 1 }, { value: 'interface', count: 1 }],
      files: [{ value: 'src/a.ts', count: 2 }],
    });
    renderWithProviders(<FunctionsPage />, routeProps);
    expect(screen.getByText('apiRequest')).toBeInTheDocument();
    expect(screen.getByText('Widget')).toBeInTheDocument();
    expect(screen.getByText(/2 nodes across 1 files/i)).toBeInTheDocument();
  });

  it('reports a filtered-to-empty state distinctly from a truly-empty codebase', () => {
    mockQuery({
      allNodes: sample,
      filteredNodes: [],
      types: [{ value: 'function', count: 1 }],
      files: [{ value: 'src/a.ts', count: 2 }],
    });
    renderWithProviders(<FunctionsPage />, routeProps);
    expect(screen.getByText(/No nodes match the current search or filters/i)).toBeInTheDocument();
  });
});
