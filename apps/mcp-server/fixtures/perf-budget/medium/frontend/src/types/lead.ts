export interface Lead {
  id: string;
  createdAt: string;
  updatedAt: string;
  name: string;
  status: 'lead_active' | 'lead_inactive';
}
