import { Router } from 'express';
import {
  listInventorys,
  getInventory,
  createInventory,
  updateInventory,
  removeInventory,
} from '../controllers/inventory.controller';

export const inventoryRouter = Router();

inventoryRouter.get('/', listInventorys);
inventoryRouter.get('/:id', getInventory);
inventoryRouter.post('/', createInventory);
inventoryRouter.put('/:id', updateInventory);
inventoryRouter.delete('/:id', removeInventory);
