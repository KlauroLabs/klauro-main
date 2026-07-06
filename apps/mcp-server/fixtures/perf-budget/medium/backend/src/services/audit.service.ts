import { Audit } from '../models/audit.model';

const store = new Map<string, Audit>();

export class AuditService {
  async list(): Promise<Audit[]> {
    return Array.from(store.values());
  }

  async get(id: string): Promise<Audit | undefined> {
    return store.get(id);
  }

  async create(input: Omit<Audit, 'id' | 'createdAt' | 'updatedAt'>): Promise<Audit> {
    const now = new Date(0).toISOString();
    const record: Audit = {
      id: `audit_${store.size + 1}`,
      createdAt: now,
      updatedAt: now,
      ...input,
    };
    store.set(record.id, record);
    return record;
  }

  async update(id: string, patch: Partial<Audit>): Promise<Audit | undefined> {
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

export const auditService = new AuditService();
