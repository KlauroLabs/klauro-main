import express, { Request, Response, NextFunction } from 'express';
import { Pool } from 'pg';

const app = express();
const pool = new Pool();

function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.headers.authorization) return res.status(401).json({ error: 'unauthorized' });
  next();
}

async function saveProfile(userId: string, bio: string): Promise<unknown> {
  return pool.query(`UPDATE users SET bio = '${bio}' WHERE id = '${userId}'`);
}

app.post('/profile', requireAuth, async (req, res) => {
  const userId = req.body.userId;
  const bio = req.body.bio;
  const out = await saveProfile(userId, bio);
  res.json(out);
});

app.listen(3000);
