import { Request, Response } from 'express';
import { deviceService } from '../services/device.service';

export async function listDevices(req: Request, res: Response): Promise<void> {
  const items = await deviceService.list();
  res.json(items);
}

export async function getDevice(req: Request, res: Response): Promise<void> {
  const item = await deviceService.get(req.params.id);
  if (!item) {
    res.status(404).json({ error: 'Device not found' });
    return;
  }
  res.json(item);
}

export async function createDevice(req: Request, res: Response): Promise<void> {
  const created = await deviceService.create(req.body);
  res.status(201).json(created);
}

export async function updateDevice(req: Request, res: Response): Promise<void> {
  const updated = await deviceService.update(req.params.id, req.body);
  if (!updated) {
    res.status(404).json({ error: 'Device not found' });
    return;
  }
  res.json(updated);
}

export async function removeDevice(req: Request, res: Response): Promise<void> {
  const removed = await deviceService.remove(req.params.id);
  res.status(removed ? 204 : 404).end();
}
