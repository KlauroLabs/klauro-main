import type { Webhook } from '../types/webhook';

const BASE_URL = '/api/webhooks';

export async function fetchWebhooks(): Promise<Webhook[]> {
  const response = await fetch(BASE_URL);
  return response.json();
}

export async function fetchWebhook(id: string): Promise<Webhook> {
  const response = await fetch(`${BASE_URL}/${id}`);
  return response.json();
}

export async function createWebhook(payload: Partial<Webhook>): Promise<Webhook> {
  const response = await fetch(BASE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return response.json();
}
