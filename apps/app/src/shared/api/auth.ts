import { apiRequest } from './client';

export interface SessionUser {
  id: string;
  email: string;
  name?: string;
}

export interface Session {
  token: string;
  user: SessionUser;
}

export function signIn(email: string, password: string): Promise<Session> {
  return apiRequest<Session>('/api/auth/login', '', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
}

export function registerAccount(input: { email: string; name?: string; password: string; workspace_name?: string }): Promise<Session> {
  return apiRequest<Session>('/api/auth/register', '', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}
