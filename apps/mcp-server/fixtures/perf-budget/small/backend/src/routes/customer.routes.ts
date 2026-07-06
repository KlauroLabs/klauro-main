import { Router } from 'express';
import {
  listCustomers,
  getCustomer,
  createCustomer,
  updateCustomer,
  removeCustomer,
} from '../controllers/customer.controller';

export const customerRouter = Router();

customerRouter.get('/', listCustomers);
customerRouter.get('/:id', getCustomer);
customerRouter.post('/', createCustomer);
customerRouter.put('/:id', updateCustomer);
customerRouter.delete('/:id', removeCustomer);
