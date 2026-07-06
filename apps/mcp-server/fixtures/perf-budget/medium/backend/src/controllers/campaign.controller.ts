import { Request, Response } from 'express';
import { campaignService } from '../services/campaign.service';

export async function listCampaigns(req: Request, res: Response): Promise<void> {
  const items = await campaignService.list();
  res.json(items);
}

export async function getCampaign(req: Request, res: Response): Promise<void> {
  const item = await campaignService.get(req.params.id);
  if (!item) {
    res.status(404).json({ error: 'Campaign not found' });
    return;
  }
  res.json(item);
}

export async function createCampaign(req: Request, res: Response): Promise<void> {
  const created = await campaignService.create(req.body);
  res.status(201).json(created);
}

export async function updateCampaign(req: Request, res: Response): Promise<void> {
  const updated = await campaignService.update(req.params.id, req.body);
  if (!updated) {
    res.status(404).json({ error: 'Campaign not found' });
    return;
  }
  res.json(updated);
}

export async function removeCampaign(req: Request, res: Response): Promise<void> {
  const removed = await campaignService.remove(req.params.id);
  res.status(removed ? 204 : 404).end();
}
