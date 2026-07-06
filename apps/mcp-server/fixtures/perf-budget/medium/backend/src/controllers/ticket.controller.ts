import { Request, Response } from 'express';
import { ticketService } from '../services/ticket.service';

export async function listTickets(req: Request, res: Response): Promise<void> {
  const items = await ticketService.list();
  res.json(items);
}

export async function getTicket(req: Request, res: Response): Promise<void> {
  const item = await ticketService.get(req.params.id);
  if (!item) {
    res.status(404).json({ error: 'Ticket not found' });
    return;
  }
  res.json(item);
}

export async function createTicket(req: Request, res: Response): Promise<void> {
  const created = await ticketService.create(req.body);
  res.status(201).json(created);
}

export async function updateTicket(req: Request, res: Response): Promise<void> {
  const updated = await ticketService.update(req.params.id, req.body);
  if (!updated) {
    res.status(404).json({ error: 'Ticket not found' });
    return;
  }
  res.json(updated);
}

export async function removeTicket(req: Request, res: Response): Promise<void> {
  const removed = await ticketService.remove(req.params.id);
  res.status(removed ? 204 : 404).end();
}
