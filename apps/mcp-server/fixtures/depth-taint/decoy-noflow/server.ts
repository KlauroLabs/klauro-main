import express from 'express';
import { Pool } from 'pg';

const app = express();
const pool = new Pool();

// SINK: raw SQL execution.
async function execSql(sql: string): Promise<unknown> {
  return pool.query(sql);
}

// Reaches the sink: builds a query from the tainted id.
function buildDeleteQuery(id: string): string {
  return `DELETE FROM sessions WHERE id = '${id}'`;
}

async function deleteSession(id: string): Promise<unknown> {
  const sql = buildDeleteQuery(id);
  return execSql(sql);
}

// REAL FLOW: req.body.id -> deleteSession -> buildDeleteQuery -> execSql (SINK).
app.post('/sessions/delete', async (req, res) => {
  const id = req.body.id;
  await deleteSession(id);
  res.status(204).end();
});

// DECOY: a same-named `id` that is only echoed back. It never calls
// deleteSession / buildDeleteQuery / execSql, so it does NOT reach the SQL sink.
function formatLabel(id: string): string {
  return `session-${id}`;
}

app.get('/sessions/label', (req, res) => {
  const id = req.query.id as string;
  const label = formatLabel(id);
  res.json({ label });
});

app.listen(3000);
