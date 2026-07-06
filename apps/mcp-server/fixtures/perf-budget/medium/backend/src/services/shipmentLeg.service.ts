import { ShipmentLeg } from '../models/shipmentLeg.model';

const store = new Map<string, ShipmentLeg>();

export class ShipmentLegService {
  async list(): Promise<ShipmentLeg[]> {
    return Array.from(store.values());
  }

  async get(id: string): Promise<ShipmentLeg | undefined> {
    return store.get(id);
  }

  async create(input: Omit<ShipmentLeg, 'id' | 'createdAt' | 'updatedAt'>): Promise<ShipmentLeg> {
    const now = new Date(0).toISOString();
    const record: ShipmentLeg = {
      id: `shipmentLeg_${store.size + 1}`,
      createdAt: now,
      updatedAt: now,
      ...input,
    };
    store.set(record.id, record);
    return record;
  }

  async update(id: string, patch: Partial<ShipmentLeg>): Promise<ShipmentLeg | undefined> {
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

export const shipmentLegService = new ShipmentLegService();
