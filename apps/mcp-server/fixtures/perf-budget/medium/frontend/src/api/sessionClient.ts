import type { Session } from '../types/session';

const BASE_URL = '/api/sessions';

export async function fetchSessions(): Promise<Session[]> {
  const response = await fetch(BASE_URL);
  return response.json();
}

export async function fetchSession(id: string): Promise<Session> {
  const response = await fetch(`${BASE_URL}/${id}`);
  return response.json();
}

export async function createSession(payload: Partial<Session>): Promise<Session> {
  const response = await fetch(BASE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return response.json();
}
