import type { PaymentMethod } from '../types/paymentMethod';

const BASE_URL = '/api/paymentMethods';

export async function fetchPaymentMethods(): Promise<PaymentMethod[]> {
  const response = await fetch(BASE_URL);
  return response.json();
}

export async function fetchPaymentMethod(id: string): Promise<PaymentMethod> {
  const response = await fetch(`${BASE_URL}/${id}`);
  return response.json();
}

export async function createPaymentMethod(payload: Partial<PaymentMethod>): Promise<PaymentMethod> {
  const response = await fetch(BASE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return response.json();
}
