import { Request, Response } from 'express';
import { categoryService } from '../services/category.service';

export async function listCategorys(req: Request, res: Response): Promise<void> {
  const items = await categoryService.list();
  res.json(items);
}

export async function getCategory(req: Request, res: Response): Promise<void> {
  const item = await categoryService.get(req.params.id);
  if (!item) {
    res.status(404).json({ error: 'Category not found' });
    return;
  }
  res.json(item);
}

export async function createCategory(req: Request, res: Response): Promise<void> {
  const created = await categoryService.create(req.body);
  res.status(201).json(created);
}

export async function updateCategory(req: Request, res: Response): Promise<void> {
  const updated = await categoryService.update(req.params.id, req.body);
  if (!updated) {
    res.status(404).json({ error: 'Category not found' });
    return;
  }
  res.json(updated);
}

export async function removeCategory(req: Request, res: Response): Promise<void> {
  const removed = await categoryService.remove(req.params.id);
  res.status(removed ? 204 : 404).end();
}
