import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '../../../test/renderWithProviders';
import { DependenciesSection } from './DependenciesSection';
import * as serviceHooks from '../../../hooks/useExternalServices';
import * as libraryHooks from '../../../hooks/useLibraries';

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

describe('DependenciesSection', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('renders an honest empty state when there is nothing to depend on', () => {
    mockServices({});
    mockLibraries({});
    renderWithProviders(<DependenciesSection projectId="p1" />);
    expect(screen.getByText(/No external services or declared dependencies found/i)).toBeInTheDocument();
  });

  it('renders external-service chips and a library-count caption when data is present', () => {
    mockServices({ externalServices: [{ id: 's1', name: 'Stripe', type: 'payments' }] });
    mockLibraries({ libraries: [{ id: 'l1', name: 'express', type: 'production' }] });
    renderWithProviders(<DependenciesSection projectId="p1" />);
    expect(screen.getByText('Stripe')).toBeInTheDocument();
    expect(screen.getByText(/1 recognized library/i)).toBeInTheDocument();
  });
});
