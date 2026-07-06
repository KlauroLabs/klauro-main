export interface Payment {
  id: string;
  createdAt: string;
  updatedAt: string;
  name: string;
  status: 'payment_active' | 'payment_inactive';
}
