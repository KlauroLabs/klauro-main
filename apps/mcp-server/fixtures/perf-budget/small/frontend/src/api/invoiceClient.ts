import type { Invoice } from '../types/invoice';

const BASE_URL = '/api/invoices';

export async function fetchInvoices(): Promise<Invoice[]> {
  const response = await fetch(BASE_URL);
  return response.json();
}

export async function fetchInvoice(id: string): Promise<Invoice> {
  const response = await fetch(`${BASE_URL}/${id}`);
  return response.json();
}

export async function createInvoice(payload: Partial<Invoice>): Promise<Invoice> {
  const response = await fetch(BASE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return response.json();
}
