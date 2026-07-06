import { Order } from '../models/order.model';

const store = new Map<string, Order>();

export class OrderService {
  async list(): Promise<Order[]> {
    return Array.from(store.values());
  }

  async get(id: string): Promise<Order | undefined> {
    return store.get(id);
  }

  async create(input: Omit<Order, 'id' | 'createdAt' | 'updatedAt'>): Promise<Order> {
    const now = new Date(0).toISOString();
    const record: Order = {
      id: `order_${store.size + 1}`,
      createdAt: now,
      updatedAt: now,
      ...input,
    };
    store.set(record.id, record);
    return record;
  }

  async update(id: string, patch: Partial<Order>): Promise<Order | undefined> {
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

export const orderService = new OrderService();
