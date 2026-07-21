import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '../../test/renderWithProviders';
import { CodebaseDependencies } from './CodebaseDependencies';
import * as serviceHooks from '../../hooks/useExternalServices';
import * as libraryHooks from '../../hooks/useLibraries';

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

const routeProps = { route: '/codebases/p1/dependencies', path: '/codebases/:projectId/dependencies' };

describe('CodebaseDependencies', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('renders a loading state while either query loads', () => {
    mockServices({ isLoading: true });
    mockLibraries({});
    renderWithProviders(<CodebaseDependencies />, routeProps);
    expect(screen.getByText(/Loading dependencies/i)).toBeInTheDocument();
  });

  it('renders an error state when either query fails', () => {
    mockServices({ isError: true });
    mockLibraries({});
    renderWithProviders(<CodebaseDependencies />, routeProps);
    expect(screen.getByText(/Could not load this codebase's dependencies/i)).toBeInTheDocument();
  });

  it('renders an honest empty state when the codebase has nothing to depend on', () => {
    mockServices({});
    mockLibraries({});
    renderWithProviders(<CodebaseDependencies />, routeProps);
    expect(screen.getByText(/No dependencies found/i)).toBeInTheDocument();
  });

  it('renders real external services and libraries when present (parity with /integrations)', () => {
    mockServices({ externalServices: [{ id: 's1', name: 'Redis', type: 'cache' }] });
    mockLibraries({ libraries: [{ id: 'l1', name: 'express', type: 'production' }] });
    renderWithProviders(<CodebaseDependencies />, routeProps);
    expect(screen.getByText('External services')).toBeInTheDocument();
    expect(screen.getByText('Redis')).toBeInTheDocument();
    expect(screen.getByText('Libraries')).toBeInTheDocument();
    expect(screen.getByText('express')).toBeInTheDocument();
  });
});
