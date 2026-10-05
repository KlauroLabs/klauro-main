import { Router } from 'express';

export const router = Router();

router.get('/recent', (req, res) => res.json([]));

export default router;
