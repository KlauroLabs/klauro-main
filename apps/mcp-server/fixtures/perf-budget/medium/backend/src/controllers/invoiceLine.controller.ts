import { Request, Response } from 'express';
import { invoiceLineService } from '../services/invoiceLine.service';

export async function listInvoiceLines(req: Request, res: Response): Promise<void> {
  const items = await invoiceLineService.list();
  res.json(items);
}

export async function getInvoiceLine(req: Request, res: Response): Promise<void> {
  const item = await invoiceLineService.get(req.params.id);
  if (!item) {
    res.status(404).json({ error: 'InvoiceLine not found' });
    return;
  }
  res.json(item);
}

export async function createInvoiceLine(req: Request, res: Response): Promise<void> {
  const created = await invoiceLineService.create(req.body);
  res.status(201).json(created);
}

export async function updateInvoiceLine(req: Request, res: Response): Promise<void> {
  const updated = await invoiceLineService.update(req.params.id, req.body);
  if (!updated) {
    res.status(404).json({ error: 'InvoiceLine not found' });
    return;
  }
  res.json(updated);
}

export async function removeInvoiceLine(req: Request, res: Response): Promise<void> {
  const removed = await invoiceLineService.remove(req.params.id);
  res.status(removed ? 204 : 404).end();
}
