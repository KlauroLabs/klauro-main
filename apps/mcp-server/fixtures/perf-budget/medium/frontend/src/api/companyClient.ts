import type { Company } from '../types/company';

const BASE_URL = '/api/companys';

export async function fetchCompanys(): Promise<Company[]> {
  const response = await fetch(BASE_URL);
  return response.json();
}

export async function fetchCompany(id: string): Promise<Company> {
  const response = await fetch(`${BASE_URL}/${id}`);
  return response.json();
}

export async function createCompany(payload: Partial<Company>): Promise<Company> {
  const response = await fetch(BASE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return response.json();
}
