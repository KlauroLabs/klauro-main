import { Router } from 'express';
import {
  listTasks,
  getTask,
  createTask,
  updateTask,
  removeTask,
} from '../controllers/task.controller';

export const taskRouter = Router();

taskRouter.get('/', listTasks);
taskRouter.get('/:id', getTask);
taskRouter.post('/', createTask);
taskRouter.put('/:id', updateTask);
taskRouter.delete('/:id', removeTask);
