import { Request, Response } from 'express';
import { promotionService } from '../services/promotion.service';

export async function listPromotions(req: Request, res: Response): Promise<void> {
  const items = await promotionService.list();
  res.json(items);
}

export async function getPromotion(req: Request, res: Response): Promise<void> {
  const item = await promotionService.get(req.params.id);
  if (!item) {
    res.status(404).json({ error: 'Promotion not found' });
    return;
  }
  res.json(item);
}

export async function createPromotion(req: Request, res: Response): Promise<void> {
  const created = await promotionService.create(req.body);
  res.status(201).json(created);
}

export async function updatePromotion(req: Request, res: Response): Promise<void> {
  const updated = await promotionService.update(req.params.id, req.body);
  if (!updated) {
    res.status(404).json({ error: 'Promotion not found' });
    return;
  }
  res.json(updated);
}

export async function removePromotion(req: Request, res: Response): Promise<void> {
  const removed = await promotionService.remove(req.params.id);
  res.status(removed ? 204 : 404).end();
}
