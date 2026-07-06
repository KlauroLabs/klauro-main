import { ticketService } from '../services/ticket.service';

describe('TicketService', () => {
  it('creates and retrieves a ticket', async () => {
    const created = await ticketService.create({ name: 'sample-ticket', status: 'ticket_active' });
    const fetched = await ticketService.get(created.id);
    expect(fetched).toEqual(created);
  });
});
