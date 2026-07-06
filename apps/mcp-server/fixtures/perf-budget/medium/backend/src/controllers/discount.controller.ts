import { Request, Response } from 'express';
import { discountService } from '../services/discount.service';

export async function listDiscounts(req: Request, res: Response): Promise<void> {
  const items = await discountService.list();
  res.json(items);
}

export async function getDiscount(req: Request, res: Response): Promise<void> {
  const item = await discountService.get(req.params.id);
  if (!item) {
    res.status(404).json({ error: 'Discount not found' });
    return;
  }
  res.json(item);
}

export async function createDiscount(req: Request, res: Response): Promise<void> {
  const created = await discountService.create(req.body);
  res.status(201).json(created);
}

export async function updateDiscount(req: Request, res: Response): Promise<void> {
  const updated = await discountService.update(req.params.id, req.body);
  if (!updated) {
    res.status(404).json({ error: 'Discount not found' });
    return;
  }
  res.json(updated);
}

export async function removeDiscount(req: Request, res: Response): Promise<void> {
  const removed = await discountService.remove(req.params.id);
  res.status(removed ? 204 : 404).end();
}
