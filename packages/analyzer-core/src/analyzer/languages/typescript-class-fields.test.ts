import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TypeScriptJavaScriptAnalyzer } from './typescript-javascript-analyzer';
import type { CASNode } from '../../types/cas.types';

// A type and its fields were both in the index and unconnected. 19,474 property
// nodes, 1,034 classes and interfaces, and no type that could reach its own
// fields: `has_field` was 49 edges across a whole 136,928-node graph, and
// properties hung off the file that contained them.
//
// Methods in the same function already emitted a contains edge to their class,
// and Swift and Kotlin already parented their properties. TypeScript did not,
// on 17,936 of its 17,936 properties.
//
// Entities are a comprehension member and an entity is a named thing with
// fields. Nothing above this can be right while a type does not know what it
// holds.

const SOURCE = `
export interface Session {
  id: string;
  startedAt: Date;
  transcript?: string;
}

export class CallManager {
  #provider: VoiceProvider;
  readonly storePath: string;
  static instances = 0;
  private active = new Map<string, Session>();

  constructor(provider: VoiceProvider) {
    this.#provider = provider;
    this.storePath = '';
  }

  async endCall(id: string): Promise<boolean> {
    return this.active.delete(id);
  }
}
`;

async function analyzeAsync(): Promise<{ nodes: CASNode[]; edges: Array<{ source: string; target: string; type: string }> }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-fields-'));
  try {
    fs.writeFileSync(path.join(root, 'manager.ts'), SOURCE);
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0' }));
    const analyzer = new TypeScriptJavaScriptAnalyzer();
    const contribution = await analyzer.analyze({ projectPath: root } as never);
    return {
      nodes: (contribution.nodes || []) as CASNode[],
      edges: (contribution.edges || []) as Array<{ source: string; target: string; type: string }>
    };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('every class and interface field is parented to the type that declares it', async () => {
  const { nodes } = await analyzeAsync();
  const properties = nodes.filter(n => n.type === 'property');
  assert.ok(properties.length >= 6, `expected the fixture's fields, saw ${properties.length}`);

  const byId = new Map(nodes.map(n => [n.id, n]));
  for (const property of properties) {
    assert.ok(property.parent, `${property.name} has no parent`);
    const owner = byId.get(property.parent!);
    assert.ok(owner, `${property.name} points at a parent that is not in the graph`);
    assert.ok(['class', 'interface', 'type', 'dto'].includes(String(owner!.type)),
      `${property.name} is parented to a ${owner!.type}`);
  }
});

test('a type can reach its own fields through has_field edges', async () => {
  const { nodes, edges } = await analyzeAsync();
  const manager = nodes.find(n => n.name === 'CallManager');
  assert.ok(manager, 'the class itself is in the graph');

  const fields = edges
    .filter(e => e.type === 'has_field' && e.source === manager!.id)
    .map(e => nodes.find(n => n.id === e.target)?.name);
  assert.deepEqual(fields.sort(), ['#provider', 'active', 'instances', 'storePath'].sort());
});

test('a declared field type is recorded on the field', async () => {
  const { nodes } = await analyzeAsync();
  const storePath = nodes.find(n => n.type === 'property' && n.name === 'storePath');
  assert.ok(storePath);
  assert.equal(storePath!.signature?.return_type, 'string');
});

test('an interface field carries its type too', async () => {
  const { nodes } = await analyzeAsync();
  const id = nodes.find(n => n.type === 'property' && n.name === 'id');
  assert.ok(id);
  assert.equal(id!.signature?.return_type, 'string');
});

test('a field with no annotation is still parented, just untyped', async () => {
  // JavaScript class fields often carry no type. That is the source being
  // untyped, not the index losing something, so the field still belongs to its
  // class and simply has no return type.
  const { nodes } = await analyzeAsync();
  const instances = nodes.find(n => n.type === 'property' && n.name === 'instances');
  assert.ok(instances);
  assert.ok(instances!.parent, 'still owned by its class');
});
