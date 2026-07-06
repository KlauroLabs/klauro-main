import { Request, Response } from 'express';
import { notificationService } from '../services/notification.service';

export async function listNotifications(req: Request, res: Response): Promise<void> {
  const items = await notificationService.list();
  res.json(items);
}

export async function getNotification(req: Request, res: Response): Promise<void> {
  const item = await notificationService.get(req.params.id);
  if (!item) {
    res.status(404).json({ error: 'Notification not found' });
    return;
  }
  res.json(item);
}

export async function createNotification(req: Request, res: Response): Promise<void> {
  const created = await notificationService.create(req.body);
  res.status(201).json(created);
}

export async function updateNotification(req: Request, res: Response): Promise<void> {
  const updated = await notificationService.update(req.params.id, req.body);
  if (!updated) {
    res.status(404).json({ error: 'Notification not found' });
    return;
  }
  res.json(updated);
}

export async function removeNotification(req: Request, res: Response): Promise<void> {
  const removed = await notificationService.remove(req.params.id);
  res.status(removed ? 204 : 404).end();
}
