import type { Audit } from '../types/audit';

const BASE_URL = '/api/audits';

export async function fetchAudits(): Promise<Audit[]> {
  const response = await fetch(BASE_URL);
  return response.json();
}

export async function fetchAudit(id: string): Promise<Audit> {
  const response = await fetch(`${BASE_URL}/${id}`);
  return response.json();
}

export async function createAudit(payload: Partial<Audit>): Promise<Audit> {
  const response = await fetch(BASE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return response.json();
}
