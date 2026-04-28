import express from 'express';

const app = express();

interface Account {
  id: string;
  name: string;
  balance: number;
}

const accounts = new Map<string, Account>([
  ['acct_1', { id: 'acct_1', name: 'Operating', balance: 1400 }],
]);

export function getAccount(req: express.Request, res: express.Response) {
  const account = accounts.get(req.params.id);
  if (!account) {
    res.status(404).json({ error: 'missing account' });
    return;
  }

  res.json(account);
}

app.get('/api/accounts/:id', getAccount);

export { app };
