import { Request, Response } from 'express';
import { refundService } from '../services/refund.service';

export async function listRefunds(req: Request, res: Response): Promise<void> {
  const items = await refundService.list();
  res.json(items);
}

export async function getRefund(req: Request, res: Response): Promise<void> {
  const item = await refundService.get(req.params.id);
  if (!item) {
    res.status(404).json({ error: 'Refund not found' });
    return;
  }
  res.json(item);
}

export async function createRefund(req: Request, res: Response): Promise<void> {
  const created = await refundService.create(req.body);
  res.status(201).json(created);
}

export async function updateRefund(req: Request, res: Response): Promise<void> {
  const updated = await refundService.update(req.params.id, req.body);
  if (!updated) {
    res.status(404).json({ error: 'Refund not found' });
    return;
  }
  res.json(updated);
}

export async function removeRefund(req: Request, res: Response): Promise<void> {
  const removed = await refundService.remove(req.params.id);
  res.status(removed ? 204 : 404).end();
}
