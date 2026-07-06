import { Router } from 'express';
import {
  listRefunds,
  getRefund,
  createRefund,
  updateRefund,
  removeRefund,
} from '../controllers/refund.controller';

export const refundRouter = Router();

refundRouter.get('/', listRefunds);
refundRouter.get('/:id', getRefund);
refundRouter.post('/', createRefund);
refundRouter.put('/:id', updateRefund);
refundRouter.delete('/:id', removeRefund);
