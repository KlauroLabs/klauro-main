export interface Address {
  id: string;
  createdAt: string;
  updatedAt: string;
  name: string;
  status: 'address_active' | 'address_inactive';
}
