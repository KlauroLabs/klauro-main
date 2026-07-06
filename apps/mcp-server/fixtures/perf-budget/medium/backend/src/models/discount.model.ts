export interface Discount {
  id: string;
  createdAt: string;
  updatedAt: string;
  name: string;
  status: 'discount_active' | 'discount_inactive';
}

export function isDiscount(value: unknown): value is Discount {
  return typeof value === 'object' && value !== null && 'id' in value;
}
