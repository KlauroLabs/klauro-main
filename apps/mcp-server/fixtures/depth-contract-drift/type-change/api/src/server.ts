import express from 'express';
const app = express();
app.get('/api/wallets/:id', (req, res) => res.json({ id: '1', email: 'a@b.c', balance: 0 }));
app.get('/api/invoices/:id', (req, res) => res.json({ id: '1', total: 0 }));
export { app };
