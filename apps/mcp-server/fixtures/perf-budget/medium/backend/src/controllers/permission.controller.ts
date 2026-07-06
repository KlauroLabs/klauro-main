import { Request, Response } from 'express';
import { permissionService } from '../services/permission.service';

export async function listPermissions(req: Request, res: Response): Promise<void> {
  const items = await permissionService.list();
  res.json(items);
}

export async function getPermission(req: Request, res: Response): Promise<void> {
  const item = await permissionService.get(req.params.id);
  if (!item) {
    res.status(404).json({ error: 'Permission not found' });
    return;
  }
  res.json(item);
}

export async function createPermission(req: Request, res: Response): Promise<void> {
  const created = await permissionService.create(req.body);
  res.status(201).json(created);
}

export async function updatePermission(req: Request, res: Response): Promise<void> {
  const updated = await permissionService.update(req.params.id, req.body);
  if (!updated) {
    res.status(404).json({ error: 'Permission not found' });
    return;
  }
  res.json(updated);
}

export async function removePermission(req: Request, res: Response): Promise<void> {
  const removed = await permissionService.remove(req.params.id);
  res.status(removed ? 204 : 404).end();
}
