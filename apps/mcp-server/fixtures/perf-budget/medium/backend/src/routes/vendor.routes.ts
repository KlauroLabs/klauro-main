import { Router } from 'express';
import {
  listVendors,
  getVendor,
  createVendor,
  updateVendor,
  removeVendor,
} from '../controllers/vendor.controller';

export const vendorRouter = Router();

vendorRouter.get('/', listVendors);
vendorRouter.get('/:id', getVendor);
vendorRouter.post('/', createVendor);
vendorRouter.put('/:id', updateVendor);
vendorRouter.delete('/:id', removeVendor);
