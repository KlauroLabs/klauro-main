import { Request, Response } from 'express';
import { auditService } from '../services/audit.service';

export async function listAudits(req: Request, res: Response): Promise<void> {
  const items = await auditService.list();
  res.json(items);
}

export async function getAudit(req: Request, res: Response): Promise<void> {
  const item = await auditService.get(req.params.id);
  if (!item) {
    res.status(404).json({ error: 'Audit not found' });
    return;
  }
  res.json(item);
}

export async function createAudit(req: Request, res: Response): Promise<void> {
  const created = await auditService.create(req.body);
  res.status(201).json(created);
}

export async function updateAudit(req: Request, res: Response): Promise<void> {
  const updated = await auditService.update(req.params.id, req.body);
  if (!updated) {
    res.status(404).json({ error: 'Audit not found' });
    return;
  }
  res.json(updated);
}

export async function removeAudit(req: Request, res: Response): Promise<void> {
  const removed = await auditService.remove(req.params.id);
  res.status(removed ? 204 : 404).end();
}
