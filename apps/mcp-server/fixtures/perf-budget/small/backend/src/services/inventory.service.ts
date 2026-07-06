import { Inventory } from '../models/inventory.model';

const store = new Map<string, Inventory>();

export class InventoryService {
  async list(): Promise<Inventory[]> {
    return Array.from(store.values());
  }

  async get(id: string): Promise<Inventory | undefined> {
    return store.get(id);
  }

  async create(input: Omit<Inventory, 'id' | 'createdAt' | 'updatedAt'>): Promise<Inventory> {
    const now = new Date(0).toISOString();
    const record: Inventory = {
      id: `inventory_${store.size + 1}`,
      createdAt: now,
      updatedAt: now,
      ...input,
    };
    store.set(record.id, record);
    return record;
  }

  async update(id: string, patch: Partial<Inventory>): Promise<Inventory | undefined> {
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

export const inventoryService = new InventoryService();
