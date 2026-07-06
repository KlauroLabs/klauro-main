import { Router } from 'express';
import {
  listDeals,
  getDeal,
  createDeal,
  updateDeal,
  removeDeal,
} from '../controllers/deal.controller';

export const dealRouter = Router();

dealRouter.get('/', listDeals);
dealRouter.get('/:id', getDeal);
dealRouter.post('/', createDeal);
dealRouter.put('/:id', updateDeal);
dealRouter.delete('/:id', removeDeal);
