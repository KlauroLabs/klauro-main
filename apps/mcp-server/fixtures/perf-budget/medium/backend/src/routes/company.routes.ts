import { Router } from 'express';
import {
  listCompanys,
  getCompany,
  createCompany,
  updateCompany,
  removeCompany,
} from '../controllers/company.controller';

export const companyRouter = Router();

companyRouter.get('/', listCompanys);
companyRouter.get('/:id', getCompany);
companyRouter.post('/', createCompany);
companyRouter.put('/:id', updateCompany);
companyRouter.delete('/:id', removeCompany);
