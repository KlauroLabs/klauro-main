import { Vendor } from '../models/vendor.model';

const store = new Map<string, Vendor>();

export class VendorService {
  async list(): Promise<Vendor[]> {
    return Array.from(store.values());
  }

  async get(id: string): Promise<Vendor | undefined> {
    return store.get(id);
  }

  async create(input: Omit<Vendor, 'id' | 'createdAt' | 'updatedAt'>): Promise<Vendor> {
    const now = new Date(0).toISOString();
    const record: Vendor = {
      id: `vendor_${store.size + 1}`,
      createdAt: now,
      updatedAt: now,
      ...input,
    };
    store.set(record.id, record);
    return record;
  }

  async update(id: string, patch: Partial<Vendor>): Promise<Vendor | undefined> {
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

export const vendorService = new VendorService();
