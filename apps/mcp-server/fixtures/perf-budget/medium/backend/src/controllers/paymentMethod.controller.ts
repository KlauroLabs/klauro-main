import { Request, Response } from 'express';
import { paymentMethodService } from '../services/paymentMethod.service';

export async function listPaymentMethods(req: Request, res: Response): Promise<void> {
  const items = await paymentMethodService.list();
  res.json(items);
}

export async function getPaymentMethod(req: Request, res: Response): Promise<void> {
  const item = await paymentMethodService.get(req.params.id);
  if (!item) {
    res.status(404).json({ error: 'PaymentMethod not found' });
    return;
  }
  res.json(item);
}

export async function createPaymentMethod(req: Request, res: Response): Promise<void> {
  const created = await paymentMethodService.create(req.body);
  res.status(201).json(created);
}

export async function updatePaymentMethod(req: Request, res: Response): Promise<void> {
  const updated = await paymentMethodService.update(req.params.id, req.body);
  if (!updated) {
    res.status(404).json({ error: 'PaymentMethod not found' });
    return;
  }
  res.json(updated);
}

export async function removePaymentMethod(req: Request, res: Response): Promise<void> {
  const removed = await paymentMethodService.remove(req.params.id);
  res.status(removed ? 204 : 404).end();
}
