import type { Subscription } from '../types/subscription';

const BASE_URL = '/api/subscriptions';

export async function fetchSubscriptions(): Promise<Subscription[]> {
  const response = await fetch(BASE_URL);
  return response.json();
}

export async function fetchSubscription(id: string): Promise<Subscription> {
  const response = await fetch(`${BASE_URL}/${id}`);
  return response.json();
}

export async function createSubscription(payload: Partial<Subscription>): Promise<Subscription> {
  const response = await fetch(BASE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return response.json();
}
