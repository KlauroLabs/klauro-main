import { Router } from 'express';
import {
  listShipmentLegs,
  getShipmentLeg,
  createShipmentLeg,
  updateShipmentLeg,
  removeShipmentLeg,
} from '../controllers/shipmentLeg.controller';

export const shipmentLegRouter = Router();

shipmentLegRouter.get('/', listShipmentLegs);
shipmentLegRouter.get('/:id', getShipmentLeg);
shipmentLegRouter.post('/', createShipmentLeg);
shipmentLegRouter.put('/:id', updateShipmentLeg);
shipmentLegRouter.delete('/:id', removeShipmentLeg);
