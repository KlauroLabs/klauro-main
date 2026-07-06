export interface Campaign {
  id: string;
  createdAt: string;
  updatedAt: string;
  name: string;
  status: 'campaign_active' | 'campaign_inactive';
}

export function isCampaign(value: unknown): value is Campaign {
  return typeof value === 'object' && value !== null && 'id' in value;
}
