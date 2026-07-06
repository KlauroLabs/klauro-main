import { Router } from 'express';
import {
  listQuotes,
  getQuote,
  createQuote,
  updateQuote,
  removeQuote,
} from '../controllers/quote.controller';

export const quoteRouter = Router();

quoteRouter.get('/', listQuotes);
quoteRouter.get('/:id', getQuote);
quoteRouter.post('/', createQuote);
quoteRouter.put('/:id', updateQuote);
quoteRouter.delete('/:id', removeQuote);
