import { Request, Response } from 'express';
import { commentService } from '../services/comment.service';

export async function listComments(req: Request, res: Response): Promise<void> {
  const items = await commentService.list();
  res.json(items);
}

export async function getComment(req: Request, res: Response): Promise<void> {
  const item = await commentService.get(req.params.id);
  if (!item) {
    res.status(404).json({ error: 'Comment not found' });
    return;
  }
  res.json(item);
}

export async function createComment(req: Request, res: Response): Promise<void> {
  const created = await commentService.create(req.body);
  res.status(201).json(created);
}

export async function updateComment(req: Request, res: Response): Promise<void> {
  const updated = await commentService.update(req.params.id, req.body);
  if (!updated) {
    res.status(404).json({ error: 'Comment not found' });
    return;
  }
  res.json(updated);
}

export async function removeComment(req: Request, res: Response): Promise<void> {
  const removed = await commentService.remove(req.params.id);
  res.status(removed ? 204 : 404).end();
}
