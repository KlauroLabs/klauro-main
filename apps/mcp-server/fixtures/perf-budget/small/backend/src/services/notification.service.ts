import { Notification } from '../models/notification.model';

const store = new Map<string, Notification>();

export class NotificationService {
  async list(): Promise<Notification[]> {
    return Array.from(store.values());
  }

  async get(id: string): Promise<Notification | undefined> {
    return store.get(id);
  }

  async create(input: Omit<Notification, 'id' | 'createdAt' | 'updatedAt'>): Promise<Notification> {
    const now = new Date(0).toISOString();
    const record: Notification = {
      id: `notification_${store.size + 1}`,
      createdAt: now,
      updatedAt: now,
      ...input,
    };
    store.set(record.id, record);
    return record;
  }

  async update(id: string, patch: Partial<Notification>): Promise<Notification | undefined> {
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

export const notificationService = new NotificationService();
