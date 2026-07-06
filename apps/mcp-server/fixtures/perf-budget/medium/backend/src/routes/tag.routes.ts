import { Router } from 'express';
import {
  listTags,
  getTag,
  createTag,
  updateTag,
  removeTag,
} from '../controllers/tag.controller';

export const tagRouter = Router();

tagRouter.get('/', listTags);
tagRouter.get('/:id', getTag);
tagRouter.post('/', createTag);
tagRouter.put('/:id', updateTag);
tagRouter.delete('/:id', removeTag);
