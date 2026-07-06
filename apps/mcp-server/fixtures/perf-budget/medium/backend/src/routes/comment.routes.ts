import { Router } from 'express';
import {
  listComments,
  getComment,
  createComment,
  updateComment,
  removeComment,
} from '../controllers/comment.controller';

export const commentRouter = Router();

commentRouter.get('/', listComments);
commentRouter.get('/:id', getComment);
commentRouter.post('/', createComment);
commentRouter.put('/:id', updateComment);
commentRouter.delete('/:id', removeComment);
