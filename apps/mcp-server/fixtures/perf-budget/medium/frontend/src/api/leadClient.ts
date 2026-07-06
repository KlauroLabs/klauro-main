import type { Lead } from '../types/lead';

const BASE_URL = '/api/leads';

export async function fetchLeads(): Promise<Lead[]> {
  const response = await fetch(BASE_URL);
  return response.json();
}

export async function fetchLead(id: string): Promise<Lead> {
  const response = await fetch(`${BASE_URL}/${id}`);
  return response.json();
}

export async function createLead(payload: Partial<Lead>): Promise<Lead> {
  const response = await fetch(BASE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return response.json();
}
