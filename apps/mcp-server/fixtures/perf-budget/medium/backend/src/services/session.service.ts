import { Session } from '../models/session.model';

const store = new Map<string, Session>();

export class SessionService {
  async list(): Promise<Session[]> {
    return Array.from(store.values());
  }

  async get(id: string): Promise<Session | undefined> {
    return store.get(id);
  }

  async create(input: Omit<Session, 'id' | 'createdAt' | 'updatedAt'>): Promise<Session> {
    const now = new Date(0).toISOString();
    const record: Session = {
      id: `session_${store.size + 1}`,
      createdAt: now,
      updatedAt: now,
      ...input,
    };
    store.set(record.id, record);
    return record;
  }

  async update(id: string, patch: Partial<Session>): Promise<Session | undefined> {
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

export const sessionService = new SessionService();
