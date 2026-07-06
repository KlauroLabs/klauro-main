import { Router } from 'express';
import {
  listDevices,
  getDevice,
  createDevice,
  updateDevice,
  removeDevice,
} from '../controllers/device.controller';

export const deviceRouter = Router();

deviceRouter.get('/', listDevices);
deviceRouter.get('/:id', getDevice);
deviceRouter.post('/', createDevice);
deviceRouter.put('/:id', updateDevice);
deviceRouter.delete('/:id', removeDevice);
