import { Router } from 'express';
import {
  listRenewals,
  getRenewal,
  createRenewal,
  updateRenewal,
  removeRenewal,
} from '../controllers/renewal.controller';

export const renewalRouter = Router();

renewalRouter.get('/', listRenewals);
renewalRouter.get('/:id', getRenewal);
renewalRouter.post('/', createRenewal);
renewalRouter.put('/:id', updateRenewal);
renewalRouter.delete('/:id', removeRenewal);
