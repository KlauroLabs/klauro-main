import { describe, expect, it, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { App } from '../main';

describe('auth gate', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('renders only the auth view when there is no session token', () => {
    render(<App />);
    // The sign-in view must be present…
    expect(screen.getByText('Sign in to Klauro')).toBeInTheDocument();
    // …and none of the authenticated dashboard shell (sidebar nav, workspace
    // list, sign-out avatar) may be reachable behind it. This is the
    // regression the auth-gate refactor in main.tsx guards: an unauthenticated
    // visitor must never see a signed-in-looking product.
    expect(screen.queryByText('Add Workspace')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /sign out/i })).not.toBeInTheDocument();
    expect(screen.queryByText('Good morning')).not.toBeInTheDocument();
    expect(document.querySelector('.sidebar')).not.toBeInTheDocument();
  });
});
