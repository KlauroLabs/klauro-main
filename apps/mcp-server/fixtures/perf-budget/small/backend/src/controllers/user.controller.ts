import { Request, Response } from 'express';
import { userService } from '../services/user.service';

export async function listUsers(req: Request, res: Response): Promise<void> {
  const items = await userService.list();
  res.json(items);
}

export async function getUser(req: Request, res: Response): Promise<void> {
  const item = await userService.get(req.params.id);
  if (!item) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  res.json(item);
}

export async function createUser(req: Request, res: Response): Promise<void> {
  const created = await userService.create(req.body);
  res.status(201).json(created);
}

export async function updateUser(req: Request, res: Response): Promise<void> {
  const updated = await userService.update(req.params.id, req.body);
  if (!updated) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  res.json(updated);
}

export async function removeUser(req: Request, res: Response): Promise<void> {
  const removed = await userService.remove(req.params.id);
  res.status(removed ? 204 : 404).end();
}
