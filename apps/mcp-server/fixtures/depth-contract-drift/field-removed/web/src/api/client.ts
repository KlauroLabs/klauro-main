import { Order } from '../entities/order';
import { Coupon } from '../entities/coupon';
export async function loadOrder(id: string): Promise<Order> {
  const res = await fetch(`/api/orders/${id}`);
  return res.json();
}
export async function loadCoupon(id: string): Promise<Coupon> {
  const res = await fetch(`/api/coupons/${id}`);
  return res.json();
}
