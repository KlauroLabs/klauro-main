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

/**
 * Regression guards for the entry-point SURFACE, not just extraction.
 *
 * GraphQL operations used to be emitted as `route` entry points with no line
 * number, which made an entire protocol surface unaskable: "what are the GraphQL
 * entry points?" could not be answered because they were indistinguishable from
 * browser routes, and nothing carried the resolver's file:line. These lock in the
 * distinct kind, the operation identity, and both locations (contract + code).
 */

test('a schema-first SDL Query field yields a graphql entry point with contract and resolver locations', async () => {
  const dir = await makeProject();
  try {
    const result = await new GraphQLAnalyzer().analyze({ projectPath: dir });

    const gqlEntries = result.entry_points.filter(e => e.type === 'graphql');
    assert.equal(gqlEntries.length, 1, 'the single SDL Query field is one graphql entry point');
    assert.equal(
      result.entry_points.filter(e => e.type === 'route').length,
      0,
      'GraphQL operations must not masquerade as routes'
    );

    const ep = gqlEntries[0];
    assert.equal(ep.trigger?.pattern, 'Query.user', 'addressed by operation name');
    assert.equal(ep.trigger?.method, 'Query');
    assert.equal(ep.metadata?.resolverMethod, 'user', 'names the fulfilling code symbol');
    // Resolver implementation: src/resolvers.ts line 3 (`user:` in the Query map).
    assert.equal(ep.handler?.file, 'src/resolvers.ts');
    assert.equal(ep.handler?.line, 3);
    // Schema declaration site is reported separately from the implementation.
    assert.equal(ep.metadata?.declaredAt, 'src/schema.graphql:7');
  } finally {
    await fs.remove(dir);
  }
});

test('a code-first @Query/@Mutation/@ResolveField each yield one graphql entry point, field resolvers scoped to their object type', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'graphql-codefirst-test-'));
  try {
    await fs.writeJson(path.join(dir, 'package.json'), {
      name: 'codefirst-fixture',
      dependencies: { '@nestjs/graphql': '^12.0.0' }
    });
    // Two resolver classes each declaring a `posts` field resolver: the object
    // type must keep them apart, or one silently overwrites the other.
    await fs.writeFile(path.join(dir, 'resolvers.ts'), [
      "import { Resolver, Query, Mutation, ResolveField } from '@nestjs/graphql';",
      '',
      '@Resolver(() => User)',
      'export class UserResolver {',
      '  @Query(() => [User])',
      '  async users() { return []; }',
      '',
      '  @Mutation(() => User)',
      '  async createUser() { return null; }',
      '',
      '  @ResolveField(() => [Post])',
      '  async posts() { return []; }',
      '}',
      '',
      '@Resolver(() => Team)',
      'export class TeamResolver {',
      '  @ResolveField(() => [Post])',
      '  async posts() { return []; }',
      '}',
      '',
    ].join('\n'));

    const analyzer = new GraphQLAnalyzer();
    assert.equal(await analyzer.canAnalyze(dir), true, '@nestjs/graphql is a GraphQL marker');
    const result = await analyzer.analyze({ projectPath: dir });

    const patterns = result.entry_points
      .filter(e => e.type === 'graphql')
      .map(e => e.trigger?.pattern)
      .sort();
    assert.deepEqual(patterns, ['Mutation.createUser', 'Query.users', 'Team.posts', 'User.posts']);

    const userPosts = result.entry_points.find(e => e.trigger?.pattern === 'User.posts');
    assert.equal(userPosts?.metadata?.parentType, 'User');
    assert.equal(userPosts?.metadata?.operationType, 'Field');
    assert.equal(userPosts?.handler?.line, 11, 'anchored to its @ResolveField decorator');
    assert.equal(
      result.entry_points.find(e => e.trigger?.pattern === 'Team.posts')?.handler?.line,
      17
    );
  } finally {
    await fs.remove(dir);
  }
});

test('SDL embedded in a gql template literal reports host-file line numbers', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'graphql-embedded-test-'));
  try {
    await fs.writeJson(path.join(dir, 'package.json'), {
      name: 'embedded-fixture',
      dependencies: { graphql: '^16.0.0' }
    });
    await fs.writeFile(path.join(dir, 'schema.ts'), [
      "import { gql } from 'graphql-tag';",           // 1
      '',                                              // 2
      'export const typeDefs = gql`',                  // 3
      '  type Query {',                                // 4
      '    health: String!',                           // 5
      '    version: String!',                          // 6
      '  }',                                           // 7
      '`;',                                            // 8
      '',
    ].join('\n'));

    const result = await new GraphQLAnalyzer().analyze({ projectPath: dir });
    const byName = new Map(
      result.entry_points.filter(e => e.type === 'graphql').map(e => [e.name, e])
    );
    assert.deepEqual([...byName.keys()].sort(), ['health', 'version']);
    // Lines are host-file lines, not offsets within the template literal.
    assert.equal(byName.get('health')!.metadata?.declaredAt, 'schema.ts:5');
    assert.equal(byName.get('version')!.metadata?.declaredAt, 'schema.ts:6');
  } finally {
    await fs.remove(dir);
  }
});
