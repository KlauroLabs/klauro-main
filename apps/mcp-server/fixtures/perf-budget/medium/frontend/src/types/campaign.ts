export interface Campaign {
  id: string;
  createdAt: string;
  updatedAt: string;
  name: string;
  status: 'campaign_active' | 'campaign_inactive';
}
