import { Request, Response } from 'express';
import { contactService } from '../services/contact.service';

export async function listContacts(req: Request, res: Response): Promise<void> {
  const items = await contactService.list();
  res.json(items);
}

export async function getContact(req: Request, res: Response): Promise<void> {
  const item = await contactService.get(req.params.id);
  if (!item) {
    res.status(404).json({ error: 'Contact not found' });
    return;
  }
  res.json(item);
}

export async function createContact(req: Request, res: Response): Promise<void> {
  const created = await contactService.create(req.body);
  res.status(201).json(created);
}

export async function updateContact(req: Request, res: Response): Promise<void> {
  const updated = await contactService.update(req.params.id, req.body);
  if (!updated) {
    res.status(404).json({ error: 'Contact not found' });
    return;
  }
  res.json(updated);
}

export async function removeContact(req: Request, res: Response): Promise<void> {
  const removed = await contactService.remove(req.params.id);
  res.status(removed ? 204 : 404).end();
}
