import { Router } from 'express';
import {
  listTickets,
  getTicket,
  createTicket,
  updateTicket,
  removeTicket,
} from '../controllers/ticket.controller';

export const ticketRouter = Router();

ticketRouter.get('/', listTickets);
ticketRouter.get('/:id', getTicket);
ticketRouter.post('/', createTicket);
ticketRouter.put('/:id', updateTicket);
ticketRouter.delete('/:id', removeTicket);
