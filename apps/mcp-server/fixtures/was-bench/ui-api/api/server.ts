import express from 'express';
const app = express();
app.get('/invoices', (req, res) => res.json([]));
app.post('/invoices', (req, res) => res.json({ ok: true }));
app.listen(3000);
