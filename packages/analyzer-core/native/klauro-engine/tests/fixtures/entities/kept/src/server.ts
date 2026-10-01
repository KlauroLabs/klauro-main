import express from 'express';
import { AccountStore } from './store';

const app = express();
const store = new AccountStore('accounts.json');

app.post('/register', async (req, res) => {
  res.json(await store.register(req.body.email));
});

app.post('/workspaces', async (req, res) => {
  res.json(await store.openWorkspace(req.body.name, req.body.owner));
});

app.get('/workspaces', async (req, res) => {
  res.json(await store.listWorkspaces());
});

app.listen(3000);
