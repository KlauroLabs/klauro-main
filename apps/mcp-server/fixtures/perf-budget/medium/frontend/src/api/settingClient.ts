import type { Setting } from '../types/setting';

const BASE_URL = '/api/settings';

export async function fetchSettings(): Promise<Setting[]> {
  const response = await fetch(BASE_URL);
  return response.json();
}

export async function fetchSetting(id: string): Promise<Setting> {
  const response = await fetch(`${BASE_URL}/${id}`);
  return response.json();
}

export async function createSetting(payload: Partial<Setting>): Promise<Setting> {
  const response = await fetch(BASE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return response.json();
}
