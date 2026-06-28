import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs-extra';
import * as os from 'node:os';
import * as path from 'node:path';
import { MongooseAnalyzer } from './orm/mongoose-analyzer';

async function makeProject(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mongoose-analyzer-test-'));
  await fs.writeJson(path.join(dir, 'package.json'), {
    name: 'mongoose-fixture',
    dependencies: { mongoose: '^8.0.0' }
  });

  const models = path.join(dir, 'src', 'models');
  await fs.ensureDir(models);

  await fs.writeFile(path.join(models, 'User.ts'), [
    "import mongoose, { Schema } from 'mongoose';",
    '',
    'const UserSchema = new Schema({',
    '  email: { type: String, required: true, unique: true },',
    '  name: { type: String },',
    "  posts: [{ type: Schema.Types.ObjectId, ref: 'Post' }],",
    '});',
    '',
    "export const User = mongoose.model('User', UserSchema);",
    '',
  ].join('\n'));

  await fs.writeFile(path.join(models, 'Post.ts'), [
    "import mongoose, { Schema } from 'mongoose';",
    '',
    'const PostSchema = new Schema({',
    '  title: { type: String, required: true },',
    "  author: { type: Schema.Types.ObjectId, ref: 'User' },",
    '});',
    '',
    "export const Post = mongoose.model('Post', PostSchema);",
    '',
  ].join('\n'));

  return dir;
}

test('MongooseAnalyzer extracts schemas, fields, and refs', async () => {
  const dir = await makeProject();
  try {
    const analyzer = new MongooseAnalyzer();
    assert.equal(await analyzer.canAnalyze(dir), true);

    const result = await analyzer.analyze({ projectPath: dir });

    const entities = result.nodes.filter(n => n.type === 'entity');
    const userEntity = entities.find(n => n.name === 'User');
    assert.ok(userEntity, 'expected a User entity node (from mongoose.model name)');
    assert.equal(userEntity!.metadata?.orm, 'Mongoose');

    const userFields = result.nodes.filter(
      n => n.type === 'field' && (n.metadata as any)?.entity === 'User'
    );
    assert.ok(userFields.length >= 2, `expected >=2 field nodes, got ${userFields.length}`);

    const relationEdges = result.edges.filter(e => e.type === 'references');
    assert.ok(relationEdges.length >= 1, 'expected >=1 ref relation edge between entities');
    const targets = new Set(relationEdges.map(e => e.target));
    assert.ok(
      targets.has('entity_mongoose_userschema') || targets.has('entity_mongoose_postschema'),
      'ref edge should target another entity'
    );
  } finally {
    await fs.remove(dir);
  }
});
