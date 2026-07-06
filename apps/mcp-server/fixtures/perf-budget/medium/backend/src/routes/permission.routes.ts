import { Router } from 'express';
import {
  listPermissions,
  getPermission,
  createPermission,
  updatePermission,
  removePermission,
} from '../controllers/permission.controller';

export const permissionRouter = Router();

permissionRouter.get('/', listPermissions);
permissionRouter.get('/:id', getPermission);
permissionRouter.post('/', createPermission);
permissionRouter.put('/:id', updatePermission);
permissionRouter.delete('/:id', removePermission);
