import { Request, Response } from 'express';
import { subscriptionService } from '../services/subscription.service';

export async function listSubscriptions(req: Request, res: Response): Promise<void> {
  const items = await subscriptionService.list();
  res.json(items);
}

export async function getSubscription(req: Request, res: Response): Promise<void> {
  const item = await subscriptionService.get(req.params.id);
  if (!item) {
    res.status(404).json({ error: 'Subscription not found' });
    return;
  }
  res.json(item);
}

export async function createSubscription(req: Request, res: Response): Promise<void> {
  const created = await subscriptionService.create(req.body);
  res.status(201).json(created);
}

export async function updateSubscription(req: Request, res: Response): Promise<void> {
  const updated = await subscriptionService.update(req.params.id, req.body);
  if (!updated) {
    res.status(404).json({ error: 'Subscription not found' });
    return;
  }
  res.json(updated);
}

export async function removeSubscription(req: Request, res: Response): Promise<void> {
  const removed = await subscriptionService.remove(req.params.id);
  res.status(removed ? 204 : 404).end();
}
