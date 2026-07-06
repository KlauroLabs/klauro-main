import { Request, Response } from 'express';
import { customerService } from '../services/customer.service';

export async function listCustomers(req: Request, res: Response): Promise<void> {
  const items = await customerService.list();
  res.json(items);
}

export async function getCustomer(req: Request, res: Response): Promise<void> {
  const item = await customerService.get(req.params.id);
  if (!item) {
    res.status(404).json({ error: 'Customer not found' });
    return;
  }
  res.json(item);
}

export async function createCustomer(req: Request, res: Response): Promise<void> {
  const created = await customerService.create(req.body);
  res.status(201).json(created);
}

export async function updateCustomer(req: Request, res: Response): Promise<void> {
  const updated = await customerService.update(req.params.id, req.body);
  if (!updated) {
    res.status(404).json({ error: 'Customer not found' });
    return;
  }
  res.json(updated);
}

export async function removeCustomer(req: Request, res: Response): Promise<void> {
  const removed = await customerService.remove(req.params.id);
  res.status(removed ? 204 : 404).end();
}
