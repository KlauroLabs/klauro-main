import express from 'express';
const app = express();
app.get('/api/members/:id', (req, res) => res.json({ id: '1', points: 0, tier: 'gold' }));
app.get('/api/rewards/:id', (req, res) => res.json({ id: '1', label: 'coffee' }));
export { app };
