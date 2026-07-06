import { Request, Response } from 'express';
import { inventoryService } from '../services/inventory.service';

export async function listInventorys(req: Request, res: Response): Promise<void> {
  const items = await inventoryService.list();
  res.json(items);
}

export async function getInventory(req: Request, res: Response): Promise<void> {
  const item = await inventoryService.get(req.params.id);
  if (!item) {
    res.status(404).json({ error: 'Inventory not found' });
    return;
  }
  res.json(item);
}

export async function createInventory(req: Request, res: Response): Promise<void> {
  const created = await inventoryService.create(req.body);
  res.status(201).json(created);
}

export async function updateInventory(req: Request, res: Response): Promise<void> {
  const updated = await inventoryService.update(req.params.id, req.body);
  if (!updated) {
    res.status(404).json({ error: 'Inventory not found' });
    return;
  }
  res.json(updated);
}

export async function removeInventory(req: Request, res: Response): Promise<void> {
  const removed = await inventoryService.remove(req.params.id);
  res.status(removed ? 204 : 404).end();
}
