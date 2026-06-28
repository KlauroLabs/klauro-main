import { Hono } from 'hono';

const app = new Hono();

app.get('/users', (c) => c.json([]));
app.post('/users', (c) => c.json({ ok: true }, 201));
app.delete('/users/:id', (c) => c.body(null, 204));

export default app;
