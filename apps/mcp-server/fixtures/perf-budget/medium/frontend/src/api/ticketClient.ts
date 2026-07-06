import type { Ticket } from '../types/ticket';

const BASE_URL = '/api/tickets';

export async function fetchTickets(): Promise<Ticket[]> {
  const response = await fetch(BASE_URL);
  return response.json();
}

export async function fetchTicket(id: string): Promise<Ticket> {
  const response = await fetch(`${BASE_URL}/${id}`);
  return response.json();
}

export async function createTicket(payload: Partial<Ticket>): Promise<Ticket> {
  const response = await fetch(BASE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return response.json();
}
