import express from 'express';
const app = express();
app.get('/api/profiles/:id', (req, res) => res.json({ id: '1', email: 'x@y.z', displayName: 'n' }));
app.get('/api/settings/:id', (req, res) => res.json({ id: '1', theme: 'dark' }));
export { app };
