export interface Ticket {
  id: string;
  createdAt: string;
  updatedAt: string;
  name: string;
  status: 'ticket_active' | 'ticket_inactive';
}

export function isTicket(value: unknown): value is Ticket {
  return typeof value === 'object' && value !== null && 'id' in value;
}
