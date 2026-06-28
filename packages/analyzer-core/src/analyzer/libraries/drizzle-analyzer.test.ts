import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs-extra';
import * as os from 'node:os';
import * as path from 'node:path';
import { DrizzleAnalyzer } from './orm/drizzle-analyzer';

async function makeProject(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'drizzle-analyzer-test-'));
  await fs.writeJson(path.join(dir, 'package.json'), {
    name: 'drizzle-fixture',
    dependencies: { 'drizzle-orm': '^0.30.0' }
  });

  const src = path.join(dir, 'src');
  await fs.ensureDir(src);

  await fs.writeFile(path.join(src, 'schema.ts'), [
    "import { pgTable, serial, text, integer } from 'drizzle-orm/pg-core';",
    "import { relations } from 'drizzle-orm';",
    '',
    "export const users = pgTable('users', {",
    "  id: serial('id').primaryKey(),",
    "  email: text('email').notNull().unique(),",
    "  name: text('name'),",
    '});',
    '',
    "export const posts = pgTable('posts', {",
    "  id: serial('id').primaryKey(),",
    "  title: text('title').notNull(),",
    "  authorId: integer('author_id').references(() => users.id),",
    '});',
    '',
    'export const usersRelations = relations(users, ({ many }) => ({',
    '  posts: many(posts),',
    '}));',
    '',
  ].join('\n'));

  return dir;
}

test('DrizzleAnalyzer extracts tables, columns, and relations', async () => {
  const dir = await makeProject();
  try {
    const analyzer = new DrizzleAnalyzer();
    assert.equal(await analyzer.canAnalyze(dir), true);

    const result = await analyzer.analyze({ projectPath: dir });

    const entities = result.nodes.filter(n => n.type === 'entity');
    const usersEntity = entities.find(n => n.name === 'users');
    assert.ok(usersEntity, 'expected a users entity node');
    assert.equal(usersEntity!.metadata?.orm, 'Drizzle');

    const userFields = result.nodes.filter(
      n => n.type === 'field' && (n.metadata as any)?.entity === 'users'
    );
    assert.ok(userFields.length >= 2, `expected >=2 field nodes, got ${userFields.length}`);

    const relationEdges = result.edges.filter(e => e.type === 'references');
    assert.ok(relationEdges.length >= 1, 'expected >=1 relation edge between entities');
    // both the FK (posts -> users) and relations() (users -> posts) should resolve
    const targets = new Set(relationEdges.map(e => e.target));
    assert.ok(
      targets.has('entity_drizzle_users') || targets.has('entity_drizzle_posts'),
      'relation edge should target another entity'
    );
  } finally {
    await fs.remove(dir);
  }
});
