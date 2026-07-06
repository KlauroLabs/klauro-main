import { Router } from 'express';
import {
  listWebhooks,
  getWebhook,
  createWebhook,
  updateWebhook,
  removeWebhook,
} from '../controllers/webhook.controller';

export const webhookRouter = Router();

webhookRouter.get('/', listWebhooks);
webhookRouter.get('/:id', getWebhook);
webhookRouter.post('/', createWebhook);
webhookRouter.put('/:id', updateWebhook);
webhookRouter.delete('/:id', removeWebhook);
