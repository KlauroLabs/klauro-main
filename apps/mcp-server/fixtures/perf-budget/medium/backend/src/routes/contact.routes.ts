import { Router } from 'express';
import {
  listContacts,
  getContact,
  createContact,
  updateContact,
  removeContact,
} from '../controllers/contact.controller';

export const contactRouter = Router();

contactRouter.get('/', listContacts);
contactRouter.get('/:id', getContact);
contactRouter.post('/', createContact);
contactRouter.put('/:id', updateContact);
contactRouter.delete('/:id', removeContact);
