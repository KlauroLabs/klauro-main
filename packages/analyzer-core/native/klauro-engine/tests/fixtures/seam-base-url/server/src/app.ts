import express from 'express';

const app = express();

app.get('/api/orders', (request, response) => {
  response.json([]);
});

app.get('/api/orders/:id', (request, response) => {
  response.json({});
});

app.post('/api/customers', (request, response) => {
  response.json({});
});

app.get('/api/invoices/:id/pay', (request, response) => {
  response.json({});
});

app.delete('/api/shipments/:id', (request, response) => {
  response.json({});
});

app.listen(4000);
