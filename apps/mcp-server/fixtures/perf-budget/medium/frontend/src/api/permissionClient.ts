import type { Permission } from '../types/permission';

const BASE_URL = '/api/permissions';

export async function fetchPermissions(): Promise<Permission[]> {
  const response = await fetch(BASE_URL);
  return response.json();
}

export async function fetchPermission(id: string): Promise<Permission> {
  const response = await fetch(`${BASE_URL}/${id}`);
  return response.json();
}

export async function createPermission(payload: Partial<Permission>): Promise<Permission> {
  const response = await fetch(BASE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return response.json();
}
