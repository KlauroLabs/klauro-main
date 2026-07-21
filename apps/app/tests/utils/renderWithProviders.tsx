import type { ReactElement } from 'react';
import { render } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from '@/shared/auth/AuthProvider';

/**
 * Shared test harness: auth + routing + a fresh react-query client per
 * render, so page tests don't need to hand-roll providers. AuthProvider is
 * included because several slug-resolution hooks (useResolvedProjectId,
 * useResolvedWorkspaceId — src/lib/slugs.ts's route-param resolution) call
 * useWorkspaces(), which calls useAuth() unconditionally. With no token in
 * test-environment localStorage, AuthProvider resolves to `token: null`
 * synchronously (no network call), so useWorkspaces stays `enabled: false`
 * and these hooks fall back to the raw route param exactly as before —
 * this only satisfies the context requirement, it changes no test behavior.
 */
export function renderWithProviders(ui: ReactElement, { route = '/', path = '/' }: { route?: string; path?: string } = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <MemoryRouter initialEntries={[route]}>
          <Routes>
            <Route path={path} element={ui} />
          </Routes>
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  );
}
