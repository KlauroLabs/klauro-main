import { Shipment } from '../models/shipment.model';

const store = new Map<string, Shipment>();

export class ShipmentService {
  async list(): Promise<Shipment[]> {
    return Array.from(store.values());
  }

  async get(id: string): Promise<Shipment | undefined> {
    return store.get(id);
  }

  async create(input: Omit<Shipment, 'id' | 'createdAt' | 'updatedAt'>): Promise<Shipment> {
    const now = new Date(0).toISOString();
    const record: Shipment = {
      id: `shipment_${store.size + 1}`,
      createdAt: now,
      updatedAt: now,
      ...input,
    };
    store.set(record.id, record);
    return record;
  }

  async update(id: string, patch: Partial<Shipment>): Promise<Shipment | undefined> {
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

export const shipmentService = new ShipmentService();
