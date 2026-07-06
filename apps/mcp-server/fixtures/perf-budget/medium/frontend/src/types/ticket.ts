export interface Ticket {
  id: string;
  createdAt: string;
  updatedAt: string;
  name: string;
  status: 'ticket_active' | 'ticket_inactive';
}
