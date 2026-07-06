import { Tag } from '../models/tag.model';

const store = new Map<string, Tag>();

export class TagService {
  async list(): Promise<Tag[]> {
    return Array.from(store.values());
  }

  async get(id: string): Promise<Tag | undefined> {
    return store.get(id);
  }

  async create(input: Omit<Tag, 'id' | 'createdAt' | 'updatedAt'>): Promise<Tag> {
    const now = new Date(0).toISOString();
    const record: Tag = {
      id: `tag_${store.size + 1}`,
      createdAt: now,
      updatedAt: now,
      ...input,
    };
    store.set(record.id, record);
    return record;
  }

  async update(id: string, patch: Partial<Tag>): Promise<Tag | undefined> {
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

export const tagService = new TagService();
