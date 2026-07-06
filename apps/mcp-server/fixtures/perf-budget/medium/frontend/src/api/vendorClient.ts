import type { Vendor } from '../types/vendor';

const BASE_URL = '/api/vendors';

export async function fetchVendors(): Promise<Vendor[]> {
  const response = await fetch(BASE_URL);
  return response.json();
}

export async function fetchVendor(id: string): Promise<Vendor> {
  const response = await fetch(`${BASE_URL}/${id}`);
  return response.json();
}

export async function createVendor(payload: Partial<Vendor>): Promise<Vendor> {
  const response = await fetch(BASE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return response.json();
}
