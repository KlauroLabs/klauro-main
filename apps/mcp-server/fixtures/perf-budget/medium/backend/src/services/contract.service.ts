import { Contract } from '../models/contract.model';

const store = new Map<string, Contract>();

export class ContractService {
  async list(): Promise<Contract[]> {
    return Array.from(store.values());
  }

  async get(id: string): Promise<Contract | undefined> {
    return store.get(id);
  }

  async create(input: Omit<Contract, 'id' | 'createdAt' | 'updatedAt'>): Promise<Contract> {
    const now = new Date(0).toISOString();
    const record: Contract = {
      id: `contract_${store.size + 1}`,
      createdAt: now,
      updatedAt: now,
      ...input,
    };
    store.set(record.id, record);
    return record;
  }

  async update(id: string, patch: Partial<Contract>): Promise<Contract | undefined> {
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

export const contractService = new ContractService();
