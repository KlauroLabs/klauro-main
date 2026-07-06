import { Campaign } from '../models/campaign.model';

const store = new Map<string, Campaign>();

export class CampaignService {
  async list(): Promise<Campaign[]> {
    return Array.from(store.values());
  }

  async get(id: string): Promise<Campaign | undefined> {
    return store.get(id);
  }

  async create(input: Omit<Campaign, 'id' | 'createdAt' | 'updatedAt'>): Promise<Campaign> {
    const now = new Date(0).toISOString();
    const record: Campaign = {
      id: `campaign_${store.size + 1}`,
      createdAt: now,
      updatedAt: now,
      ...input,
    };
    store.set(record.id, record);
    return record;
  }

  async update(id: string, patch: Partial<Campaign>): Promise<Campaign | undefined> {
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

export const campaignService = new CampaignService();
