import { Request, Response } from 'express';
import { paymentService } from '../services/payment.service';

export async function listPayments(req: Request, res: Response): Promise<void> {
  const items = await paymentService.list();
  res.json(items);
}

export async function getPayment(req: Request, res: Response): Promise<void> {
  const item = await paymentService.get(req.params.id);
  if (!item) {
    res.status(404).json({ error: 'Payment not found' });
    return;
  }
  res.json(item);
}

export async function createPayment(req: Request, res: Response): Promise<void> {
  const created = await paymentService.create(req.body);
  res.status(201).json(created);
}

export async function updatePayment(req: Request, res: Response): Promise<void> {
  const updated = await paymentService.update(req.params.id, req.body);
  if (!updated) {
    res.status(404).json({ error: 'Payment not found' });
    return;
  }
  res.json(updated);
}

export async function removePayment(req: Request, res: Response): Promise<void> {
  const removed = await paymentService.remove(req.params.id);
  res.status(removed ? 204 : 404).end();
}
