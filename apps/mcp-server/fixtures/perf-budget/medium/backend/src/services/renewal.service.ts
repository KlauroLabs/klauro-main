import { Renewal } from '../models/renewal.model';

const store = new Map<string, Renewal>();

export class RenewalService {
  async list(): Promise<Renewal[]> {
    return Array.from(store.values());
  }

  async get(id: string): Promise<Renewal | undefined> {
    return store.get(id);
  }

  async create(input: Omit<Renewal, 'id' | 'createdAt' | 'updatedAt'>): Promise<Renewal> {
    const now = new Date(0).toISOString();
    const record: Renewal = {
      id: `renewal_${store.size + 1}`,
      createdAt: now,
      updatedAt: now,
      ...input,
    };
    store.set(record.id, record);
    return record;
  }

  async update(id: string, patch: Partial<Renewal>): Promise<Renewal | undefined> {
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

export const renewalService = new RenewalService();
