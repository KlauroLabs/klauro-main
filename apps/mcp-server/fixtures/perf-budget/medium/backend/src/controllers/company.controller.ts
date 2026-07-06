import { Request, Response } from 'express';
import { companyService } from '../services/company.service';

export async function listCompanys(req: Request, res: Response): Promise<void> {
  const items = await companyService.list();
  res.json(items);
}

export async function getCompany(req: Request, res: Response): Promise<void> {
  const item = await companyService.get(req.params.id);
  if (!item) {
    res.status(404).json({ error: 'Company not found' });
    return;
  }
  res.json(item);
}

export async function createCompany(req: Request, res: Response): Promise<void> {
  const created = await companyService.create(req.body);
  res.status(201).json(created);
}

export async function updateCompany(req: Request, res: Response): Promise<void> {
  const updated = await companyService.update(req.params.id, req.body);
  if (!updated) {
    res.status(404).json({ error: 'Company not found' });
    return;
  }
  res.json(updated);
}

export async function removeCompany(req: Request, res: Response): Promise<void> {
  const removed = await companyService.remove(req.params.id);
  res.status(removed ? 204 : 404).end();
}
