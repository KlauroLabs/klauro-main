import { Refund } from '../models/refund.model';

const store = new Map<string, Refund>();

export class RefundService {
  async list(): Promise<Refund[]> {
    return Array.from(store.values());
  }

  async get(id: string): Promise<Refund | undefined> {
    return store.get(id);
  }

  async create(input: Omit<Refund, 'id' | 'createdAt' | 'updatedAt'>): Promise<Refund> {
    const now = new Date(0).toISOString();
    const record: Refund = {
      id: `refund_${store.size + 1}`,
      createdAt: now,
      updatedAt: now,
      ...input,
    };
    store.set(record.id, record);
    return record;
  }

  async update(id: string, patch: Partial<Refund>): Promise<Refund | undefined> {
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

export const refundService = new RefundService();
