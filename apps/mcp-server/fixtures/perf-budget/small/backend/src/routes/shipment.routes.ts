import { Router } from 'express';
import {
  listShipments,
  getShipment,
  createShipment,
  updateShipment,
  removeShipment,
} from '../controllers/shipment.controller';

export const shipmentRouter = Router();

shipmentRouter.get('/', listShipments);
shipmentRouter.get('/:id', getShipment);
shipmentRouter.post('/', createShipment);
shipmentRouter.put('/:id', updateShipment);
shipmentRouter.delete('/:id', removeShipment);
