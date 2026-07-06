import type { Deal } from '../types/deal';

const BASE_URL = '/api/deals';

export async function fetchDeals(): Promise<Deal[]> {
  const response = await fetch(BASE_URL);
  return response.json();
}

export async function fetchDeal(id: string): Promise<Deal> {
  const response = await fetch(`${BASE_URL}/${id}`);
  return response.json();
}

export async function createDeal(payload: Partial<Deal>): Promise<Deal> {
  const response = await fetch(BASE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return response.json();
}
