export interface Customer {
  id: string;
  createdAt: string;
  updatedAt: string;
  name: string;
  status: 'customer_active' | 'customer_inactive';
}
