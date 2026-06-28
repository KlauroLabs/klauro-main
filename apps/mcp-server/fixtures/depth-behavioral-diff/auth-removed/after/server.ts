import express, { Request, Response, NextFunction } from 'express';
import { Pool } from 'pg';

const app = express();
const pool = new Pool();

// AUTH GUARD: still defined and still used by the read route below.
function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.headers.authorization) return res.status(401).json({ error: 'unauthorized' });
  next();
}

// Writes the User entity (privileged admin mutation).
async function promoteUser(id: string): Promise<unknown> {
  return pool.query(`UPDATE users SET role = 'admin' WHERE id = '${id}'`);
}

// A normal authenticated read, so guarding is the norm across the surface.
async function listUsers(): Promise<unknown> {
  return pool.query('SELECT id, email FROM users');
}

// AFTER: the requireAuth guard was REMOVED from the promote route. The privileged
// admin mutation is now reachable without authentication.
app.post('/admin/users/promote', async (req, res) => {
  const id = req.body.id;
  const out = await promoteUser(id);
  res.json(out);
});

app.get('/admin/users', requireAuth, async (_req, res) => {
  const out = await listUsers();
  res.json(out);
});

app.listen(3000);
