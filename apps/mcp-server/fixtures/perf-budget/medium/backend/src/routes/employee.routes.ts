import { Router } from 'express';
import {
  listEmployees,
  getEmployee,
  createEmployee,
  updateEmployee,
  removeEmployee,
} from '../controllers/employee.controller';

export const employeeRouter = Router();

employeeRouter.get('/', listEmployees);
employeeRouter.get('/:id', getEmployee);
employeeRouter.post('/', createEmployee);
employeeRouter.put('/:id', updateEmployee);
employeeRouter.delete('/:id', removeEmployee);
