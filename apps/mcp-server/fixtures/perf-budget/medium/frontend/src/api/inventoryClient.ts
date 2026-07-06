import type { Inventory } from '../types/inventory';

const BASE_URL = '/api/inventorys';

export async function fetchInventorys(): Promise<Inventory[]> {
  const response = await fetch(BASE_URL);
  return response.json();
}

export async function fetchInventory(id: string): Promise<Inventory> {
  const response = await fetch(`${BASE_URL}/${id}`);
  return response.json();
}

export async function createInventory(payload: Partial<Inventory>): Promise<Inventory> {
  const response = await fetch(BASE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return response.json();
}
