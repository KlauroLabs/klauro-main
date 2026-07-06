import { Request, Response } from 'express';
import { tagService } from '../services/tag.service';

export async function listTags(req: Request, res: Response): Promise<void> {
  const items = await tagService.list();
  res.json(items);
}

export async function getTag(req: Request, res: Response): Promise<void> {
  const item = await tagService.get(req.params.id);
  if (!item) {
    res.status(404).json({ error: 'Tag not found' });
    return;
  }
  res.json(item);
}

export async function createTag(req: Request, res: Response): Promise<void> {
  const created = await tagService.create(req.body);
  res.status(201).json(created);
}

export async function updateTag(req: Request, res: Response): Promise<void> {
  const updated = await tagService.update(req.params.id, req.body);
  if (!updated) {
    res.status(404).json({ error: 'Tag not found' });
    return;
  }
  res.json(updated);
}

export async function removeTag(req: Request, res: Response): Promise<void> {
  const removed = await tagService.remove(req.params.id);
  res.status(removed ? 204 : 404).end();
}
