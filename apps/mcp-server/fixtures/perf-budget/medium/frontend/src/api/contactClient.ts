import type { Contact } from '../types/contact';

const BASE_URL = '/api/contacts';

export async function fetchContacts(): Promise<Contact[]> {
  const response = await fetch(BASE_URL);
  return response.json();
}

export async function fetchContact(id: string): Promise<Contact> {
  const response = await fetch(`${BASE_URL}/${id}`);
  return response.json();
}

export async function createContact(payload: Partial<Contact>): Promise<Contact> {
  const response = await fetch(BASE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return response.json();
}
