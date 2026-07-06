import { Router } from 'express';
import {
  listAudits,
  getAudit,
  createAudit,
  updateAudit,
  removeAudit,
} from '../controllers/audit.controller';

export const auditRouter = Router();

auditRouter.get('/', listAudits);
auditRouter.get('/:id', getAudit);
auditRouter.post('/', createAudit);
auditRouter.put('/:id', updateAudit);
auditRouter.delete('/:id', removeAudit);
