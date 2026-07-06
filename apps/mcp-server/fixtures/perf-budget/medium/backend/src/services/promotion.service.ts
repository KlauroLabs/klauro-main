import { Promotion } from '../models/promotion.model';

const store = new Map<string, Promotion>();

export class PromotionService {
  async list(): Promise<Promotion[]> {
    return Array.from(store.values());
  }

  async get(id: string): Promise<Promotion | undefined> {
    return store.get(id);
  }

  async create(input: Omit<Promotion, 'id' | 'createdAt' | 'updatedAt'>): Promise<Promotion> {
    const now = new Date(0).toISOString();
    const record: Promotion = {
      id: `promotion_${store.size + 1}`,
      createdAt: now,
      updatedAt: now,
      ...input,
    };
    store.set(record.id, record);
    return record;
  }

  async update(id: string, patch: Partial<Promotion>): Promise<Promotion | undefined> {
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

export const promotionService = new PromotionService();
