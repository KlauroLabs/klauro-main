import { Request, Response } from 'express';
import { warehouseService } from '../services/warehouse.service';

export async function listWarehouses(req: Request, res: Response): Promise<void> {
  const items = await warehouseService.list();
  res.json(items);
}

export async function getWarehouse(req: Request, res: Response): Promise<void> {
  const item = await warehouseService.get(req.params.id);
  if (!item) {
    res.status(404).json({ error: 'Warehouse not found' });
    return;
  }
  res.json(item);
}

export async function createWarehouse(req: Request, res: Response): Promise<void> {
  const created = await warehouseService.create(req.body);
  res.status(201).json(created);
}

export async function updateWarehouse(req: Request, res: Response): Promise<void> {
  const updated = await warehouseService.update(req.params.id, req.body);
  if (!updated) {
    res.status(404).json({ error: 'Warehouse not found' });
    return;
  }
  res.json(updated);
}

export async function removeWarehouse(req: Request, res: Response): Promise<void> {
  const removed = await warehouseService.remove(req.params.id);
  res.status(removed ? 204 : 404).end();
}
