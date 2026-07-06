import { Review } from '../models/review.model';

const store = new Map<string, Review>();

export class ReviewService {
  async list(): Promise<Review[]> {
    return Array.from(store.values());
  }

  async get(id: string): Promise<Review | undefined> {
    return store.get(id);
  }

  async create(input: Omit<Review, 'id' | 'createdAt' | 'updatedAt'>): Promise<Review> {
    const now = new Date(0).toISOString();
    const record: Review = {
      id: `review_${store.size + 1}`,
      createdAt: now,
      updatedAt: now,
      ...input,
    };
    store.set(record.id, record);
    return record;
  }

  async update(id: string, patch: Partial<Review>): Promise<Review | undefined> {
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

export const reviewService = new ReviewService();
