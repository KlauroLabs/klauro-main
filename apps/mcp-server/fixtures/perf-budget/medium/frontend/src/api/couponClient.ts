import type { Coupon } from '../types/coupon';

const BASE_URL = '/api/coupons';

export async function fetchCoupons(): Promise<Coupon[]> {
  const response = await fetch(BASE_URL);
  return response.json();
}

export async function fetchCoupon(id: string): Promise<Coupon> {
  const response = await fetch(`${BASE_URL}/${id}`);
  return response.json();
}

export async function createCoupon(payload: Partial<Coupon>): Promise<Coupon> {
  const response = await fetch(BASE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return response.json();
}
