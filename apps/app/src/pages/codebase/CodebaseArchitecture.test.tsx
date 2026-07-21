import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '../../test/renderWithProviders';
import { CodebaseArchitecture } from './CodebaseArchitecture';
import * as summaryHooks from '../../hooks/useProjectSummary';
import * as dasHooks from '../../hooks/useDasUnits';

const routeProps = { route: '/codebases/p1/architecture', path: '/codebases/:projectId/architecture' };

function mockSummary(overrides: Partial<ReturnType<typeof summaryHooks.useProjectSummary>>) {
  vi.spyOn(summaryHooks, 'useProjectSummary').mockReturnValue({
    isLoading: false,
    isError: false,
    data: undefined,
    ...overrides,
  } as ReturnType<typeof summaryHooks.useProjectSummary>);
}

function mockDasIndex(overrides: Partial<ReturnType<typeof dasHooks.useDasIndex>>) {
  vi.spyOn(dasHooks, 'useDasIndex').mockReturnValue({
    isLoading: false,
    isError: false,
    promoted: false,
    units: [],
    evidence: [],
    nodes: [],
    dataEntities: [],
    ...overrides,
  } as ReturnType<typeof dasHooks.useDasIndex>);
}

describe('CodebaseArchitecture', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockDasIndex({});
  });

  it('renders a loading state', () => {
    mockSummary({ isLoading: true });
    renderWithProviders(<CodebaseArchitecture />, routeProps);
    expect(screen.getByText(/Loading architecture/i)).toBeInTheDocument();
  });

  it('renders an error state', () => {
    mockSummary({ isError: true });
    renderWithProviders(<CodebaseArchitecture />, routeProps);
    expect(screen.getByText(/Could not load architecture/i)).toBeInTheDocument();
  });

  it('renders an empty state when there is no analysis', () => {
    mockSummary({ data: { status: 'no_analysis', project_id: 'p1' } });
    renderWithProviders(<CodebaseArchitecture />, routeProps);
    expect(screen.getByText(/No analysis yet/i)).toBeInTheDocument();
  });

  it('renders system type, an honest empty diagram, and patterns when evidence is absent', () => {
    mockSummary({
      data: {
        status: 'ready',
        project_id: 'p1',
        summary: {
          architecture_type: 'Modular monolith',
          architectural_patterns: [{ name: 'Repository', confidence: 0.9, category: 'data' }],
          architectural_inventory_counts: { layers: 3 },
        },
      },
    });
    renderWithProviders(<CodebaseArchitecture />, routeProps);
    expect(screen.getByText('Modular monolith')).toBeInTheDocument();
    expect(screen.getByText(/No deployable\/ship evidence detected yet/i)).toBeInTheDocument();
    expect(screen.getByText('Repository')).toBeInTheDocument();
  });

  it('renders the diagram canvas once deployable_evidence is present', () => {
    mockSummary({
      data: {
        status: 'ready',
        project_id: 'p1',
        summary: { architecture_type: 'Modular monolith' },
      },
    });
    mockDasIndex({
      evidence: [
        { root_path: 'services/api', name: 'api', tier: 1, kind: 'container', evidence: ['Dockerfile'] },
      ],
    });
    renderWithProviders(<CodebaseArchitecture />, routeProps);
    expect(screen.getByRole('img', { name: 'Codebase architecture diagram' })).toBeInTheDocument();
  });
});
