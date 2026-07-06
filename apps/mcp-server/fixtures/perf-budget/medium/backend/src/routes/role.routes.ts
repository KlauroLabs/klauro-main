import { Router } from 'express';
import {
  listRoles,
  getRole,
  createRole,
  updateRole,
  removeRole,
} from '../controllers/role.controller';

export const roleRouter = Router();

roleRouter.get('/', listRoles);
roleRouter.get('/:id', getRole);
roleRouter.post('/', createRole);
roleRouter.put('/:id', updateRole);
roleRouter.delete('/:id', removeRole);
