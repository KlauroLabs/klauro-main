import type { User } from '../types/user';

const BASE_URL = '/api/users';

export async function fetchUsers(): Promise<User[]> {
  const response = await fetch(BASE_URL);
  return response.json();
}

export async function fetchUser(id: string): Promise<User> {
  const response = await fetch(`${BASE_URL}/${id}`);
  return response.json();
}

export async function createUser(payload: Partial<User>): Promise<User> {
  const response = await fetch(BASE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return response.json();
}
