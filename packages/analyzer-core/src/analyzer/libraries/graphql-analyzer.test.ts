import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs-extra';
import * as os from 'node:os';
import * as path from 'node:path';
import { GraphQLAnalyzer } from './graphql-analyzer';

async function makeProject(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'graphql-analyzer-test-'));
  await fs.writeJson(path.join(dir, 'package.json'), {
    name: 'graphql-fixture',
    dependencies: { graphql: '^16.0.0', '@apollo/server': '^4.0.0' }
  });

  const src = path.join(dir, 'src');
  await fs.ensureDir(src);

  // SDL schema with a data type + Query root operation.
  await fs.writeFile(path.join(src, 'schema.graphql'), [
    'type User {',
    '  id: ID!',
    '  name: String!',
    '}',
    '',
    'type Query {',
    '  user(id: ID!): User',
    '}',
    '',
  ].join('\n'));

  // Apollo-style resolver map for the Query.user operation.
  await fs.writeFile(path.join(src, 'resolvers.ts'), [
    'export const resolvers = {',
    '  Query: {',
    '    user: (_parent: unknown, args: { id: string }) => {',
    '      return { id: args.id, name: "Ada" };',
    '    },',
    '  },',
    '};',
    '',
  ].join('\n'));

  return dir;
}

test('GraphQLAnalyzer extracts SDL types, operations, resolvers, and entry points', async () => {
  const dir = await makeProject();
  try {
    const analyzer = new GraphQLAnalyzer();

    assert.equal(await analyzer.canAnalyze(dir), true, 'should detect GraphQL');

    const result = await analyzer.analyze({ projectPath: dir });

    // type User { id: ID! } -> entity node with fields.
    const userType = result.nodes.find(n => n.type === 'entity' && n.name === 'User');
    assert.ok(userType, 'User type node exists');
    const fieldNames = (userType!.metadata?.fields || []).map((f: any) => f.name).sort();
    assert.deepEqual(fieldNames, ['id', 'name']);

    // Query.user -> operation node.
    const userOp = result.nodes.find(n => n.type === 'operation' && n.name === 'user');
    assert.ok(userOp, 'user operation node exists');
    assert.equal(userOp!.metadata?.operationType, 'Query');
    assert.equal(userOp!.metadata?.returnType, 'User');
    assert.equal(userOp!.metadata?.hasResolver, true, 'operation linked to resolver');

    // Resolver node + resolved_by edge.
    const resolverNode = result.nodes.find(n => n.type === 'resolver');
    assert.ok(resolverNode, 'resolver node exists');
    assert.ok(
      result.edges.some(e => e.type === 'resolved_by'),
      'operation -> resolver edge exists'
    );

    // Operation is an entry point.
    const ep = result.entry_points.find(e => e.name === 'user');
    assert.ok(ep, 'user operation is an entry point');
    assert.equal(ep!.metadata?.operationType, 'Query');
    assert.equal(ep!.output?.type, 'User');
  } finally {
    await fs.remove(dir);
  }
});
