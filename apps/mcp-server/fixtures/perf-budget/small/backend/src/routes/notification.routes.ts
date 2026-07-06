import { Router } from 'express';
import {
  listNotifications,
  getNotification,
  createNotification,
  updateNotification,
  removeNotification,
} from '../controllers/notification.controller';

export const notificationRouter = Router();

notificationRouter.get('/', listNotifications);
notificationRouter.get('/:id', getNotification);
notificationRouter.post('/', createNotification);
notificationRouter.put('/:id', updateNotification);
notificationRouter.delete('/:id', removeNotification);
