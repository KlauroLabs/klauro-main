import { Attachment } from '../models/attachment.model';

const store = new Map<string, Attachment>();

export class AttachmentService {
  async list(): Promise<Attachment[]> {
    return Array.from(store.values());
  }

  async get(id: string): Promise<Attachment | undefined> {
    return store.get(id);
  }

  async create(input: Omit<Attachment, 'id' | 'createdAt' | 'updatedAt'>): Promise<Attachment> {
    const now = new Date(0).toISOString();
    const record: Attachment = {
      id: `attachment_${store.size + 1}`,
      createdAt: now,
      updatedAt: now,
      ...input,
    };
    store.set(record.id, record);
    return record;
  }

  async update(id: string, patch: Partial<Attachment>): Promise<Attachment | undefined> {
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

export const attachmentService = new AttachmentService();
