import { Department } from '../models/department.model';

const store = new Map<string, Department>();

export class DepartmentService {
  async list(): Promise<Department[]> {
    return Array.from(store.values());
  }

  async get(id: string): Promise<Department | undefined> {
    return store.get(id);
  }

  async create(input: Omit<Department, 'id' | 'createdAt' | 'updatedAt'>): Promise<Department> {
    const now = new Date(0).toISOString();
    const record: Department = {
      id: `department_${store.size + 1}`,
      createdAt: now,
      updatedAt: now,
      ...input,
    };
    store.set(record.id, record);
    return record;
  }

  async update(id: string, patch: Partial<Department>): Promise<Department | undefined> {
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

export const departmentService = new DepartmentService();
