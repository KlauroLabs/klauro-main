export interface Product {
  id: string;
  createdAt: string;
  updatedAt: string;
  name: string;
  status: 'product_active' | 'product_inactive';
}
