import { Contact } from '../models/contact.model';

const store = new Map<string, Contact>();

export class ContactService {
  async list(): Promise<Contact[]> {
    return Array.from(store.values());
  }

  async get(id: string): Promise<Contact | undefined> {
    return store.get(id);
  }

  async create(input: Omit<Contact, 'id' | 'createdAt' | 'updatedAt'>): Promise<Contact> {
    const now = new Date(0).toISOString();
    const record: Contact = {
      id: `contact_${store.size + 1}`,
      createdAt: now,
      updatedAt: now,
      ...input,
    };
    store.set(record.id, record);
    return record;
  }

  async update(id: string, patch: Partial<Contact>): Promise<Contact | undefined> {
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

export const contactService = new ContactService();
