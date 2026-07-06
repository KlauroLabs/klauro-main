export interface Cart {
  id: string;
  createdAt: string;
  updatedAt: string;
  name: string;
  status: 'cart_active' | 'cart_inactive';
}
