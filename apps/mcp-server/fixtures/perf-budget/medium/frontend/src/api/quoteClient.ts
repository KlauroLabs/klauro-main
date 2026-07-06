import type { Quote } from '../types/quote';

const BASE_URL = '/api/quotes';

export async function fetchQuotes(): Promise<Quote[]> {
  const response = await fetch(BASE_URL);
  return response.json();
}

export async function fetchQuote(id: string): Promise<Quote> {
  const response = await fetch(`${BASE_URL}/${id}`);
  return response.json();
}

export async function createQuote(payload: Partial<Quote>): Promise<Quote> {
  const response = await fetch(BASE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return response.json();
}
