import { Router } from 'express';
import {
  listUsers,
  getUser,
  createUser,
  updateUser,
  removeUser,
} from '../controllers/user.controller';

export const userRouter = Router();

userRouter.get('/', listUsers);
userRouter.get('/:id', getUser);
userRouter.post('/', createUser);
userRouter.put('/:id', updateUser);
userRouter.delete('/:id', removeUser);
