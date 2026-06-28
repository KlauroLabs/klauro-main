import express from 'express';
const app = express();
app.get('/tasks', (req, res) => res.json([]));
app.listen(4000);
