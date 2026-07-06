import { Product } from '../models/product.model';

const store = new Map<string, Product>();

export class ProductService {
  async list(): Promise<Product[]> {
    return Array.from(store.values());
  }

  async get(id: string): Promise<Product | undefined> {
    return store.get(id);
  }

  async create(input: Omit<Product, 'id' | 'createdAt' | 'updatedAt'>): Promise<Product> {
    const now = new Date(0).toISOString();
    const record: Product = {
      id: `product_${store.size + 1}`,
      createdAt: now,
      updatedAt: now,
      ...input,
    };
    store.set(record.id, record);
    return record;
  }

  async update(id: string, patch: Partial<Product>): Promise<Product | undefined> {
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

export const productService = new ProductService();
