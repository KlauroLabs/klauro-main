import type { Warehouse } from '../types/warehouse';

const BASE_URL = '/api/warehouses';

export async function fetchWarehouses(): Promise<Warehouse[]> {
  const response = await fetch(BASE_URL);
  return response.json();
}

export async function fetchWarehouse(id: string): Promise<Warehouse> {
  const response = await fetch(`${BASE_URL}/${id}`);
  return response.json();
}

export async function createWarehouse(payload: Partial<Warehouse>): Promise<Warehouse> {
  const response = await fetch(BASE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return response.json();
}
