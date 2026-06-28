import express, { Request, Response, NextFunction } from 'express';
import { Pool } from 'pg';

const app = express();
const pool = new Pool();

// CONTROL CHANGE: this file is a pure rename + whitespace/comment reformat of the
// before version. Same route, same auth guard, same handler -> saveProfile -> the
// same UPDATE users sink. No behavioral change should be reported.
function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.headers.authorization) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

async function saveProfile(uid: string, biography: string): Promise<unknown> {
  return pool.query(`UPDATE users SET bio = '${biography}' WHERE id = '${uid}'`);
}

app.post('/profile', requireAuth, async (req, res) => {
  const uid = req.body.userId;
  const biography = req.body.bio;

  const out = await saveProfile(uid, biography);

  res.json(out);
});

app.listen(3000);
