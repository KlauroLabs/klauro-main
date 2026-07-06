export interface Coupon {
  id: string;
  createdAt: string;
  updatedAt: string;
  name: string;
  status: 'coupon_active' | 'coupon_inactive';
}

export function isCoupon(value: unknown): value is Coupon {
  return typeof value === 'object' && value !== null && 'id' in value;
}
