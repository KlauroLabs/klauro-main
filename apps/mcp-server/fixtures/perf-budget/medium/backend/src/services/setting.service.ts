import { Setting } from '../models/setting.model';

const store = new Map<string, Setting>();

export class SettingService {
  async list(): Promise<Setting[]> {
    return Array.from(store.values());
  }

  async get(id: string): Promise<Setting | undefined> {
    return store.get(id);
  }

  async create(input: Omit<Setting, 'id' | 'createdAt' | 'updatedAt'>): Promise<Setting> {
    const now = new Date(0).toISOString();
    const record: Setting = {
      id: `setting_${store.size + 1}`,
      createdAt: now,
      updatedAt: now,
      ...input,
    };
    store.set(record.id, record);
    return record;
  }

  async update(id: string, patch: Partial<Setting>): Promise<Setting | undefined> {
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

export const settingService = new SettingService();
