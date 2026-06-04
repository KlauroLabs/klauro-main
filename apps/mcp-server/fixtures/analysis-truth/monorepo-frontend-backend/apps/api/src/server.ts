import express from 'express';

const app = express();

export function getAccount(req: express.Request, res: express.Response) {
  res.json({ id: req.params.id, balance: 42 });
}

app.get('/api/accounts/:id', getAccount);
app.listen(3001);
