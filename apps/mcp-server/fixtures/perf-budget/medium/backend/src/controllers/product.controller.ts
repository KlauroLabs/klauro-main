import { Request, Response } from 'express';
import { productService } from '../services/product.service';

export async function listProducts(req: Request, res: Response): Promise<void> {
  const items = await productService.list();
  res.json(items);
}

export async function getProduct(req: Request, res: Response): Promise<void> {
  const item = await productService.get(req.params.id);
  if (!item) {
    res.status(404).json({ error: 'Product not found' });
    return;
  }
  res.json(item);
}

export async function createProduct(req: Request, res: Response): Promise<void> {
  const created = await productService.create(req.body);
  res.status(201).json(created);
}

export async function updateProduct(req: Request, res: Response): Promise<void> {
  const updated = await productService.update(req.params.id, req.body);
  if (!updated) {
    res.status(404).json({ error: 'Product not found' });
    return;
  }
  res.json(updated);
}

export async function removeProduct(req: Request, res: Response): Promise<void> {
  const removed = await productService.remove(req.params.id);
  res.status(removed ? 204 : 404).end();
}
