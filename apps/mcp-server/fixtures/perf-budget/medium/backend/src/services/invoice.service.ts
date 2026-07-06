import { Invoice } from '../models/invoice.model';

const store = new Map<string, Invoice>();

export class InvoiceService {
  async list(): Promise<Invoice[]> {
    return Array.from(store.values());
  }

  async get(id: string): Promise<Invoice | undefined> {
    return store.get(id);
  }

  async create(input: Omit<Invoice, 'id' | 'createdAt' | 'updatedAt'>): Promise<Invoice> {
    const now = new Date(0).toISOString();
    const record: Invoice = {
      id: `invoice_${store.size + 1}`,
      createdAt: now,
      updatedAt: now,
      ...input,
    };
    store.set(record.id, record);
    return record;
  }

  async update(id: string, patch: Partial<Invoice>): Promise<Invoice | undefined> {
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

export const invoiceService = new InvoiceService();
