import express from 'express';

const app = express();

app.post('/checkout', async (_req, res) => {
  await chargeGateway(100);
  res.json({ ok: true });
});

app.get('/health', (_req, res) => {
  res.json({ status: 'up' });
});

export async function chargeGateway(amount: number) {
  const r = await fetch('/external/charge', { method: 'POST', body: String(amount) });
  return r.json();
}

app.listen(4000);
