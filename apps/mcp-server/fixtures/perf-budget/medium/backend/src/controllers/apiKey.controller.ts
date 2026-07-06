import { Request, Response } from 'express';
import { apiKeyService } from '../services/apiKey.service';

export async function listApiKeys(req: Request, res: Response): Promise<void> {
  const items = await apiKeyService.list();
  res.json(items);
}

export async function getApiKey(req: Request, res: Response): Promise<void> {
  const item = await apiKeyService.get(req.params.id);
  if (!item) {
    res.status(404).json({ error: 'ApiKey not found' });
    return;
  }
  res.json(item);
}

export async function createApiKey(req: Request, res: Response): Promise<void> {
  const created = await apiKeyService.create(req.body);
  res.status(201).json(created);
}

export async function updateApiKey(req: Request, res: Response): Promise<void> {
  const updated = await apiKeyService.update(req.params.id, req.body);
  if (!updated) {
    res.status(404).json({ error: 'ApiKey not found' });
    return;
  }
  res.json(updated);
}

export async function removeApiKey(req: Request, res: Response): Promise<void> {
  const removed = await apiKeyService.remove(req.params.id);
  res.status(removed ? 204 : 404).end();
}
