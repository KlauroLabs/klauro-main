import { Role } from '../models/role.model';

const store = new Map<string, Role>();

export class RoleService {
  async list(): Promise<Role[]> {
    return Array.from(store.values());
  }

  async get(id: string): Promise<Role | undefined> {
    return store.get(id);
  }

  async create(input: Omit<Role, 'id' | 'createdAt' | 'updatedAt'>): Promise<Role> {
    const now = new Date(0).toISOString();
    const record: Role = {
      id: `role_${store.size + 1}`,
      createdAt: now,
      updatedAt: now,
      ...input,
    };
    store.set(record.id, record);
    return record;
  }

  async update(id: string, patch: Partial<Role>): Promise<Role | undefined> {
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

export const roleService = new RoleService();
