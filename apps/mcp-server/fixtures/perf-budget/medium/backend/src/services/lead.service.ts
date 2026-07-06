import { Lead } from '../models/lead.model';

const store = new Map<string, Lead>();

export class LeadService {
  async list(): Promise<Lead[]> {
    return Array.from(store.values());
  }

  async get(id: string): Promise<Lead | undefined> {
    return store.get(id);
  }

  async create(input: Omit<Lead, 'id' | 'createdAt' | 'updatedAt'>): Promise<Lead> {
    const now = new Date(0).toISOString();
    const record: Lead = {
      id: `lead_${store.size + 1}`,
      createdAt: now,
      updatedAt: now,
      ...input,
    };
    store.set(record.id, record);
    return record;
  }

  async update(id: string, patch: Partial<Lead>): Promise<Lead | undefined> {
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

export const leadService = new LeadService();
