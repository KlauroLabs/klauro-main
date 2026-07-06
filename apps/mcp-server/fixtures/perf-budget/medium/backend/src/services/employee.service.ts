import { Employee } from '../models/employee.model';

const store = new Map<string, Employee>();

export class EmployeeService {
  async list(): Promise<Employee[]> {
    return Array.from(store.values());
  }

  async get(id: string): Promise<Employee | undefined> {
    return store.get(id);
  }

  async create(input: Omit<Employee, 'id' | 'createdAt' | 'updatedAt'>): Promise<Employee> {
    const now = new Date(0).toISOString();
    const record: Employee = {
      id: `employee_${store.size + 1}`,
      createdAt: now,
      updatedAt: now,
      ...input,
    };
    store.set(record.id, record);
    return record;
  }

  async update(id: string, patch: Partial<Employee>): Promise<Employee | undefined> {
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

export const employeeService = new EmployeeService();
