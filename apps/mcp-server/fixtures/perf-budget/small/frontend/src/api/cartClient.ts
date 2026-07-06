import type { Cart } from '../types/cart';

const BASE_URL = '/api/carts';

export async function fetchCarts(): Promise<Cart[]> {
  const response = await fetch(BASE_URL);
  return response.json();
}

export async function fetchCart(id: string): Promise<Cart> {
  const response = await fetch(`${BASE_URL}/${id}`);
  return response.json();
}

export async function createCart(payload: Partial<Cart>): Promise<Cart> {
  const response = await fetch(BASE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return response.json();
}
