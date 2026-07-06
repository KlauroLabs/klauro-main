import { Request, Response } from 'express';
import { shipmentService } from '../services/shipment.service';

export async function listShipments(req: Request, res: Response): Promise<void> {
  const items = await shipmentService.list();
  res.json(items);
}

export async function getShipment(req: Request, res: Response): Promise<void> {
  const item = await shipmentService.get(req.params.id);
  if (!item) {
    res.status(404).json({ error: 'Shipment not found' });
    return;
  }
  res.json(item);
}

export async function createShipment(req: Request, res: Response): Promise<void> {
  const created = await shipmentService.create(req.body);
  res.status(201).json(created);
}

export async function updateShipment(req: Request, res: Response): Promise<void> {
  const updated = await shipmentService.update(req.params.id, req.body);
  if (!updated) {
    res.status(404).json({ error: 'Shipment not found' });
    return;
  }
  res.json(updated);
}

export async function removeShipment(req: Request, res: Response): Promise<void> {
  const removed = await shipmentService.remove(req.params.id);
  res.status(removed ? 204 : 404).end();
}
