import express from 'express';
const app = express();

function requireAuth(req: any, res: any, next: any) {
  if (!req.headers.authorization) return res.status(401).end();
  next();
}

app.get('/users', (req, res) => res.json([]));
app.post('/users', requireAuth, (req, res) => res.status(201).end());
app.delete('/users/:id', requireAuth, (req, res) => res.status(204).end());

app.listen(3000);
