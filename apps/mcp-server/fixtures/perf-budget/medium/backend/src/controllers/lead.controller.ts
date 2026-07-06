import { Request, Response } from 'express';
import { leadService } from '../services/lead.service';

export async function listLeads(req: Request, res: Response): Promise<void> {
  const items = await leadService.list();
  res.json(items);
}

export async function getLead(req: Request, res: Response): Promise<void> {
  const item = await leadService.get(req.params.id);
  if (!item) {
    res.status(404).json({ error: 'Lead not found' });
    return;
  }
  res.json(item);
}

export async function createLead(req: Request, res: Response): Promise<void> {
  const created = await leadService.create(req.body);
  res.status(201).json(created);
}

export async function updateLead(req: Request, res: Response): Promise<void> {
  const updated = await leadService.update(req.params.id, req.body);
  if (!updated) {
    res.status(404).json({ error: 'Lead not found' });
    return;
  }
  res.json(updated);
}

export async function removeLead(req: Request, res: Response): Promise<void> {
  const removed = await leadService.remove(req.params.id);
  res.status(removed ? 204 : 404).end();
}
