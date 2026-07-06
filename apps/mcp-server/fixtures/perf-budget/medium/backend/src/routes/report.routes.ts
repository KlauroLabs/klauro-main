import { Router } from 'express';
import {
  listReports,
  getReport,
  createReport,
  updateReport,
  removeReport,
} from '../controllers/report.controller';

export const reportRouter = Router();

reportRouter.get('/', listReports);
reportRouter.get('/:id', getReport);
reportRouter.post('/', createReport);
reportRouter.put('/:id', updateReport);
reportRouter.delete('/:id', removeReport);
