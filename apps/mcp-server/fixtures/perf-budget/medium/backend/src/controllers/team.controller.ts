import { Request, Response } from 'express';
import { teamService } from '../services/team.service';

export async function listTeams(req: Request, res: Response): Promise<void> {
  const items = await teamService.list();
  res.json(items);
}

export async function getTeam(req: Request, res: Response): Promise<void> {
  const item = await teamService.get(req.params.id);
  if (!item) {
    res.status(404).json({ error: 'Team not found' });
    return;
  }
  res.json(item);
}

export async function createTeam(req: Request, res: Response): Promise<void> {
  const created = await teamService.create(req.body);
  res.status(201).json(created);
}

export async function updateTeam(req: Request, res: Response): Promise<void> {
  const updated = await teamService.update(req.params.id, req.body);
  if (!updated) {
    res.status(404).json({ error: 'Team not found' });
    return;
  }
  res.json(updated);
}

export async function removeTeam(req: Request, res: Response): Promise<void> {
  const removed = await teamService.remove(req.params.id);
  res.status(removed ? 204 : 404).end();
}
