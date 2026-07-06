export interface Deal {
  id: string;
  createdAt: string;
  updatedAt: string;
  name: string;
  status: 'deal_active' | 'deal_inactive';
}
