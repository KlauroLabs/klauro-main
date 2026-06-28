import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs-extra';
import * as os from 'node:os';
import * as path from 'node:path';
import { TypeORMAnalyzer } from './orm/typeorm-analyzer';

async function makeProject(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'typeorm-analyzer-test-'));
  await fs.writeJson(path.join(dir, 'package.json'), {
    name: 'typeorm-fixture',
    dependencies: { typeorm: '^0.3.0' }
  });

  const entities = path.join(dir, 'src', 'entity');
  await fs.ensureDir(entities);

  await fs.writeFile(path.join(entities, 'User.ts'), [
    "import { Entity, PrimaryGeneratedColumn, Column, OneToMany } from 'typeorm';",
    "import { Post } from './Post';",
    '',
    "@Entity('users')",
    'export class User {',
    '  @PrimaryGeneratedColumn()',
    '  id: number;',
    '',
    "  @Column('varchar')",
    '  email: string;',
    '',
    '  @Column()',
    '  name: string;',
    '',
    '  @OneToMany(() => Post, post => post.author)',
    '  posts: Post[];',
    '}',
    '',
  ].join('\n'));

  await fs.writeFile(path.join(entities, 'Post.ts'), [
    "import { Entity, PrimaryGeneratedColumn, Column, ManyToOne } from 'typeorm';",
    "import { User } from './User';",
    '',
    '@Entity()',
    'export class Post {',
    '  @PrimaryGeneratedColumn()',
    '  id: number;',
    '',
    '  @Column()',
    '  title: string;',
    '',
    '  @ManyToOne(() => User, user => user.posts)',
    '  author: User;',
    '}',
    '',
  ].join('\n'));

  return dir;
}

test('TypeORMAnalyzer extracts entities, columns, and relations', async () => {
  const dir = await makeProject();
  try {
    const analyzer = new TypeORMAnalyzer();
    assert.equal(await analyzer.canAnalyze(dir), true);

    const result = await analyzer.analyze({ projectPath: dir });

    const entities = result.nodes.filter(n => n.type === 'entity');
    const userEntity = entities.find(n => n.name === 'User');
    assert.ok(userEntity, 'expected a User entity node');
    assert.equal(userEntity!.metadata?.orm, 'TypeORM');

    const userFields = result.nodes.filter(
      n => n.type === 'field' && (n.metadata as any)?.entity === 'User'
    );
    assert.ok(userFields.length >= 2, `expected >=2 field nodes, got ${userFields.length}`);

    const relationEdges = result.edges.filter(e => e.type === 'references');
    assert.ok(relationEdges.length >= 1, 'expected >=1 relation edge between entities');
    const targets = new Set(relationEdges.map(e => e.target));
    assert.ok(
      targets.has('entity_typeorm_post') || targets.has('entity_typeorm_user'),
      'relation edge should target another entity'
    );
  } finally {
    await fs.remove(dir);
  }
});
