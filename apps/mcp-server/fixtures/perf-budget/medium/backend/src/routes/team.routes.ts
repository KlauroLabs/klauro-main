import { Router } from 'express';
import {
  listTeams,
  getTeam,
  createTeam,
  updateTeam,
  removeTeam,
} from '../controllers/team.controller';

export const teamRouter = Router();

teamRouter.get('/', listTeams);
teamRouter.get('/:id', getTeam);
teamRouter.post('/', createTeam);
teamRouter.put('/:id', updateTeam);
teamRouter.delete('/:id', removeTeam);
