import { Router } from 'express';
import {
  listWarehouses,
  getWarehouse,
  createWarehouse,
  updateWarehouse,
  removeWarehouse,
} from '../controllers/warehouse.controller';

export const warehouseRouter = Router();

warehouseRouter.get('/', listWarehouses);
warehouseRouter.get('/:id', getWarehouse);
warehouseRouter.post('/', createWarehouse);
warehouseRouter.put('/:id', updateWarehouse);
warehouseRouter.delete('/:id', removeWarehouse);
