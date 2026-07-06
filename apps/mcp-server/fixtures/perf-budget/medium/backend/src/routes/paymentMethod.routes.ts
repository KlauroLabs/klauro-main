import { Router } from 'express';
import {
  listPaymentMethods,
  getPaymentMethod,
  createPaymentMethod,
  updatePaymentMethod,
  removePaymentMethod,
} from '../controllers/paymentMethod.controller';

export const paymentMethodRouter = Router();

paymentMethodRouter.get('/', listPaymentMethods);
paymentMethodRouter.get('/:id', getPaymentMethod);
paymentMethodRouter.post('/', createPaymentMethod);
paymentMethodRouter.put('/:id', updatePaymentMethod);
paymentMethodRouter.delete('/:id', removePaymentMethod);
