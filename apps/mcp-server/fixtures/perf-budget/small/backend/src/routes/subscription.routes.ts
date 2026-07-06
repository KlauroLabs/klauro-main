import { Router } from 'express';
import {
  listSubscriptions,
  getSubscription,
  createSubscription,
  updateSubscription,
  removeSubscription,
} from '../controllers/subscription.controller';

export const subscriptionRouter = Router();

subscriptionRouter.get('/', listSubscriptions);
subscriptionRouter.get('/:id', getSubscription);
subscriptionRouter.post('/', createSubscription);
subscriptionRouter.put('/:id', updateSubscription);
subscriptionRouter.delete('/:id', removeSubscription);
