export interface Order {
  id: string;
  createdAt: string;
  updatedAt: string;
  name: string;
  status: 'order_active' | 'order_inactive';
}
