import { Router } from 'express';
import {
  listContracts,
  getContract,
  createContract,
  updateContract,
  removeContract,
} from '../controllers/contract.controller';

export const contractRouter = Router();

contractRouter.get('/', listContracts);
contractRouter.get('/:id', getContract);
contractRouter.post('/', createContract);
contractRouter.put('/:id', updateContract);
contractRouter.delete('/:id', removeContract);
