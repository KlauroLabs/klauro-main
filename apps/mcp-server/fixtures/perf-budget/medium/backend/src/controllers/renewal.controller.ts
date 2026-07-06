import { Request, Response } from 'express';
import { renewalService } from '../services/renewal.service';

export async function listRenewals(req: Request, res: Response): Promise<void> {
  const items = await renewalService.list();
  res.json(items);
}

export async function getRenewal(req: Request, res: Response): Promise<void> {
  const item = await renewalService.get(req.params.id);
  if (!item) {
    res.status(404).json({ error: 'Renewal not found' });
    return;
  }
  res.json(item);
}

export async function createRenewal(req: Request, res: Response): Promise<void> {
  const created = await renewalService.create(req.body);
  res.status(201).json(created);
}

export async function updateRenewal(req: Request, res: Response): Promise<void> {
  const updated = await renewalService.update(req.params.id, req.body);
  if (!updated) {
    res.status(404).json({ error: 'Renewal not found' });
    return;
  }
  res.json(updated);
}

export async function removeRenewal(req: Request, res: Response): Promise<void> {
  const removed = await renewalService.remove(req.params.id);
  res.status(removed ? 204 : 404).end();
}
