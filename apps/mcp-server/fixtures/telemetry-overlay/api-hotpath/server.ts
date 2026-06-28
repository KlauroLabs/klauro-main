import express from 'express';

const app = express();

app.get('/users', (_req, res) => {
  res.json([{ id: 1 }]);
});

app.delete('/users/:id', (req, res) => {
  // intermittently throws under load
  res.status(204).end();
});

app.get('/orders', (_req, res) => {
  res.json([{ id: 9 }]);
});

app.listen(3000);
