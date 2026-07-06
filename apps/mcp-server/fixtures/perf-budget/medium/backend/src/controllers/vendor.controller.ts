import { Request, Response } from 'express';
import { vendorService } from '../services/vendor.service';

export async function listVendors(req: Request, res: Response): Promise<void> {
  const items = await vendorService.list();
  res.json(items);
}

export async function getVendor(req: Request, res: Response): Promise<void> {
  const item = await vendorService.get(req.params.id);
  if (!item) {
    res.status(404).json({ error: 'Vendor not found' });
    return;
  }
  res.json(item);
}

export async function createVendor(req: Request, res: Response): Promise<void> {
  const created = await vendorService.create(req.body);
  res.status(201).json(created);
}

export async function updateVendor(req: Request, res: Response): Promise<void> {
  const updated = await vendorService.update(req.params.id, req.body);
  if (!updated) {
    res.status(404).json({ error: 'Vendor not found' });
    return;
  }
  res.json(updated);
}

export async function removeVendor(req: Request, res: Response): Promise<void> {
  const removed = await vendorService.remove(req.params.id);
  res.status(removed ? 204 : 404).end();
}
