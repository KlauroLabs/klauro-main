import type { Campaign } from '../types/campaign';

const BASE_URL = '/api/campaigns';

export async function fetchCampaigns(): Promise<Campaign[]> {
  const response = await fetch(BASE_URL);
  return response.json();
}

export async function fetchCampaign(id: string): Promise<Campaign> {
  const response = await fetch(`${BASE_URL}/${id}`);
  return response.json();
}

export async function createCampaign(payload: Partial<Campaign>): Promise<Campaign> {
  const response = await fetch(BASE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return response.json();
}
