import { Router } from 'express';
import {
  listDiscounts,
  getDiscount,
  createDiscount,
  updateDiscount,
  removeDiscount,
} from '../controllers/discount.controller';

export const discountRouter = Router();

discountRouter.get('/', listDiscounts);
discountRouter.get('/:id', getDiscount);
discountRouter.post('/', createDiscount);
discountRouter.put('/:id', updateDiscount);
discountRouter.delete('/:id', removeDiscount);
