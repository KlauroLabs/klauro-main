import type { Role } from '../types/role';

const BASE_URL = '/api/roles';

export async function fetchRoles(): Promise<Role[]> {
  const response = await fetch(BASE_URL);
  return response.json();
}

export async function fetchRole(id: string): Promise<Role> {
  const response = await fetch(`${BASE_URL}/${id}`);
  return response.json();
}

export async function createRole(payload: Partial<Role>): Promise<Role> {
  const response = await fetch(BASE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return response.json();
}
