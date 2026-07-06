import { Request, Response } from 'express';
import { settingService } from '../services/setting.service';

export async function listSettings(req: Request, res: Response): Promise<void> {
  const items = await settingService.list();
  res.json(items);
}

export async function getSetting(req: Request, res: Response): Promise<void> {
  const item = await settingService.get(req.params.id);
  if (!item) {
    res.status(404).json({ error: 'Setting not found' });
    return;
  }
  res.json(item);
}

export async function createSetting(req: Request, res: Response): Promise<void> {
  const created = await settingService.create(req.body);
  res.status(201).json(created);
}

export async function updateSetting(req: Request, res: Response): Promise<void> {
  const updated = await settingService.update(req.params.id, req.body);
  if (!updated) {
    res.status(404).json({ error: 'Setting not found' });
    return;
  }
  res.json(updated);
}

export async function removeSetting(req: Request, res: Response): Promise<void> {
  const removed = await settingService.remove(req.params.id);
  res.status(removed ? 204 : 404).end();
}
