import { Router } from 'express';
import {
  listProjects,
  getProject,
  createProject,
  updateProject,
  removeProject,
} from '../controllers/project.controller';

export const projectRouter = Router();

projectRouter.get('/', listProjects);
projectRouter.get('/:id', getProject);
projectRouter.post('/', createProject);
projectRouter.put('/:id', updateProject);
projectRouter.delete('/:id', removeProject);
