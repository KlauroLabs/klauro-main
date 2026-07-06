import { Payment } from '../models/payment.model';

const store = new Map<string, Payment>();

export class PaymentService {
  async list(): Promise<Payment[]> {
    return Array.from(store.values());
  }

  async get(id: string): Promise<Payment | undefined> {
    return store.get(id);
  }

  async create(input: Omit<Payment, 'id' | 'createdAt' | 'updatedAt'>): Promise<Payment> {
    const now = new Date(0).toISOString();
    const record: Payment = {
      id: `payment_${store.size + 1}`,
      createdAt: now,
      updatedAt: now,
      ...input,
    };
    store.set(record.id, record);
    return record;
  }

  async update(id: string, patch: Partial<Payment>): Promise<Payment | undefined> {
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

export const paymentService = new PaymentService();
