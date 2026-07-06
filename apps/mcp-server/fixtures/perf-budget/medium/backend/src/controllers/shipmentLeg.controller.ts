import { Request, Response } from 'express';
import { shipmentLegService } from '../services/shipmentLeg.service';

export async function listShipmentLegs(req: Request, res: Response): Promise<void> {
  const items = await shipmentLegService.list();
  res.json(items);
}

export async function getShipmentLeg(req: Request, res: Response): Promise<void> {
  const item = await shipmentLegService.get(req.params.id);
  if (!item) {
    res.status(404).json({ error: 'ShipmentLeg not found' });
    return;
  }
  res.json(item);
}

export async function createShipmentLeg(req: Request, res: Response): Promise<void> {
  const created = await shipmentLegService.create(req.body);
  res.status(201).json(created);
}

export async function updateShipmentLeg(req: Request, res: Response): Promise<void> {
  const updated = await shipmentLegService.update(req.params.id, req.body);
  if (!updated) {
    res.status(404).json({ error: 'ShipmentLeg not found' });
    return;
  }
  res.json(updated);
}

export async function removeShipmentLeg(req: Request, res: Response): Promise<void> {
  const removed = await shipmentLegService.remove(req.params.id);
  res.status(removed ? 204 : 404).end();
}
