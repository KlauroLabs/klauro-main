import { Router } from 'express';
import {
  listInvoices,
  getInvoice,
  createInvoice,
  updateInvoice,
  removeInvoice,
} from '../controllers/invoice.controller';

export const invoiceRouter = Router();

invoiceRouter.get('/', listInvoices);
invoiceRouter.get('/:id', getInvoice);
invoiceRouter.post('/', createInvoice);
invoiceRouter.put('/:id', updateInvoice);
invoiceRouter.delete('/:id', removeInvoice);
