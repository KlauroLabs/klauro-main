import { Request, Response } from 'express';
import { reportService } from '../services/report.service';

export async function listReports(req: Request, res: Response): Promise<void> {
  const items = await reportService.list();
  res.json(items);
}

export async function getReport(req: Request, res: Response): Promise<void> {
  const item = await reportService.get(req.params.id);
  if (!item) {
    res.status(404).json({ error: 'Report not found' });
    return;
  }
  res.json(item);
}

export async function createReport(req: Request, res: Response): Promise<void> {
  const created = await reportService.create(req.body);
  res.status(201).json(created);
}

export async function updateReport(req: Request, res: Response): Promise<void> {
  const updated = await reportService.update(req.params.id, req.body);
  if (!updated) {
    res.status(404).json({ error: 'Report not found' });
    return;
  }
  res.json(updated);
}

export async function removeReport(req: Request, res: Response): Promise<void> {
  const removed = await reportService.remove(req.params.id);
  res.status(removed ? 204 : 404).end();
}
