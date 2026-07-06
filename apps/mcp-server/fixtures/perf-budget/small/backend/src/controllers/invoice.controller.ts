import { Request, Response } from 'express';
import { invoiceService } from '../services/invoice.service';

export async function listInvoices(req: Request, res: Response): Promise<void> {
  const items = await invoiceService.list();
  res.json(items);
}

export async function getInvoice(req: Request, res: Response): Promise<void> {
  const item = await invoiceService.get(req.params.id);
  if (!item) {
    res.status(404).json({ error: 'Invoice not found' });
    return;
  }
  res.json(item);
}

export async function createInvoice(req: Request, res: Response): Promise<void> {
  const created = await invoiceService.create(req.body);
  res.status(201).json(created);
}

export async function updateInvoice(req: Request, res: Response): Promise<void> {
  const updated = await invoiceService.update(req.params.id, req.body);
  if (!updated) {
    res.status(404).json({ error: 'Invoice not found' });
    return;
  }
  res.json(updated);
}

export async function removeInvoice(req: Request, res: Response): Promise<void> {
  const removed = await invoiceService.remove(req.params.id);
  res.status(removed ? 204 : 404).end();
}
