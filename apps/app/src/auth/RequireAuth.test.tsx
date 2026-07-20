import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { render } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RequireAuth } from './RequireAuth';
import * as authHooks from './AuthProvider';

function mockAuth(overrides: Partial<ReturnType<typeof authHooks.useAuth>> = {}) {
  vi.spyOn(authHooks, 'useAuth').mockReturnValue({
    token: null,
    user: null,
    loading: false,
    signInWithPassword: vi.fn(),
    registerWithPassword: vi.fn(),
    signOut: vi.fn(),
    ...overrides,
  } as ReturnType<typeof authHooks.useAuth>);
}

function renderGuarded() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/auth" element={<div>Auth screen</div>} />
          <Route
            path="/"
            element={
              <RequireAuth>
                <div>Protected content</div>
              </RequireAuth>
            }
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('RequireAuth', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('shows a loading state while auth is resolving', () => {
    mockAuth({ loading: true });
    renderGuarded();
    expect(screen.getByText(/Signing you in/i)).toBeInTheDocument();
  });

  it('redirects to /auth when there is no token', () => {
    mockAuth({ token: null });
    renderGuarded();
    expect(screen.getByText('Auth screen')).toBeInTheDocument();
    expect(screen.queryByText('Protected content')).not.toBeInTheDocument();
  });

  it('renders children when a token is present', () => {
    mockAuth({ token: 'tok', user: { id: 'u1', email: 'claudia@example.com' } });
    renderGuarded();
    expect(screen.getByText('Protected content')).toBeInTheDocument();
  });
});
