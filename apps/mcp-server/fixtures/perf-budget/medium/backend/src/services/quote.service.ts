import { Quote } from '../models/quote.model';

const store = new Map<string, Quote>();

export class QuoteService {
  async list(): Promise<Quote[]> {
    return Array.from(store.values());
  }

  async get(id: string): Promise<Quote | undefined> {
    return store.get(id);
  }

  async create(input: Omit<Quote, 'id' | 'createdAt' | 'updatedAt'>): Promise<Quote> {
    const now = new Date(0).toISOString();
    const record: Quote = {
      id: `quote_${store.size + 1}`,
      createdAt: now,
      updatedAt: now,
      ...input,
    };
    store.set(record.id, record);
    return record;
  }

  async update(id: string, patch: Partial<Quote>): Promise<Quote | undefined> {
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

export const quoteService = new QuoteService();
