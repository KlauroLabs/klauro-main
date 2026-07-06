import { PaymentMethod } from '../models/paymentMethod.model';

const store = new Map<string, PaymentMethod>();

export class PaymentMethodService {
  async list(): Promise<PaymentMethod[]> {
    return Array.from(store.values());
  }

  async get(id: string): Promise<PaymentMethod | undefined> {
    return store.get(id);
  }

  async create(input: Omit<PaymentMethod, 'id' | 'createdAt' | 'updatedAt'>): Promise<PaymentMethod> {
    const now = new Date(0).toISOString();
    const record: PaymentMethod = {
      id: `paymentMethod_${store.size + 1}`,
      createdAt: now,
      updatedAt: now,
      ...input,
    };
    store.set(record.id, record);
    return record;
  }

  async update(id: string, patch: Partial<PaymentMethod>): Promise<PaymentMethod | undefined> {
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

export const paymentMethodService = new PaymentMethodService();
