import type { Contract } from '../types/contract';

const BASE_URL = '/api/contracts';

export async function fetchContracts(): Promise<Contract[]> {
  const response = await fetch(BASE_URL);
  return response.json();
}

export async function fetchContract(id: string): Promise<Contract> {
  const response = await fetch(`${BASE_URL}/${id}`);
  return response.json();
}

export async function createContract(payload: Partial<Contract>): Promise<Contract> {
  const response = await fetch(BASE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return response.json();
}
