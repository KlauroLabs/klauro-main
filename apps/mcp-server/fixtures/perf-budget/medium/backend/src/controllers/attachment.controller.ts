import { Request, Response } from 'express';
import { attachmentService } from '../services/attachment.service';

export async function listAttachments(req: Request, res: Response): Promise<void> {
  const items = await attachmentService.list();
  res.json(items);
}

export async function getAttachment(req: Request, res: Response): Promise<void> {
  const item = await attachmentService.get(req.params.id);
  if (!item) {
    res.status(404).json({ error: 'Attachment not found' });
    return;
  }
  res.json(item);
}

export async function createAttachment(req: Request, res: Response): Promise<void> {
  const created = await attachmentService.create(req.body);
  res.status(201).json(created);
}

export async function updateAttachment(req: Request, res: Response): Promise<void> {
  const updated = await attachmentService.update(req.params.id, req.body);
  if (!updated) {
    res.status(404).json({ error: 'Attachment not found' });
    return;
  }
  res.json(updated);
}

export async function removeAttachment(req: Request, res: Response): Promise<void> {
  const removed = await attachmentService.remove(req.params.id);
  res.status(removed ? 204 : 404).end();
}
