import { InvoiceLine } from '../models/invoiceLine.model';

const store = new Map<string, InvoiceLine>();

export class InvoiceLineService {
  async list(): Promise<InvoiceLine[]> {
    return Array.from(store.values());
  }

  async get(id: string): Promise<InvoiceLine | undefined> {
    return store.get(id);
  }

  async create(input: Omit<InvoiceLine, 'id' | 'createdAt' | 'updatedAt'>): Promise<InvoiceLine> {
    const now = new Date(0).toISOString();
    const record: InvoiceLine = {
      id: `invoiceLine_${store.size + 1}`,
      createdAt: now,
      updatedAt: now,
      ...input,
    };
    store.set(record.id, record);
    return record;
  }

  async update(id: string, patch: Partial<InvoiceLine>): Promise<InvoiceLine | undefined> {
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

export const invoiceLineService = new InvoiceLineService();
