import { Router } from 'express';
import {
  listProducts,
  getProduct,
  createProduct,
  updateProduct,
  removeProduct,
} from '../controllers/product.controller';

export const productRouter = Router();

productRouter.get('/', listProducts);
productRouter.get('/:id', getProduct);
productRouter.post('/', createProduct);
productRouter.put('/:id', updateProduct);
productRouter.delete('/:id', removeProduct);
