export interface Renewal {
  id: string;
  createdAt: string;
  updatedAt: string;
  name: string;
  status: 'renewal_active' | 'renewal_inactive';
}
