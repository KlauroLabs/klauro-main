import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '../../test/renderWithProviders';
import { IntegrationsPage } from './IntegrationsPage';
import * as exitPointHooks from '../../hooks/useExitPoints';
import * as serviceHooks from '../../hooks/useExternalServices';
import * as libraryHooks from '../../hooks/useLibraries';

function mockExitPoints(overrides: Partial<ReturnType<typeof exitPointHooks.useExitPoints>>) {
  vi.spyOn(exitPointHooks, 'useExitPoints').mockReturnValue({
    isLoading: false,
    isError: false,
    allExitPoints: [],
    familyGroups: [],
    ...overrides,
  } as ReturnType<typeof exitPointHooks.useExitPoints>);
}

function mockServices(overrides: Partial<ReturnType<typeof serviceHooks.useExternalServices>>) {
  vi.spyOn(serviceHooks, 'useExternalServices').mockReturnValue({
    isLoading: false,
    isError: false,
    externalServices: [],
    ...overrides,
  } as ReturnType<typeof serviceHooks.useExternalServices>);
}

function mockLibraries(overrides: Partial<ReturnType<typeof libraryHooks.useLibraries>>) {
  vi.spyOn(libraryHooks, 'useLibraries').mockReturnValue({
    isLoading: false,
    isError: false,
    libraries: [],
    dependencyManifest: undefined,
    ...overrides,
  } as ReturnType<typeof libraryHooks.useLibraries>);
}

const routeProps = { route: '/codebases/p1/integrations', path: '/codebases/:projectId/integrations' };

describe('IntegrationsPage', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('renders a loading state while any of the three queries load', () => {
    mockExitPoints({ isLoading: true });
    mockServices({});
    mockLibraries({});
    renderWithProviders(<IntegrationsPage />, routeProps);
    expect(screen.getByText(/Loading dependencies/i)).toBeInTheDocument();
  });

  it('renders an error state when any query fails', () => {
    mockExitPoints({});
    mockServices({ isError: true });
    mockLibraries({});
    renderWithProviders(<IntegrationsPage />, routeProps);
    expect(screen.getByText(/Could not load this codebase's dependencies/i)).toBeInTheDocument();
  });

  it('renders an honest empty state when the codebase has nothing to depend on', () => {
    mockExitPoints({});
    mockServices({});
    mockLibraries({});
    renderWithProviders(<IntegrationsPage />, routeProps);
    expect(screen.getByText(/No dependencies found/i)).toBeInTheDocument();
  });

  it('renders the four sections when data is present', () => {
    mockExitPoints({
      allExitPoints: [{ id: 'x1', source_node: 'n1', type: 'database', name: 'Postgres — analyses', operation: { async: false } }],
      familyGroups: [
        {
          family: 'db',
          count: 1,
          kinds: [{ kind: 'database', count: 1 }],
          exitPoints: [{ id: 'x1', source_node: 'n1', type: 'database', name: 'Postgres — analyses', operation: { async: false } }],
        },
      ],
    });
    mockServices({ externalServices: [{ id: 's1', name: 'Redis', type: 'cache' }] });
    mockLibraries({ libraries: [{ id: 'l1', name: 'express', type: 'production' }] });
    renderWithProviders(<IntegrationsPage />, routeProps);
    expect(screen.getByText('Dependencies')).toBeInTheDocument();
    expect(screen.getByText('Postgres — analyses')).toBeInTheDocument();
    expect(screen.getByText('Redis')).toBeInTheDocument();
    expect(screen.getByText('express')).toBeInTheDocument();
  });
});
