import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '../../test/renderWithProviders';
import { EntryPointDetailPage } from './EntryPointDetailPage';
import * as epHooks from '../../hooks/useEntryPoints';
import * as flowHooks from '../../hooks/useEntryPointFlow';
import type { EntryPoint } from '../../hooks/useEntryPoints';

const detailed: EntryPoint = {
  id: 'a',
  source_node: 'na',
  type: 'http',
  name: 'createWidget',
  description: 'Creates a widget.',
  trigger: { method: 'post', path: '/v1/widgets' },
  security: { authenticated: true, authorized_roles: ['workspace member'], enforcement: 'enforced' },
  input: { fields: [{ name: 'project_path', type: 'text' }] },
  output: { type: 'AnalysisResult', is_named_type: true, status_codes: [202, 401] },
  handler: { node_id: 'n1', method_name: 'handleCreate', file: 'src/widgets.ts', line: 42 },
  capabilities: [{ capability_id: 'cap1', capability_name: 'Analyze a codebase', role: 'primary' }],
};

const bare: EntryPoint = { id: 'b', source_node: 'nb', type: 'lifecycle', name: 'onStartup' };

function mockEp(overrides: Partial<ReturnType<typeof epHooks.useEntryPoint>>) {
  vi.spyOn(epHooks, 'useEntryPoint').mockReturnValue({
    isLoading: false,
    isError: false,
    allEntryPoints: [],
    deployables: [],
    entryPoint: undefined,
    ...overrides,
  } as ReturnType<typeof epHooks.useEntryPoint>);
}

function mockFlow(flow: unknown, isLoading = false) {
  vi.spyOn(flowHooks, 'useEntryPointFlow').mockReturnValue({ isLoading, flow } as ReturnType<typeof flowHooks.useEntryPointFlow>);
}

const routeProps = { route: '/codebases/p1/entry-points/a', path: '/codebases/:projectId/entry-points/:entryPointId' };

describe('EntryPointDetailPage', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('renders a loading state', () => {
    mockEp({ isLoading: true });
    mockFlow(undefined);
    renderWithProviders(<EntryPointDetailPage />, routeProps);
    expect(screen.getByText(/Loading entry point/i)).toBeInTheDocument();
  });

  it('renders an error state', () => {
    mockEp({ isError: true });
    mockFlow(undefined);
    renderWithProviders(<EntryPointDetailPage />, routeProps);
    expect(screen.getByText(/Could not load this entry point/i)).toBeInTheDocument();
  });

  it('renders a not-found empty state when the id resolves to nothing', () => {
    mockEp({ entryPoint: undefined });
    mockFlow(undefined);
    renderWithProviders(<EntryPointDetailPage />, routeProps);
    expect(screen.getByText(/Entry point not found/i)).toBeInTheDocument();
  });

  it('renders a fully-populated entry point end to end', () => {
    mockEp({ entryPoint: detailed });
    mockFlow(undefined);
    renderWithProviders(<EntryPointDetailPage />, routeProps);
    expect(screen.getByText('createWidget')).toBeInTheDocument();
    expect(screen.getAllByText('Protected').length).toBeGreaterThan(0);
    expect(screen.getByText('project_path')).toBeInTheDocument();
    expect(screen.getByText('AnalysisResult')).toBeInTheDocument();
    expect(screen.getByText('src/widgets.ts:42')).toBeInTheDocument();
    expect(screen.getByText('Analyze a codebase')).toBeInTheDocument();
  });

  it('renders every in-between state honestly for a bare entry point (name + address only)', () => {
    mockEp({ entryPoint: bare });
    mockFlow(undefined);
    renderWithProviders(<EntryPointDetailPage />, routeProps);
    expect(screen.getByText('onStartup')).toBeInTheDocument();
    expect(screen.getByText(/Nothing\. It takes no input/i)).toBeInTheDocument();
    expect(screen.getByText(/no flow linked yet/i)).toBeInTheDocument();
    expect(screen.getByText(/None — infrastructure/i)).toBeInTheDocument();
    // No telemetry data on this fixture: the section must not render at all.
    expect(screen.queryByText(/What we know once it's running/i)).not.toBeInTheDocument();
  });
});
