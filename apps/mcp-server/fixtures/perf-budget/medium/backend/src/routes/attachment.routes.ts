import { Router } from 'express';
import {
  listAttachments,
  getAttachment,
  createAttachment,
  updateAttachment,
  removeAttachment,
} from '../controllers/attachment.controller';

export const attachmentRouter = Router();

attachmentRouter.get('/', listAttachments);
attachmentRouter.get('/:id', getAttachment);
attachmentRouter.post('/', createAttachment);
attachmentRouter.put('/:id', updateAttachment);
attachmentRouter.delete('/:id', removeAttachment);
