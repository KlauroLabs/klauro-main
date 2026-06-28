import express from 'express';
import { Pool } from 'pg';

const app = express();
const pool = new Pool();

// SINK: raw SQL execution against the database.
async function runQuery(sql: string): Promise<unknown> {
  return pool.query(sql);
}

// CROSS-FUNCTION HOP: builds a query string from a caller-supplied id.
function buildUserQuery(id: string): string {
  return `SELECT * FROM users WHERE id = '${id}'`;
}

// Carries the tainted id from the handler down to the query builder + sink.
async function getUser(id: string): Promise<unknown> {
  const sql = buildUserQuery(id);
  return runQuery(sql);
}

// SOURCE: req.body.id is attacker-controlled user input.
app.post('/users/lookup', async (req, res) => {
  const id = req.body.id;
  const user = await getUser(id);
  res.json(user);
});

app.listen(3000);
