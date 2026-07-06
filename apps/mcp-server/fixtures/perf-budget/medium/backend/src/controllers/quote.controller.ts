import { Request, Response } from 'express';
import { quoteService } from '../services/quote.service';

export async function listQuotes(req: Request, res: Response): Promise<void> {
  const items = await quoteService.list();
  res.json(items);
}

export async function getQuote(req: Request, res: Response): Promise<void> {
  const item = await quoteService.get(req.params.id);
  if (!item) {
    res.status(404).json({ error: 'Quote not found' });
    return;
  }
  res.json(item);
}

export async function createQuote(req: Request, res: Response): Promise<void> {
  const created = await quoteService.create(req.body);
  res.status(201).json(created);
}

export async function updateQuote(req: Request, res: Response): Promise<void> {
  const updated = await quoteService.update(req.params.id, req.body);
  if (!updated) {
    res.status(404).json({ error: 'Quote not found' });
    return;
  }
  res.json(updated);
}

export async function removeQuote(req: Request, res: Response): Promise<void> {
  const removed = await quoteService.remove(req.params.id);
  res.status(removed ? 204 : 404).end();
}
