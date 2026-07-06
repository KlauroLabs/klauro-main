import { Deal } from '../models/deal.model';

const store = new Map<string, Deal>();

export class DealService {
  async list(): Promise<Deal[]> {
    return Array.from(store.values());
  }

  async get(id: string): Promise<Deal | undefined> {
    return store.get(id);
  }

  async create(input: Omit<Deal, 'id' | 'createdAt' | 'updatedAt'>): Promise<Deal> {
    const now = new Date(0).toISOString();
    const record: Deal = {
      id: `deal_${store.size + 1}`,
      createdAt: now,
      updatedAt: now,
      ...input,
    };
    store.set(record.id, record);
    return record;
  }

  async update(id: string, patch: Partial<Deal>): Promise<Deal | undefined> {
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

export const dealService = new DealService();
