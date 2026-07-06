import type { Promotion } from '../types/promotion';

const BASE_URL = '/api/promotions';

export async function fetchPromotions(): Promise<Promotion[]> {
  const response = await fetch(BASE_URL);
  return response.json();
}

export async function fetchPromotion(id: string): Promise<Promotion> {
  const response = await fetch(`${BASE_URL}/${id}`);
  return response.json();
}

export async function createPromotion(payload: Partial<Promotion>): Promise<Promotion> {
  const response = await fetch(BASE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return response.json();
}
