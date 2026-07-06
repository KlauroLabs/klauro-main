import { Ticket } from '../models/ticket.model';

const store = new Map<string, Ticket>();

export class TicketService {
  async list(): Promise<Ticket[]> {
    return Array.from(store.values());
  }

  async get(id: string): Promise<Ticket | undefined> {
    return store.get(id);
  }

  async create(input: Omit<Ticket, 'id' | 'createdAt' | 'updatedAt'>): Promise<Ticket> {
    const now = new Date(0).toISOString();
    const record: Ticket = {
      id: `ticket_${store.size + 1}`,
      createdAt: now,
      updatedAt: now,
      ...input,
    };
    store.set(record.id, record);
    return record;
  }

  async update(id: string, patch: Partial<Ticket>): Promise<Ticket | undefined> {
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

export const ticketService = new TicketService();
