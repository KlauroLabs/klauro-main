import { Subscription } from '../models/subscription.model';

const store = new Map<string, Subscription>();

export class SubscriptionService {
  async list(): Promise<Subscription[]> {
    return Array.from(store.values());
  }

  async get(id: string): Promise<Subscription | undefined> {
    return store.get(id);
  }

  async create(input: Omit<Subscription, 'id' | 'createdAt' | 'updatedAt'>): Promise<Subscription> {
    const now = new Date(0).toISOString();
    const record: Subscription = {
      id: `subscription_${store.size + 1}`,
      createdAt: now,
      updatedAt: now,
      ...input,
    };
    store.set(record.id, record);
    return record;
  }

  async update(id: string, patch: Partial<Subscription>): Promise<Subscription | undefined> {
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

export const subscriptionService = new SubscriptionService();
