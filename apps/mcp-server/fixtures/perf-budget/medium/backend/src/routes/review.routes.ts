import { Router } from 'express';
import {
  listReviews,
  getReview,
  createReview,
  updateReview,
  removeReview,
} from '../controllers/review.controller';

export const reviewRouter = Router();

reviewRouter.get('/', listReviews);
reviewRouter.get('/:id', getReview);
reviewRouter.post('/', createReview);
reviewRouter.put('/:id', updateReview);
reviewRouter.delete('/:id', removeReview);
