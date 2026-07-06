import type { Customer } from '../types/customer';

const BASE_URL = '/api/customers';

export async function fetchCustomers(): Promise<Customer[]> {
  const response = await fetch(BASE_URL);
  return response.json();
}

export async function fetchCustomer(id: string): Promise<Customer> {
  const response = await fetch(`${BASE_URL}/${id}`);
  return response.json();
}

export async function createCustomer(payload: Partial<Customer>): Promise<Customer> {
  const response = await fetch(BASE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return response.json();
}
