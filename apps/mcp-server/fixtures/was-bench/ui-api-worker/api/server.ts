import express from 'express';
const app = express();

app.get('/orders', async (req, res) => {
  const r = await fetch('/tasks');
  res.json(await r.json());
});

app.listen(3000);
