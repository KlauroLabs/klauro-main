import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs-extra';
import * as os from 'node:os';
import * as path from 'node:path';
import { DapperAnalyzer } from './dapper-analyzer';
import { KnexAnalyzer } from './knex-analyzer';
import { SqlxAnalyzer } from './sqlx-analyzer';

test('ORM analyzers preserve every query site beyond the former forty-site cap', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orm-query-completeness-'));
  try {
    const dapperRoot = path.join(root, 'dapper');
    const knexRoot = path.join(root, 'knex');
    const sqlxRoot = path.join(root, 'sqlx');
    await Promise.all([fs.ensureDir(dapperRoot), fs.ensureDir(knexRoot), fs.ensureDir(sqlxRoot)]);
    await fs.writeFile(path.join(dapperRoot, 'Queries.cs'), [
      'using Dapper;',
      ...Array.from({ length: 55 }, (_, index) => `db.Query("SELECT * FROM Table${index}");`),
    ].join('\n'));
    await fs.writeFile(path.join(knexRoot, 'queries.ts'),
      Array.from({ length: 55 }, (_, index) => `knex('table${index}').select();`).join('\n'));
    await fs.writeFile(path.join(sqlxRoot, 'queries.rs'),
      Array.from({ length: 55 }, (_, index) => `sqlx::query!("SELECT * FROM table${index}");`).join('\n'));

    const results = await Promise.all([
      new DapperAnalyzer().analyze({ projectPath: dapperRoot } as any),
      new KnexAnalyzer().analyze({ projectPath: knexRoot } as any),
      new SqlxAnalyzer().analyze({ projectPath: sqlxRoot } as any),
    ]);

    assert.deepEqual(results.map(result => result.exit_points.length), [55, 55, 55]);
    assert.deepEqual(results.map(result => result.nodes.filter(node => node.type === 'database_query').length), [55, 55, 55]);
  } finally {
    await fs.remove(root);
  }
});

test('ORM source probes inspect candidates beyond the former four-hundred-file prefix', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orm-probe-completeness-'));
  try {
    const dapperRoot = path.join(root, 'dapper');
    const knexRoot = path.join(root, 'knex');
    const sqlxRoot = path.join(root, 'sqlx');
    await Promise.all([fs.ensureDir(dapperRoot), fs.ensureDir(knexRoot), fs.ensureDir(sqlxRoot)]);
    for (let index = 0; index < 401; index += 1) {
      const name = `${String(index).padStart(3, '0')}_plain`;
      await Promise.all([
        fs.writeFile(path.join(dapperRoot, `${name}.cs`), 'class Plain {}\n'),
        fs.writeFile(path.join(knexRoot, `${name}.ts`), 'export const plain = true;\n'),
        fs.writeFile(path.join(sqlxRoot, `${name}.rs`), 'fn plain() {}\n'),
      ]);
    }
    await fs.writeFile(path.join(dapperRoot, 'zzz_queries.cs'), 'using Dapper;\nvar rows = db.Query("SELECT * FROM Accounts");\n');
    await fs.writeFile(path.join(knexRoot, 'zzz_queries.ts'), `knex.schema.createTable('accounts', () => {});\n`);
    await fs.writeFile(path.join(sqlxRoot, 'zzz_queries.rs'), 'sqlx::query!("SELECT * FROM accounts");\n');

    assert.equal(await new DapperAnalyzer().canAnalyze(dapperRoot), true);
    assert.equal(await new KnexAnalyzer().canAnalyze(knexRoot), true);
    assert.equal(await new SqlxAnalyzer().canAnalyze(sqlxRoot), true);
  } finally {
    await fs.remove(root);
  }
});
