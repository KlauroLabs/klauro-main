import type { Discount } from '../types/discount';

const BASE_URL = '/api/discounts';

export async function fetchDiscounts(): Promise<Discount[]> {
  const response = await fetch(BASE_URL);
  return response.json();
}

export async function fetchDiscount(id: string): Promise<Discount> {
  const response = await fetch(`${BASE_URL}/${id}`);
  return response.json();
}

export async function createDiscount(payload: Partial<Discount>): Promise<Discount> {
  const response = await fetch(BASE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return response.json();
}
