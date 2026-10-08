import express from 'express';
import { indexRepository } from './indexing';

const app = express();

app.post('/repositories/index', async (req, res) => {
  res.json(await indexRepository(req.body.path));
});

app.listen(3000);
