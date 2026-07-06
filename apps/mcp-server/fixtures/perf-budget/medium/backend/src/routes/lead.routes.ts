import { Router } from 'express';
import {
  listLeads,
  getLead,
  createLead,
  updateLead,
  removeLead,
} from '../controllers/lead.controller';

export const leadRouter = Router();

leadRouter.get('/', listLeads);
leadRouter.get('/:id', getLead);
leadRouter.post('/', createLead);
leadRouter.put('/:id', updateLead);
leadRouter.delete('/:id', removeLead);
