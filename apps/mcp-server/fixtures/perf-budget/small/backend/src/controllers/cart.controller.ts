import { Request, Response } from 'express';
import { cartService } from '../services/cart.service';

export async function listCarts(req: Request, res: Response): Promise<void> {
  const items = await cartService.list();
  res.json(items);
}

export async function getCart(req: Request, res: Response): Promise<void> {
  const item = await cartService.get(req.params.id);
  if (!item) {
    res.status(404).json({ error: 'Cart not found' });
    return;
  }
  res.json(item);
}

export async function createCart(req: Request, res: Response): Promise<void> {
  const created = await cartService.create(req.body);
  res.status(201).json(created);
}

export async function updateCart(req: Request, res: Response): Promise<void> {
  const updated = await cartService.update(req.params.id, req.body);
  if (!updated) {
    res.status(404).json({ error: 'Cart not found' });
    return;
  }
  res.json(updated);
}

export async function removeCart(req: Request, res: Response): Promise<void> {
  const removed = await cartService.remove(req.params.id);
  res.status(removed ? 204 : 404).end();
}
