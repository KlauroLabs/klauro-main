import { Router } from 'express';
import {
  listSessions,
  getSession,
  createSession,
  updateSession,
  removeSession,
} from '../controllers/session.controller';

export const sessionRouter = Router();

sessionRouter.get('/', listSessions);
sessionRouter.get('/:id', getSession);
sessionRouter.post('/', createSession);
sessionRouter.put('/:id', updateSession);
sessionRouter.delete('/:id', removeSession);
