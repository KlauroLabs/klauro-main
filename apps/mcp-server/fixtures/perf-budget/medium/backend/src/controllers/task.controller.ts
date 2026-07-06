import { Request, Response } from 'express';
import { taskService } from '../services/task.service';

export async function listTasks(req: Request, res: Response): Promise<void> {
  const items = await taskService.list();
  res.json(items);
}

export async function getTask(req: Request, res: Response): Promise<void> {
  const item = await taskService.get(req.params.id);
  if (!item) {
    res.status(404).json({ error: 'Task not found' });
    return;
  }
  res.json(item);
}

export async function createTask(req: Request, res: Response): Promise<void> {
  const created = await taskService.create(req.body);
  res.status(201).json(created);
}

export async function updateTask(req: Request, res: Response): Promise<void> {
  const updated = await taskService.update(req.params.id, req.body);
  if (!updated) {
    res.status(404).json({ error: 'Task not found' });
    return;
  }
  res.json(updated);
}

export async function removeTask(req: Request, res: Response): Promise<void> {
  const removed = await taskService.remove(req.params.id);
  res.status(removed ? 204 : 404).end();
}
