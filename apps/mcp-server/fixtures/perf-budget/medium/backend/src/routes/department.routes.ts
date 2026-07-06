import { Router } from 'express';
import {
  listDepartments,
  getDepartment,
  createDepartment,
  updateDepartment,
  removeDepartment,
} from '../controllers/department.controller';

export const departmentRouter = Router();

departmentRouter.get('/', listDepartments);
departmentRouter.get('/:id', getDepartment);
departmentRouter.post('/', createDepartment);
departmentRouter.put('/:id', updateDepartment);
departmentRouter.delete('/:id', removeDepartment);
