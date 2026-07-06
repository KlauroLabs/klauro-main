import { Request, Response } from 'express';
import { webhookService } from '../services/webhook.service';

export async function listWebhooks(req: Request, res: Response): Promise<void> {
  const items = await webhookService.list();
  res.json(items);
}

export async function getWebhook(req: Request, res: Response): Promise<void> {
  const item = await webhookService.get(req.params.id);
  if (!item) {
    res.status(404).json({ error: 'Webhook not found' });
    return;
  }
  res.json(item);
}

export async function createWebhook(req: Request, res: Response): Promise<void> {
  const created = await webhookService.create(req.body);
  res.status(201).json(created);
}

export async function updateWebhook(req: Request, res: Response): Promise<void> {
  const updated = await webhookService.update(req.params.id, req.body);
  if (!updated) {
    res.status(404).json({ error: 'Webhook not found' });
    return;
  }
  res.json(updated);
}

export async function removeWebhook(req: Request, res: Response): Promise<void> {
  const removed = await webhookService.remove(req.params.id);
  res.status(removed ? 204 : 404).end();
}
