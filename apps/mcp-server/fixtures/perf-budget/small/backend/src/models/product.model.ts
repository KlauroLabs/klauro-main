export interface Product {
  id: string;
  createdAt: string;
  updatedAt: string;
  name: string;
  status: 'product_active' | 'product_inactive';
}

export function isProduct(value: unknown): value is Product {
  return typeof value === 'object' && value !== null && 'id' in value;
}
