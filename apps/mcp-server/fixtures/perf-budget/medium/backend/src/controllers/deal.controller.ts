import { Request, Response } from 'express';
import { dealService } from '../services/deal.service';

export async function listDeals(req: Request, res: Response): Promise<void> {
  const items = await dealService.list();
  res.json(items);
}

export async function getDeal(req: Request, res: Response): Promise<void> {
  const item = await dealService.get(req.params.id);
  if (!item) {
    res.status(404).json({ error: 'Deal not found' });
    return;
  }
  res.json(item);
}

export async function createDeal(req: Request, res: Response): Promise<void> {
  const created = await dealService.create(req.body);
  res.status(201).json(created);
}

export async function updateDeal(req: Request, res: Response): Promise<void> {
  const updated = await dealService.update(req.params.id, req.body);
  if (!updated) {
    res.status(404).json({ error: 'Deal not found' });
    return;
  }
  res.json(updated);
}

export async function removeDeal(req: Request, res: Response): Promise<void> {
  const removed = await dealService.remove(req.params.id);
  res.status(removed ? 204 : 404).end();
}
