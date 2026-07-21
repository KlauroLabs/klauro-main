import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '../../utils/renderWithProviders';
import { CodebaseOverview } from '@/app/Codebase/CodebaseOverview';
import * as summaryHooks from '@/shared/hooks/useProjectSummary';
import * as conceptualHooks from '@/shared/hooks/useProjectConceptual';
import * as reanalyzeHooks from '@/shared/hooks/useReanalyze';
import * as dasHooks from '@/shared/hooks/useDasUnits';
import * as architectureConceptsHooks from '@/shared/hooks/useArchitectureConcepts';
import * as entryPointsHooks from '@/shared/hooks/useEntryPoints';
import * as externalServicesHooks from '@/shared/hooks/useExternalServices';
import * as librariesHooks from '@/shared/hooks/useLibraries';

const routeProps = { route: '/codebases/p1', path: '/codebases/:projectId' };

function mockSummary(overrides: Partial<ReturnType<typeof summaryHooks.useProjectSummary>>) {
  vi.spyOn(summaryHooks, 'useProjectSummary').mockReturnValue({
    isLoading: false,
    isError: false,
    data: undefined,
    ...overrides,
  } as ReturnType<typeof summaryHooks.useProjectSummary>);
}

function mockConceptual(overrides: Partial<ReturnType<typeof conceptualHooks.useProjectConceptual>>) {
  vi.spyOn(conceptualHooks, 'useProjectConceptual').mockReturnValue({
    isLoading: false,
    isError: false,
    data: undefined,
    ...overrides,
  } as ReturnType<typeof conceptualHooks.useProjectConceptual>);
}

describe('CodebaseOverview', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(reanalyzeHooks, 'useReanalyzeProject').mockReturnValue({
      mutate: vi.fn(),
      isPending: false,
    } as unknown as ReturnType<typeof reanalyzeHooks.useReanalyzeProject>);
    // ArchitectureSection's diagram (clickables-diagrams lane) reads
    // deployable_evidence via useDasIndex — mocked here the same way
    // summary/conceptual are, so this test doesn't need an AuthProvider.
    vi.spyOn(dasHooks, 'useDasIndex').mockReturnValue({
      evidence: [],
      units: [],
      promoted: false,
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof dasHooks.useDasIndex>);
    // ArchitectureSection's diagram concepts lens (arch-concepts lane) reads
    // architecture_summary.architectural_inventory + call edges via
    // useArchitectureConcepts — mocked the same way as useDasIndex above.
    vi.spyOn(architectureConceptsHooks, 'useArchitectureConcepts').mockReturnValue({
      inventory: {},
      edges: [],
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof architectureConceptsHooks.useArchitectureConcepts>);
    // Product-entry count (page-codebase) reads useEntryPoints — same
    // useProjectCas-backed reason as useDasIndex/useArchitectureConcepts above.
    vi.spyOn(entryPointsHooks, 'useEntryPoints').mockReturnValue({
      allEntryPoints: [],
      deployables: [],
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof entryPointsHooks.useEntryPoints>);
    // DependenciesSection (page-codebase) reuses the integrations lane's
    // hooks (useExternalServices/useLibraries) — both built on useProjectCas
    // — mocked the same way for the same reason as useDasIndex above.
    vi.spyOn(externalServicesHooks, 'useExternalServices').mockReturnValue({
      externalServices: [],
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof externalServicesHooks.useExternalServices>);
    vi.spyOn(librariesHooks, 'useLibraries').mockReturnValue({
      libraries: [],
      dependencyManifest: undefined,
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof librariesHooks.useLibraries>);
  });

  it('renders a loading state', () => {
    mockSummary({ isLoading: true });
    mockConceptual({ isLoading: true });
    renderWithProviders(<CodebaseOverview />, routeProps);
    expect(screen.getByText(/Loading codebase overview/i)).toBeInTheDocument();
  });

  it('renders an error state', () => {
    mockSummary({ isError: true });
    mockConceptual({ isLoading: false });
    renderWithProviders(<CodebaseOverview />, routeProps);
    expect(screen.getByText(/Could not load this codebase's overview/i)).toBeInTheDocument();
  });

  it('renders an empty state when there is no analysis', () => {
    mockSummary({ data: { status: 'no_analysis', project_id: 'p1' } });
    mockConceptual({ data: { status: 'no_analysis', project_id: 'p1' } });
    renderWithProviders(<CodebaseOverview />, routeProps);
    expect(screen.getByText(/No analysis yet/i)).toBeInTheDocument();
  });

  it('renders header, stats, and all five sections when data is present', () => {
    mockSummary({
      data: {
        status: 'ready',
        project_id: 'p1',
        summary: {
          name: 'Backend',
          type: 'service',
          description: 'Fintech backend that manages auth, portfolios, trading, payments, and market data.',
          analysis_timestamp: new Date().toISOString(),
          capabilities: 1,
          entry_points: 42,
          architecture_type: 'Modular monolith',
          database_entities: ['User', 'Trade'],
        },
        product_map: {
          identity: { name: 'Backend', domain: 'fintech', description: '', unanalyzed_languages: [] },
          capabilities: [
            { name: 'Trade Execution', description: 'Submit and settle orders.', category: 'core', criticality: 'critical', entities: ['Order'], tests_present: true, risk_level: 'low' },
          ],
          data: { entities: 2, sensitive: [], exposure_highlights: [] },
          health: { tests: { total: 0, passing: 0, failing: 0 }, implementation: { complete: 0, partial: 0, stubs: 0, not_implemented: 0, deprecated: 0 }, top_risks: [] },
        },
      },
    });
    mockConceptual({
      data: {
        status: 'ready',
        project_id: 'p1',
        capabilities: [{ id: 'cap_1', name: 'Trade Execution', category: 'core', criticality: 'critical', related_flows: [{ flow_id: 'flow_1', role: 'primary', rationale: 'x' }] }],
        flows: { flows: [], total: 0 },
      },
    });

    renderWithProviders(<CodebaseOverview />, routeProps);

    expect(screen.getByText('Backend')).toBeInTheDocument();
    expect(screen.getByText(/Fintech backend/)).toBeInTheDocument();
    expect(screen.getByText('01')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Capabilities' })).toBeInTheDocument();
    expect(screen.getByText('02')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Critical Flows' })).toBeInTheDocument();
    expect(screen.getByText('03')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Key Entities' })).toBeInTheDocument();
    expect(screen.getByText('04')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Architecture' })).toBeInTheDocument();
    expect(screen.getByText('05')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Dependencies' })).toBeInTheDocument();
    expect(screen.getByText('Trade Execution')).toBeInTheDocument();
    expect(screen.getByText('Modular monolith')).toBeInTheDocument();
  });
});
