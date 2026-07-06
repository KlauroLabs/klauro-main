import { Request, Response } from 'express';
import { roleService } from '../services/role.service';

export async function listRoles(req: Request, res: Response): Promise<void> {
  const items = await roleService.list();
  res.json(items);
}

export async function getRole(req: Request, res: Response): Promise<void> {
  const item = await roleService.get(req.params.id);
  if (!item) {
    res.status(404).json({ error: 'Role not found' });
    return;
  }
  res.json(item);
}

export async function createRole(req: Request, res: Response): Promise<void> {
  const created = await roleService.create(req.body);
  res.status(201).json(created);
}

export async function updateRole(req: Request, res: Response): Promise<void> {
  const updated = await roleService.update(req.params.id, req.body);
  if (!updated) {
    res.status(404).json({ error: 'Role not found' });
    return;
  }
  res.json(updated);
}

export async function removeRole(req: Request, res: Response): Promise<void> {
  const removed = await roleService.remove(req.params.id);
  res.status(removed ? 204 : 404).end();
}
