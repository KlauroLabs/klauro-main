import express from 'express';
const app = express();
app.get('/api/orders/:id', (req, res) => res.json({ id: '1', amount: 0, verified: true }));
app.get('/api/coupons/:id', (req, res) => res.json({ code: 'X', percent: 10 }));
export { app };
