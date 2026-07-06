import { Request, Response } from 'express';
import { addressService } from '../services/address.service';

export async function listAddresss(req: Request, res: Response): Promise<void> {
  const items = await addressService.list();
  res.json(items);
}

export async function getAddress(req: Request, res: Response): Promise<void> {
  const item = await addressService.get(req.params.id);
  if (!item) {
    res.status(404).json({ error: 'Address not found' });
    return;
  }
  res.json(item);
}

export async function createAddress(req: Request, res: Response): Promise<void> {
  const created = await addressService.create(req.body);
  res.status(201).json(created);
}

export async function updateAddress(req: Request, res: Response): Promise<void> {
  const updated = await addressService.update(req.params.id, req.body);
  if (!updated) {
    res.status(404).json({ error: 'Address not found' });
    return;
  }
  res.json(updated);
}

export async function removeAddress(req: Request, res: Response): Promise<void> {
  const removed = await addressService.remove(req.params.id);
  res.status(removed ? 204 : 404).end();
}
