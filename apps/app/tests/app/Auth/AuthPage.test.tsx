import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { render } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useSearchParams } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from '@/shared/auth/AuthProvider';
import { renderWithProviders } from '../../utils/renderWithProviders';
import { AuthPage } from '@/app/Auth/AuthPage';
import * as authHooks from '@/shared/auth/AuthProvider';

function mockAuth(overrides: Partial<ReturnType<typeof authHooks.useAuth>> = {}) {
  vi.spyOn(authHooks, 'useAuth').mockReturnValue({
    token: null,
    user: null,
    loading: false,
    signInWithPassword: vi.fn().mockResolvedValue(undefined),
    registerWithPassword: vi.fn().mockResolvedValue(undefined),
    signOut: vi.fn(),
    ...overrides,
  } as ReturnType<typeof authHooks.useAuth>);
}

// The "Sign in" mode toggle and the form's submit button both have the
// accessible name "Sign in" — disambiguate by the submit button's type.
function submitButton(): HTMLElement {
  return screen.getAllByRole('button', { name: /Sign in|Create account/ }).find(
    button => button.getAttribute('type') === 'submit',
  )!;
}

describe('AuthPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the sign-in form by default', () => {
    mockAuth();
    renderWithProviders(<AuthPage />, { route: '/auth', path: '/auth' });
    expect(screen.getByText('Sign in to Klauro')).toBeInTheDocument();
    expect(screen.getByLabelText(/Email/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/Workspace/i)).not.toBeInTheDocument();
  });

  it('switches to the register form and shows the extra fields', () => {
    mockAuth();
    renderWithProviders(<AuthPage />, { route: '/auth', path: '/auth' });
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    expect(screen.getByText('Create your account')).toBeInTheDocument();
    expect(screen.getByLabelText(/Workspace/i)).toBeInTheDocument();
  });

  it('calls signInWithPassword with the entered credentials on submit', async () => {
    const signInWithPassword = vi.fn().mockResolvedValue(undefined);
    mockAuth({ signInWithPassword });
    renderWithProviders(<AuthPage />, { route: '/auth', path: '/auth' });

    fireEvent.change(screen.getByLabelText(/Email/i), { target: { value: 'claudia@example.com' } });
    fireEvent.change(screen.getByLabelText(/Password/i), { target: { value: 'hunter22222' } });
    fireEvent.click(submitButton());

    await waitFor(() => expect(signInWithPassword).toHaveBeenCalledWith('claudia@example.com', 'hunter22222'));
  });

  it('shows an error message when sign-in fails', async () => {
    const signInWithPassword = vi.fn().mockRejectedValue(new Error('Invalid credentials'));
    mockAuth({ signInWithPassword });
    renderWithProviders(<AuthPage />, { route: '/auth', path: '/auth' });

    fireEvent.change(screen.getByLabelText(/Email/i), { target: { value: 'claudia@example.com' } });
    fireEvent.change(screen.getByLabelText(/Password/i), { target: { value: 'hunter22222' } });
    fireEvent.click(submitButton());

    expect(await screen.findByText('Invalid credentials')).toBeInTheDocument();
  });

  it('redirects back to the page that bounced here, search string included', async () => {
    const signInWithPassword = vi.fn().mockResolvedValue(undefined);
    mockAuth({ signInWithPassword });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    function DeviceStub() {
      const [params] = useSearchParams();
      return <div>device page code={params.get('code')}</div>;
    }
    render(
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <MemoryRouter initialEntries={[{ pathname: '/auth', state: { from: { pathname: '/device', search: '?code=ABCD-1234' } } }]}>
            <Routes>
              <Route path="/auth" element={<AuthPage />} />
              <Route path="/device" element={<DeviceStub />} />
            </Routes>
          </MemoryRouter>
        </AuthProvider>
      </QueryClientProvider>,
    );

    fireEvent.change(screen.getByLabelText(/Email/i), { target: { value: 'claudia@example.com' } });
    fireEvent.change(screen.getByLabelText(/Password/i), { target: { value: 'hunter22222' } });
    fireEvent.click(submitButton());

    expect(await screen.findByText('device page code=ABCD-1234')).toBeInTheDocument();
  });
});
