import { Request, Response } from 'express';
import { departmentService } from '../services/department.service';

export async function listDepartments(req: Request, res: Response): Promise<void> {
  const items = await departmentService.list();
  res.json(items);
}

export async function getDepartment(req: Request, res: Response): Promise<void> {
  const item = await departmentService.get(req.params.id);
  if (!item) {
    res.status(404).json({ error: 'Department not found' });
    return;
  }
  res.json(item);
}

export async function createDepartment(req: Request, res: Response): Promise<void> {
  const created = await departmentService.create(req.body);
  res.status(201).json(created);
}

export async function updateDepartment(req: Request, res: Response): Promise<void> {
  const updated = await departmentService.update(req.params.id, req.body);
  if (!updated) {
    res.status(404).json({ error: 'Department not found' });
    return;
  }
  res.json(updated);
}

export async function removeDepartment(req: Request, res: Response): Promise<void> {
  const removed = await departmentService.remove(req.params.id);
  res.status(removed ? 204 : 404).end();
}
