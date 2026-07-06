import { Router } from 'express';
import {
  listCarts,
  getCart,
  createCart,
  updateCart,
  removeCart,
} from '../controllers/cart.controller';

export const cartRouter = Router();

cartRouter.get('/', listCarts);
cartRouter.get('/:id', getCart);
cartRouter.post('/', createCart);
cartRouter.put('/:id', updateCart);
cartRouter.delete('/:id', removeCart);
