import { Router } from 'express';
import {
  listOrders,
  getOrder,
  createOrder,
  updateOrder,
  removeOrder,
} from '../controllers/order.controller';

export const orderRouter = Router();

orderRouter.get('/', listOrders);
orderRouter.get('/:id', getOrder);
orderRouter.post('/', createOrder);
orderRouter.put('/:id', updateOrder);
orderRouter.delete('/:id', removeOrder);
