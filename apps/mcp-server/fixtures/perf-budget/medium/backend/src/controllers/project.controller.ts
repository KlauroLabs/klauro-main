import { Request, Response } from 'express';
import { projectService } from '../services/project.service';

export async function listProjects(req: Request, res: Response): Promise<void> {
  const items = await projectService.list();
  res.json(items);
}

export async function getProject(req: Request, res: Response): Promise<void> {
  const item = await projectService.get(req.params.id);
  if (!item) {
    res.status(404).json({ error: 'Project not found' });
    return;
  }
  res.json(item);
}

export async function createProject(req: Request, res: Response): Promise<void> {
  const created = await projectService.create(req.body);
  res.status(201).json(created);
}

export async function updateProject(req: Request, res: Response): Promise<void> {
  const updated = await projectService.update(req.params.id, req.body);
  if (!updated) {
    res.status(404).json({ error: 'Project not found' });
    return;
  }
  res.json(updated);
}

export async function removeProject(req: Request, res: Response): Promise<void> {
  const removed = await projectService.remove(req.params.id);
  res.status(removed ? 204 : 404).end();
}
