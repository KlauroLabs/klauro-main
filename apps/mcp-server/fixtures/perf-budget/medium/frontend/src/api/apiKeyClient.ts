import type { ApiKey } from '../types/apiKey';

const BASE_URL = '/api/apiKeys';

export async function fetchApiKeys(): Promise<ApiKey[]> {
  const response = await fetch(BASE_URL);
  return response.json();
}

export async function fetchApiKey(id: string): Promise<ApiKey> {
  const response = await fetch(`${BASE_URL}/${id}`);
  return response.json();
}

export async function createApiKey(payload: Partial<ApiKey>): Promise<ApiKey> {
  const response = await fetch(BASE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return response.json();
}
