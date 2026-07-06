import { Customer } from '../models/customer.model';

const store = new Map<string, Customer>();

export class CustomerService {
  async list(): Promise<Customer[]> {
    return Array.from(store.values());
  }

  async get(id: string): Promise<Customer | undefined> {
    return store.get(id);
  }

  async create(input: Omit<Customer, 'id' | 'createdAt' | 'updatedAt'>): Promise<Customer> {
    const now = new Date(0).toISOString();
    const record: Customer = {
      id: `customer_${store.size + 1}`,
      createdAt: now,
      updatedAt: now,
      ...input,
    };
    store.set(record.id, record);
    return record;
  }

  async update(id: string, patch: Partial<Customer>): Promise<Customer | undefined> {
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

export const customerService = new CustomerService();
