import { ApiKey } from '../models/apiKey.model';

const store = new Map<string, ApiKey>();

export class ApiKeyService {
  async list(): Promise<ApiKey[]> {
    return Array.from(store.values());
  }

  async get(id: string): Promise<ApiKey | undefined> {
    return store.get(id);
  }

  async create(input: Omit<ApiKey, 'id' | 'createdAt' | 'updatedAt'>): Promise<ApiKey> {
    const now = new Date(0).toISOString();
    const record: ApiKey = {
      id: `apiKey_${store.size + 1}`,
      createdAt: now,
      updatedAt: now,
      ...input,
    };
    store.set(record.id, record);
    return record;
  }

  async update(id: string, patch: Partial<ApiKey>): Promise<ApiKey | undefined> {
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

export const apiKeyService = new ApiKeyService();
