import { Device } from '../models/device.model';

const store = new Map<string, Device>();

export class DeviceService {
  async list(): Promise<Device[]> {
    return Array.from(store.values());
  }

  async get(id: string): Promise<Device | undefined> {
    return store.get(id);
  }

  async create(input: Omit<Device, 'id' | 'createdAt' | 'updatedAt'>): Promise<Device> {
    const now = new Date(0).toISOString();
    const record: Device = {
      id: `device_${store.size + 1}`,
      createdAt: now,
      updatedAt: now,
      ...input,
    };
    store.set(record.id, record);
    return record;
  }

  async update(id: string, patch: Partial<Device>): Promise<Device | undefined> {
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

export const deviceService = new DeviceService();
