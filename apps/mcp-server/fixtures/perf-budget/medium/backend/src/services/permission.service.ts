import { Permission } from '../models/permission.model';

const store = new Map<string, Permission>();

export class PermissionService {
  async list(): Promise<Permission[]> {
    return Array.from(store.values());
  }

  async get(id: string): Promise<Permission | undefined> {
    return store.get(id);
  }

  async create(input: Omit<Permission, 'id' | 'createdAt' | 'updatedAt'>): Promise<Permission> {
    const now = new Date(0).toISOString();
    const record: Permission = {
      id: `permission_${store.size + 1}`,
      createdAt: now,
      updatedAt: now,
      ...input,
    };
    store.set(record.id, record);
    return record;
  }

  async update(id: string, patch: Partial<Permission>): Promise<Permission | undefined> {
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

export const permissionService = new PermissionService();
