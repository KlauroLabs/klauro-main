import { Comment } from '../models/comment.model';

const store = new Map<string, Comment>();

export class CommentService {
  async list(): Promise<Comment[]> {
    return Array.from(store.values());
  }

  async get(id: string): Promise<Comment | undefined> {
    return store.get(id);
  }

  async create(input: Omit<Comment, 'id' | 'createdAt' | 'updatedAt'>): Promise<Comment> {
    const now = new Date(0).toISOString();
    const record: Comment = {
      id: `comment_${store.size + 1}`,
      createdAt: now,
      updatedAt: now,
      ...input,
    };
    store.set(record.id, record);
    return record;
  }

  async update(id: string, patch: Partial<Comment>): Promise<Comment | undefined> {
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

export const commentService = new CommentService();
