import { Router } from 'express';
import {
  listCoupons,
  getCoupon,
  createCoupon,
  updateCoupon,
  removeCoupon,
} from '../controllers/coupon.controller';

export const couponRouter = Router();

couponRouter.get('/', listCoupons);
couponRouter.get('/:id', getCoupon);
couponRouter.post('/', createCoupon);
couponRouter.put('/:id', updateCoupon);
couponRouter.delete('/:id', removeCoupon);
