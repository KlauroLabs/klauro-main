import type { Renewal } from '../types/renewal';

const BASE_URL = '/api/renewals';

export async function fetchRenewals(): Promise<Renewal[]> {
  const response = await fetch(BASE_URL);
  return response.json();
}

export async function fetchRenewal(id: string): Promise<Renewal> {
  const response = await fetch(`${BASE_URL}/${id}`);
  return response.json();
}

export async function createRenewal(payload: Partial<Renewal>): Promise<Renewal> {
  const response = await fetch(BASE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return response.json();
}
