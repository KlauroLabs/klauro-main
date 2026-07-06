import { Category } from '../models/category.model';

const store = new Map<string, Category>();

export class CategoryService {
  async list(): Promise<Category[]> {
    return Array.from(store.values());
  }

  async get(id: string): Promise<Category | undefined> {
    return store.get(id);
  }

  async create(input: Omit<Category, 'id' | 'createdAt' | 'updatedAt'>): Promise<Category> {
    const now = new Date(0).toISOString();
    const record: Category = {
      id: `category_${store.size + 1}`,
      createdAt: now,
      updatedAt: now,
      ...input,
    };
    store.set(record.id, record);
    return record;
  }

  async update(id: string, patch: Partial<Category>): Promise<Category | undefined> {
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

export const categoryService = new CategoryService();
