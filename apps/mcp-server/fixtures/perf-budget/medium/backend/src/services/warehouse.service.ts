import { Warehouse } from '../models/warehouse.model';

const store = new Map<string, Warehouse>();

export class WarehouseService {
  async list(): Promise<Warehouse[]> {
    return Array.from(store.values());
  }

  async get(id: string): Promise<Warehouse | undefined> {
    return store.get(id);
  }

  async create(input: Omit<Warehouse, 'id' | 'createdAt' | 'updatedAt'>): Promise<Warehouse> {
    const now = new Date(0).toISOString();
    const record: Warehouse = {
      id: `warehouse_${store.size + 1}`,
      createdAt: now,
      updatedAt: now,
      ...input,
    };
    store.set(record.id, record);
    return record;
  }

  async update(id: string, patch: Partial<Warehouse>): Promise<Warehouse | undefined> {
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

export const warehouseService = new WarehouseService();
