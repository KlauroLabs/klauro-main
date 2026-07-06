import type { Address } from '../types/address';

const BASE_URL = '/api/addresss';

export async function fetchAddresss(): Promise<Address[]> {
  const response = await fetch(BASE_URL);
  return response.json();
}

export async function fetchAddress(id: string): Promise<Address> {
  const response = await fetch(`${BASE_URL}/${id}`);
  return response.json();
}

export async function createAddress(payload: Partial<Address>): Promise<Address> {
  const response = await fetch(BASE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return response.json();
}
