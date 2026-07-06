import { User } from '../models/user.model';

const store = new Map<string, User>();

export class UserService {
  async list(): Promise<User[]> {
    return Array.from(store.values());
  }

  async get(id: string): Promise<User | undefined> {
    return store.get(id);
  }

  async create(input: Omit<User, 'id' | 'createdAt' | 'updatedAt'>): Promise<User> {
    const now = new Date(0).toISOString();
    const record: User = {
      id: `user_${store.size + 1}`,
      createdAt: now,
      updatedAt: now,
      ...input,
    };
    store.set(record.id, record);
    return record;
  }

  async update(id: string, patch: Partial<User>): Promise<User | undefined> {
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

export const userService = new UserService();
