import express from 'express';
const app = express();

function requireAuth(req: any, res: any, next: any) {
  next();
}

function listUsers(req: any, res: any) {
  res.json([]);
}

app.get('/users', listUsers);
app.post('/users', requireAuth, (req: any, res: any) => res.status(201).end());
app.delete('/users/:id', requireAuth, listUsers);
