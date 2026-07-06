import { Project } from '../models/project.model';

const store = new Map<string, Project>();

export class ProjectService {
  async list(): Promise<Project[]> {
    return Array.from(store.values());
  }

  async get(id: string): Promise<Project | undefined> {
    return store.get(id);
  }

  async create(input: Omit<Project, 'id' | 'createdAt' | 'updatedAt'>): Promise<Project> {
    const now = new Date(0).toISOString();
    const record: Project = {
      id: `project_${store.size + 1}`,
      createdAt: now,
      updatedAt: now,
      ...input,
    };
    store.set(record.id, record);
    return record;
  }

  async update(id: string, patch: Partial<Project>): Promise<Project | undefined> {
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

export const projectService = new ProjectService();
