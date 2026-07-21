import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { renderWithProviders } from '../../test/renderWithProviders';
import { CodebaseArchitecture } from './CodebaseArchitecture';
import * as summaryHooks from '../../hooks/useProjectSummary';
import * as dasHooks from '../../hooks/useDasUnits';
import * as architectureConceptsHooks from '../../hooks/useArchitectureConcepts';

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

function mockArchitectureConcepts(overrides: Partial<ReturnType<typeof architectureConceptsHooks.useArchitectureConcepts>>) {
  vi.spyOn(architectureConceptsHooks, 'useArchitectureConcepts').mockReturnValue({
    isLoading: false,
    isError: false,
    inventory: {},
    edges: [],
    ...overrides,
  } as ReturnType<typeof architectureConceptsHooks.useArchitectureConcepts>);
}

describe('CodebaseArchitecture', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockDasIndex({});
    mockArchitectureConcepts({});
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

  it('renders system type, an honest empty diagram, and patterns when there is no concept or deployable evidence', () => {
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
    expect(screen.getByText(/No architectural concept evidence detected yet/i)).toBeInTheDocument();
    expect(screen.getByText('Repository')).toBeInTheDocument();
  });

  it('renders the concepts lens (default) once architectural_inventory is present', () => {
    mockSummary({
      data: {
        status: 'ready',
        project_id: 'p1',
        summary: { architecture_type: 'Modular monolith' },
      },
    });
    mockArchitectureConcepts({
      inventory: { services: ['svc_1', 'svc_2'], controllers: ['ctl_1'] },
      edges: [{ source: 'ctl_1', target: 'svc_1', type: 'calls' }],
    });
    renderWithProviders(<CodebaseArchitecture />, routeProps);
    expect(screen.getByRole('img', { name: 'Codebase architecture diagram' })).toBeInTheDocument();
    expect(screen.getByText('Services (2)')).toBeInTheDocument();
    expect(screen.getByText('Controllers (1)')).toBeInTheDocument();
  });

  it('renders the deployables lens once switched, using deployable_evidence', () => {
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
    fireEvent.click(screen.getByRole('button', { name: 'Deployables' }));
    expect(screen.getByRole('img', { name: 'Codebase architecture diagram' })).toBeInTheDocument();
    expect(screen.getByText('api')).toBeInTheDocument();
  });
});
