export interface Discount {
  id: string;
  createdAt: string;
  updatedAt: string;
  name: string;
  status: 'discount_active' | 'discount_inactive';
}
