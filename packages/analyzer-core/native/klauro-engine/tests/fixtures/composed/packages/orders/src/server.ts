import express from 'express';
import { money } from '../../shared/src/format';

const app = express();

app.get('/api/orders/:id', (request, response) => {
  response.json({ total: money(5) });
});

app.post('/api/orders', (request, response) => {
  response.json({ created: true });
});

app.listen(3000);
