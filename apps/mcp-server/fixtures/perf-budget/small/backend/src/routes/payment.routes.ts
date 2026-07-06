import { Router } from 'express';
import {
  listPayments,
  getPayment,
  createPayment,
  updatePayment,
  removePayment,
} from '../controllers/payment.controller';

export const paymentRouter = Router();

paymentRouter.get('/', listPayments);
paymentRouter.get('/:id', getPayment);
paymentRouter.post('/', createPayment);
paymentRouter.put('/:id', updatePayment);
paymentRouter.delete('/:id', removePayment);
