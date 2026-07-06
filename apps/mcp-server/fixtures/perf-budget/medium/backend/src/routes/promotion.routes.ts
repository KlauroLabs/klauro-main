import { Router } from 'express';
import {
  listPromotions,
  getPromotion,
  createPromotion,
  updatePromotion,
  removePromotion,
} from '../controllers/promotion.controller';

export const promotionRouter = Router();

promotionRouter.get('/', listPromotions);
promotionRouter.get('/:id', getPromotion);
promotionRouter.post('/', createPromotion);
promotionRouter.put('/:id', updatePromotion);
promotionRouter.delete('/:id', removePromotion);
