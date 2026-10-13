import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { renderWithProviders } from '../../utils/renderWithProviders';
import { DevicePage } from '@/app/Device/DevicePage';
import * as authHooks from '@/shared/auth/AuthProvider';
import * as api from '@/shared/api/index';

function mockAuth(overrides: Partial<ReturnType<typeof authHooks.useAuth>> = {}) {
  vi.spyOn(authHooks, 'useAuth').mockReturnValue({
    token: 'session-token',
    user: { id: 'usr_1', email: 'me@example.com' },
    loading: false,
    signInWithPassword: vi.fn(),
    registerWithPassword: vi.fn(),
    signOut: vi.fn(),
    ...overrides,
  } as ReturnType<typeof authHooks.useAuth>);
}

describe('DevicePage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('prompts to sign in when there is no session', () => {
    mockAuth({ token: null, user: null });
    renderWithProviders(<DevicePage />, { route: '/device', path: '/device' });
    expect(screen.getByText('Sign in to approve this device.')).toBeInTheDocument();
  });

  it('keeps Approve disabled until the code is looked up and the asking client is shown', async () => {
    mockAuth();
    vi.spyOn(api, 'getDeviceCodeStatus').mockResolvedValue({ client_id: 'agent-desktop' });
    renderWithProviders(<DevicePage />, { route: { pathname: '/device', search: '?code=ABCD-1234' }, path: '/device' });

    const approveButton = screen.getByRole('button', { name: 'Approve' });
    expect(approveButton).toBeDisabled();

    expect(await screen.findByText(/Agent Desktop/)).toBeInTheDocument();
    await waitFor(() => expect(approveButton).not.toBeDisabled());
  });

  it('never enables Approve for a code that fails to look up', async () => {
    mockAuth();
    vi.spyOn(api, 'getDeviceCodeStatus').mockRejectedValue(new Error('not found'));
    renderWithProviders(<DevicePage />, { route: { pathname: '/device', search: '?code=ZZZZ-ZZZZ' }, path: '/device' });

    expect(await screen.findByText(/unknown or has expired/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled();
  });

  it('calls approveDeviceCode only after a successful preview', async () => {
    mockAuth();
    vi.spyOn(api, 'getDeviceCodeStatus').mockResolvedValue({ client_id: 'agent-desktop' });
    const approveDeviceCode = vi.spyOn(api, 'approveDeviceCode').mockResolvedValue({ status: 'approved', email: 'me@example.com' });
    renderWithProviders(<DevicePage />, { route: { pathname: '/device', search: '?code=ABCD-1234' }, path: '/device' });

    const approveButton = await waitFor(() => {
      const button = screen.getByRole('button', { name: 'Approve' });
      expect(button).not.toBeDisabled();
      return button;
    });
    fireEvent.click(approveButton);

    await waitFor(() => expect(approveDeviceCode).toHaveBeenCalledWith('ABCD-1234', 'session-token'));
    expect(await screen.findByText(/Device approved/)).toBeInTheDocument();
  });
});
