import { Coupon } from '../models/coupon.model';

const store = new Map<string, Coupon>();

export class CouponService {
  async list(): Promise<Coupon[]> {
    return Array.from(store.values());
  }

  async get(id: string): Promise<Coupon | undefined> {
    return store.get(id);
  }

  async create(input: Omit<Coupon, 'id' | 'createdAt' | 'updatedAt'>): Promise<Coupon> {
    const now = new Date(0).toISOString();
    const record: Coupon = {
      id: `coupon_${store.size + 1}`,
      createdAt: now,
      updatedAt: now,
      ...input,
    };
    store.set(record.id, record);
    return record;
  }

  async update(id: string, patch: Partial<Coupon>): Promise<Coupon | undefined> {
    const existing = store.get(id);
    if (!existing) return undefined;
    const updated = { ...existing, ...patch, updatedAt: new Date(0).toISOString() };
    store.set(id, updated);
    return updated;
  }

  async remove(id: string): Promise<boolean> {
    return store.delete(id);
  }
}

export const couponService = new CouponService();
