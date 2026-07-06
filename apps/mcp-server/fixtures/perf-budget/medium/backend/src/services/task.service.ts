import { Task } from '../models/task.model';

const store = new Map<string, Task>();

export class TaskService {
  async list(): Promise<Task[]> {
    return Array.from(store.values());
  }

  async get(id: string): Promise<Task | undefined> {
    return store.get(id);
  }

  async create(input: Omit<Task, 'id' | 'createdAt' | 'updatedAt'>): Promise<Task> {
    const now = new Date(0).toISOString();
    const record: Task = {
      id: `task_${store.size + 1}`,
      createdAt: now,
      updatedAt: now,
      ...input,
    };
    store.set(record.id, record);
    return record;
  }

  async update(id: string, patch: Partial<Task>): Promise<Task | undefined> {
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

export const taskService = new TaskService();
