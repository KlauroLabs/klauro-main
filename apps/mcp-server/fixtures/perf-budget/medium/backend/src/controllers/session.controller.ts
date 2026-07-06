import { Request, Response } from 'express';
import { sessionService } from '../services/session.service';

export async function listSessions(req: Request, res: Response): Promise<void> {
  const items = await sessionService.list();
  res.json(items);
}

export async function getSession(req: Request, res: Response): Promise<void> {
  const item = await sessionService.get(req.params.id);
  if (!item) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  res.json(item);
}

export async function createSession(req: Request, res: Response): Promise<void> {
  const created = await sessionService.create(req.body);
  res.status(201).json(created);
}

export async function updateSession(req: Request, res: Response): Promise<void> {
  const updated = await sessionService.update(req.params.id, req.body);
  if (!updated) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  res.json(updated);
}

export async function removeSession(req: Request, res: Response): Promise<void> {
  const removed = await sessionService.remove(req.params.id);
  res.status(removed ? 204 : 404).end();
}
