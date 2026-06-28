import express from 'express';
import { Pool } from 'pg';

const app = express();
const pool = new Pool();

async function listOrders(): Promise<unknown> {
  return pool.query('SELECT id, total FROM orders');
}

// BEFORE: the only capability is reading orders.
app.get('/orders', async (_req, res) => {
  const out = await listOrders();
  res.json(out);
});

app.listen(3000);
