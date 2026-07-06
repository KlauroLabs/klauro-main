export interface Cart {
  id: string;
  createdAt: string;
  updatedAt: string;
  name: string;
  status: 'cart_active' | 'cart_inactive';
}

export function isCart(value: unknown): value is Cart {
  return typeof value === 'object' && value !== null && 'id' in value;
}
