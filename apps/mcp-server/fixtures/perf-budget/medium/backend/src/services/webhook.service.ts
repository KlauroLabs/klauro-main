import { Webhook } from '../models/webhook.model';

const store = new Map<string, Webhook>();

export class WebhookService {
  async list(): Promise<Webhook[]> {
    return Array.from(store.values());
  }

  async get(id: string): Promise<Webhook | undefined> {
    return store.get(id);
  }

  async create(input: Omit<Webhook, 'id' | 'createdAt' | 'updatedAt'>): Promise<Webhook> {
    const now = new Date(0).toISOString();
    const record: Webhook = {
      id: `webhook_${store.size + 1}`,
      createdAt: now,
      updatedAt: now,
      ...input,
    };
    store.set(record.id, record);
    return record;
  }

  async update(id: string, patch: Partial<Webhook>): Promise<Webhook | undefined> {
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

export const webhookService = new WebhookService();
