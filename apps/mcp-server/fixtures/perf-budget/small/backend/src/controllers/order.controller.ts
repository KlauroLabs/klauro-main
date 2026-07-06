import { Request, Response } from 'express';
import { orderService } from '../services/order.service';

export async function listOrders(req: Request, res: Response): Promise<void> {
  const items = await orderService.list();
  res.json(items);
}

export async function getOrder(req: Request, res: Response): Promise<void> {
  const item = await orderService.get(req.params.id);
  if (!item) {
    res.status(404).json({ error: 'Order not found' });
    return;
  }
  res.json(item);
}

export async function createOrder(req: Request, res: Response): Promise<void> {
  const created = await orderService.create(req.body);
  res.status(201).json(created);
}

export async function updateOrder(req: Request, res: Response): Promise<void> {
  const updated = await orderService.update(req.params.id, req.body);
  if (!updated) {
    res.status(404).json({ error: 'Order not found' });
    return;
  }
  res.json(updated);
}

export async function removeOrder(req: Request, res: Response): Promise<void> {
  const removed = await orderService.remove(req.params.id);
  res.status(removed ? 204 : 404).end();
}
