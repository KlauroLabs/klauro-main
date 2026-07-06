import type { Refund } from '../types/refund';

const BASE_URL = '/api/refunds';

export async function fetchRefunds(): Promise<Refund[]> {
  const response = await fetch(BASE_URL);
  return response.json();
}

export async function fetchRefund(id: string): Promise<Refund> {
  const response = await fetch(`${BASE_URL}/${id}`);
  return response.json();
}

export async function createRefund(payload: Partial<Refund>): Promise<Refund> {
  const response = await fetch(BASE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return response.json();
}
