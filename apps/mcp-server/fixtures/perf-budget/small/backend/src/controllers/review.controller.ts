import { Request, Response } from 'express';
import { reviewService } from '../services/review.service';

export async function listReviews(req: Request, res: Response): Promise<void> {
  const items = await reviewService.list();
  res.json(items);
}

export async function getReview(req: Request, res: Response): Promise<void> {
  const item = await reviewService.get(req.params.id);
  if (!item) {
    res.status(404).json({ error: 'Review not found' });
    return;
  }
  res.json(item);
}

export async function createReview(req: Request, res: Response): Promise<void> {
  const created = await reviewService.create(req.body);
  res.status(201).json(created);
}

export async function updateReview(req: Request, res: Response): Promise<void> {
  const updated = await reviewService.update(req.params.id, req.body);
  if (!updated) {
    res.status(404).json({ error: 'Review not found' });
    return;
  }
  res.json(updated);
}

export async function removeReview(req: Request, res: Response): Promise<void> {
  const removed = await reviewService.remove(req.params.id);
  res.status(removed ? 204 : 404).end();
}
