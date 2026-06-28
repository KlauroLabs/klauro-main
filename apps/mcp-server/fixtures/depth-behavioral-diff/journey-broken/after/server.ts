import express from 'express';
import { Pool } from 'pg';

const app = express();
const pool = new Pool();

// SINK: still defined, but the checkout journey no longer reaches it.
async function recordPayment(orderId: string, amount: number): Promise<unknown> {
  return pool.query(
    `INSERT INTO payments (order_id, amount) VALUES ('${orderId}', ${amount})`,
  );
}

// Cross-function hop, now orphaned: nothing calls settleOrder anymore.
async function settleOrder(orderId: string, amount: number): Promise<unknown> {
  return recordPayment(orderId, amount);
}

// AFTER: the checkout handler was BROKEN — it no longer calls settleOrder, so the
// journey never reaches the Payment sink. The terminal payment effect is gone.
app.post('/checkout', async (req, res) => {
  res.json({ status: 'queued', orderId: req.body.orderId });
});

app.listen(3000);
