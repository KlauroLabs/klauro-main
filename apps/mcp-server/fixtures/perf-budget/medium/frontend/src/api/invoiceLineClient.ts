import type { InvoiceLine } from '../types/invoiceLine';

const BASE_URL = '/api/invoiceLines';

export async function fetchInvoiceLines(): Promise<InvoiceLine[]> {
  const response = await fetch(BASE_URL);
  return response.json();
}

export async function fetchInvoiceLine(id: string): Promise<InvoiceLine> {
  const response = await fetch(`${BASE_URL}/${id}`);
  return response.json();
}

export async function createInvoiceLine(payload: Partial<InvoiceLine>): Promise<InvoiceLine> {
  const response = await fetch(BASE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return response.json();
}
