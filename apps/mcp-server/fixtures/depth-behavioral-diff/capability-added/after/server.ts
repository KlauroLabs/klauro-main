import express from 'express';
import { Pool } from 'pg';

const app = express();
const pool = new Pool();

async function listOrders(): Promise<unknown> {
  return pool.query('SELECT id, total FROM orders');
}

// NEW SINK: issuing a refund writes the Refund entity.
async function issueRefund(orderId: string, amount: number): Promise<unknown> {
  return pool.query(
    `INSERT INTO refunds (order_id, amount) VALUES ('${orderId}', ${amount})`,
  );
}

app.get('/orders', async (_req, res) => {
  const out = await listOrders();
  res.json(out);
});

// AFTER: a brand-new refund capability + journey reaching a new Refund sink.
app.post('/orders/refund', async (req, res) => {
  const out = await issueRefund(req.body.orderId, req.body.amount);
  res.json(out);
});

app.listen(3000);
