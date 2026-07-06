import type { Order } from '../types/order';

const BASE_URL = '/api/orders';

export async function fetchOrders(): Promise<Order[]> {
  const response = await fetch(BASE_URL);
  return response.json();
}

export async function fetchOrder(id: string): Promise<Order> {
  const response = await fetch(`${BASE_URL}/${id}`);
  return response.json();
}

export async function createOrder(payload: Partial<Order>): Promise<Order> {
  const response = await fetch(BASE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return response.json();
}
