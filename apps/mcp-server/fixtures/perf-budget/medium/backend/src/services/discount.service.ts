import { Discount } from '../models/discount.model';

const store = new Map<string, Discount>();

export class DiscountService {
  async list(): Promise<Discount[]> {
    return Array.from(store.values());
  }

  async get(id: string): Promise<Discount | undefined> {
    return store.get(id);
  }

  async create(input: Omit<Discount, 'id' | 'createdAt' | 'updatedAt'>): Promise<Discount> {
    const now = new Date(0).toISOString();
    const record: Discount = {
      id: `discount_${store.size + 1}`,
      createdAt: now,
      updatedAt: now,
      ...input,
    };
    store.set(record.id, record);
    return record;
  }

  async update(id: string, patch: Partial<Discount>): Promise<Discount | undefined> {
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

export const discountService = new DiscountService();
