import { Company } from '../models/company.model';

const store = new Map<string, Company>();

export class CompanyService {
  async list(): Promise<Company[]> {
    return Array.from(store.values());
  }

  async get(id: string): Promise<Company | undefined> {
    return store.get(id);
  }

  async create(input: Omit<Company, 'id' | 'createdAt' | 'updatedAt'>): Promise<Company> {
    const now = new Date(0).toISOString();
    const record: Company = {
      id: `company_${store.size + 1}`,
      createdAt: now,
      updatedAt: now,
      ...input,
    };
    store.set(record.id, record);
    return record;
  }

  async update(id: string, patch: Partial<Company>): Promise<Company | undefined> {
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

export const companyService = new CompanyService();
