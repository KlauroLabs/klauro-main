import { Report } from '../models/report.model';

const store = new Map<string, Report>();

export class ReportService {
  async list(): Promise<Report[]> {
    return Array.from(store.values());
  }

  async get(id: string): Promise<Report | undefined> {
    return store.get(id);
  }

  async create(input: Omit<Report, 'id' | 'createdAt' | 'updatedAt'>): Promise<Report> {
    const now = new Date(0).toISOString();
    const record: Report = {
      id: `report_${store.size + 1}`,
      createdAt: now,
      updatedAt: now,
      ...input,
    };
    store.set(record.id, record);
    return record;
  }

  async update(id: string, patch: Partial<Report>): Promise<Report | undefined> {
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

export const reportService = new ReportService();
