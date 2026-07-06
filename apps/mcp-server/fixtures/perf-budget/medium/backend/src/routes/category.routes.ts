import { Router } from 'express';
import {
  listCategorys,
  getCategory,
  createCategory,
  updateCategory,
  removeCategory,
} from '../controllers/category.controller';

export const categoryRouter = Router();

categoryRouter.get('/', listCategorys);
categoryRouter.get('/:id', getCategory);
categoryRouter.post('/', createCategory);
categoryRouter.put('/:id', updateCategory);
categoryRouter.delete('/:id', removeCategory);
