import { Router } from 'express';
import {
  listAddresss,
  getAddress,
  createAddress,
  updateAddress,
  removeAddress,
} from '../controllers/address.controller';

export const addressRouter = Router();

addressRouter.get('/', listAddresss);
addressRouter.get('/:id', getAddress);
addressRouter.post('/', createAddress);
addressRouter.put('/:id', updateAddress);
addressRouter.delete('/:id', removeAddress);
