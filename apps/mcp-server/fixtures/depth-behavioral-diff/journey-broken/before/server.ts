import express from 'express';
import { Pool } from 'pg';

const app = express();
const pool = new Pool();

// SINK: writes the Payment entity (the terminal effect of the checkout journey).
async function recordPayment(orderId: string, amount: number): Promise<unknown> {
  return pool.query(
    `INSERT INTO payments (order_id, amount) VALUES ('${orderId}', ${amount})`,
  );
}

// Cross-function hop: the checkout handler delegates to this to reach the sink.
async function settleOrder(orderId: string, amount: number): Promise<unknown> {
  return recordPayment(orderId, amount);
}

// BEFORE: checkout reaches the Payment sink via settleOrder -> recordPayment.
app.post('/checkout', async (req, res) => {
  const out = await settleOrder(req.body.orderId, req.body.amount);
  res.json(out);
});

app.listen(3000);
