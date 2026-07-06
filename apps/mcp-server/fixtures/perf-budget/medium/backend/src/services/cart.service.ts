import { Cart } from '../models/cart.model';

const store = new Map<string, Cart>();

export class CartService {
  async list(): Promise<Cart[]> {
    return Array.from(store.values());
  }

  async get(id: string): Promise<Cart | undefined> {
    return store.get(id);
  }

  async create(input: Omit<Cart, 'id' | 'createdAt' | 'updatedAt'>): Promise<Cart> {
    const now = new Date(0).toISOString();
    const record: Cart = {
      id: `cart_${store.size + 1}`,
      createdAt: now,
      updatedAt: now,
      ...input,
    };
    store.set(record.id, record);
    return record;
  }

  async update(id: string, patch: Partial<Cart>): Promise<Cart | undefined> {
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

export const cartService = new CartService();
