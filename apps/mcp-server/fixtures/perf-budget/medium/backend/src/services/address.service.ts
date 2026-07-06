import { Address } from '../models/address.model';

const store = new Map<string, Address>();

export class AddressService {
  async list(): Promise<Address[]> {
    return Array.from(store.values());
  }

  async get(id: string): Promise<Address | undefined> {
    return store.get(id);
  }

  async create(input: Omit<Address, 'id' | 'createdAt' | 'updatedAt'>): Promise<Address> {
    const now = new Date(0).toISOString();
    const record: Address = {
      id: `address_${store.size + 1}`,
      createdAt: now,
      updatedAt: now,
      ...input,
    };
    store.set(record.id, record);
    return record;
  }

  async update(id: string, patch: Partial<Address>): Promise<Address | undefined> {
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

export const addressService = new AddressService();
