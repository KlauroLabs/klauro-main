import { Request, Response } from 'express';
import { couponService } from '../services/coupon.service';

export async function listCoupons(req: Request, res: Response): Promise<void> {
  const items = await couponService.list();
  res.json(items);
}

export async function getCoupon(req: Request, res: Response): Promise<void> {
  const item = await couponService.get(req.params.id);
  if (!item) {
    res.status(404).json({ error: 'Coupon not found' });
    return;
  }
  res.json(item);
}

export async function createCoupon(req: Request, res: Response): Promise<void> {
  const created = await couponService.create(req.body);
  res.status(201).json(created);
}

export async function updateCoupon(req: Request, res: Response): Promise<void> {
  const updated = await couponService.update(req.params.id, req.body);
  if (!updated) {
    res.status(404).json({ error: 'Coupon not found' });
    return;
  }
  res.json(updated);
}

export async function removeCoupon(req: Request, res: Response): Promise<void> {
  const removed = await couponService.remove(req.params.id);
  res.status(removed ? 204 : 404).end();
}
