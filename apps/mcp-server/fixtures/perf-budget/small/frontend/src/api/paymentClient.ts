import type { Payment } from '../types/payment';

const BASE_URL = '/api/payments';

export async function fetchPayments(): Promise<Payment[]> {
  const response = await fetch(BASE_URL);
  return response.json();
}

export async function fetchPayment(id: string): Promise<Payment> {
  const response = await fetch(`${BASE_URL}/${id}`);
  return response.json();
}

export async function createPayment(payload: Partial<Payment>): Promise<Payment> {
  const response = await fetch(BASE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return response.json();
}
