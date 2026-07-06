import { Team } from '../models/team.model';

const store = new Map<string, Team>();

export class TeamService {
  async list(): Promise<Team[]> {
    return Array.from(store.values());
  }

  async get(id: string): Promise<Team | undefined> {
    return store.get(id);
  }

  async create(input: Omit<Team, 'id' | 'createdAt' | 'updatedAt'>): Promise<Team> {
    const now = new Date(0).toISOString();
    const record: Team = {
      id: `team_${store.size + 1}`,
      createdAt: now,
      updatedAt: now,
      ...input,
    };
    store.set(record.id, record);
    return record;
  }

  async update(id: string, patch: Partial<Team>): Promise<Team | undefined> {
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

export const teamService = new TeamService();
