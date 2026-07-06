export interface Coupon {
  id: string;
  createdAt: string;
  updatedAt: string;
  name: string;
  status: 'coupon_active' | 'coupon_inactive';
}
