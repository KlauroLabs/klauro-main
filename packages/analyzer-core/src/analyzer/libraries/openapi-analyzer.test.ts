import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs-extra';
import * as os from 'node:os';
import * as path from 'node:path';
import { OpenAPIAnalyzer } from './openapi-analyzer';

const SPEC = {
  openapi: '3.0.3',
  info: { title: 'User API', version: '1.0.0' },
  paths: {
    '/users': {
      get: {
        operationId: 'listUsers',
        summary: 'List users',
        tags: ['users'],
        responses: {
          '200': {
            description: 'ok',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/User' } } },
          },
        },
      },
      post: {
        operationId: 'createUser',
        summary: 'Create a user',
        tags: ['users'],
        requestBody: {
          content: { 'application/json': { schema: { $ref: '#/components/schemas/User' } } },
        },
        responses: { '201': { description: 'created' } },
      },
    },
  },
  components: {
    schemas: {
      User: {
        type: 'object',
        required: ['id', 'email'],
        properties: {
          id: { type: 'integer' },
          email: { type: 'string' },
        },
      },
    },
  },
};

async function makeProject(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'openapi-analyzer-test-'));
  await fs.writeJson(path.join(dir, 'openapi.json'), SPEC, { spaces: 2 });
  return dir;
}

test('OpenAPIAnalyzer extracts operations, schemas, entry points, and contract edges', async () => {
  const dir = await makeProject();
  try {
    const analyzer = new OpenAPIAnalyzer();
    assert.equal(await analyzer.canAnalyze(dir), true);

    const result = await analyzer.analyze({ projectPath: dir });

    const operations = result.nodes.filter(n => n.type === 'api-operation');
    assert.equal(operations.length, 2, 'two operations');
    assert.ok(operations.some(o => o.metadata?.httpMethod === 'GET' && o.metadata?.httpPath === '/users'));
    assert.ok(operations.every(o => o.metadata?.attributes?.execution_role === 'declaration'));
    assert.ok(result.entry_points.every(e => e.metadata?.execution_role === 'declaration'));
    assert.ok(operations.some(o => o.metadata?.httpMethod === 'POST' && o.metadata?.httpPath === '/users'));

    // operations -> entry points
    assert.equal(result.entry_points.length, 2, 'two entry points');
    assert.ok(result.entry_points.every(e => e.type === 'http'));

    // User schema entity
    const userSchema = result.nodes.find(n => n.type === 'entity' && n.name === 'User');
    assert.ok(userSchema, 'User schema entity present');
    const fieldNames = (userSchema!.metadata?.fields as any[]).map(f => f.name);
    assert.deepEqual(fieldNames.sort(), ['email', 'id']);
    const idField = (userSchema!.metadata?.fields as any[]).find(f => f.name === 'id');
    assert.equal(idField.required, true, 'id is required');

    // contract reference: operation -> User schema
    const contractEdge = result.edges.find(
      e => e.category === 'contract' && e.target === userSchema!.id
    );
    assert.ok(contractEdge, 'operation references User schema (contract edge)');
  } finally {
    await fs.remove(dir);
  }
});

test('OpenAPIAnalyzer supports incremental single-file analysis', async () => {
  const dir = await makeProject();
  try {
    const analyzer = new OpenAPIAnalyzer();
    assert.equal(analyzer.supportsIncrementalAnalysis(), true);
    const files = await analyzer.getRelevantFiles!(dir);
    assert.ok(files.includes('openapi.json'));

    const rel = 'openapi.json';
    const single = await analyzer.analyzeFileSingle!({
      projectPath: dir,
      filePath: path.join(dir, rel),
      relativePath: rel,
    });
    assert.ok(single.nodes.some(n => n.type === 'api-operation'));
    assert.ok(single.nodes.some(n => n.type === 'entity' && n.name === 'User'));
    assert.equal(single.entryPoints.length, 2);
  } finally {
    await fs.remove(dir);
  }
});
