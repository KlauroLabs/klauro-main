import { Router } from 'express';
import {
  listInvoiceLines,
  getInvoiceLine,
  createInvoiceLine,
  updateInvoiceLine,
  removeInvoiceLine,
} from '../controllers/invoiceLine.controller';

export const invoiceLineRouter = Router();

invoiceLineRouter.get('/', listInvoiceLines);
invoiceLineRouter.get('/:id', getInvoiceLine);
invoiceLineRouter.post('/', createInvoiceLine);
invoiceLineRouter.put('/:id', updateInvoiceLine);
invoiceLineRouter.delete('/:id', removeInvoiceLine);
