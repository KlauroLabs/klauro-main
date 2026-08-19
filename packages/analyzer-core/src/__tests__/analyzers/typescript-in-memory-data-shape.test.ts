jest.unmock('fs-extra');
jest.unmock('fs');
jest.unmock('glob');

import * as fs from 'fs-extra';
import * as os from 'node:os';
import * as path from 'node:path';
import { TypeScriptJavaScriptAnalyzer } from '../../analyzer/languages/typescript-javascript-analyzer';
import { AnalyzerOrchestrator } from '../../analyzer/core/orchestrator';
import { extractInMemoryRecordCollections } from '../../analyzer/core/javascript-in-memory-data';
import type { CASNode } from '../../types/cas.types';

describe('exported in-memory record collections', () => {
  const source = [
    'var pets = exports.pets = [];',
    "pets.push({ name: 'Tobi', id: 0 });",
    'var users = exports.users = [];',
    "users.push({ name: 'Ada', pets: [pets[0]], id: 0 });",
  ].join('\n');

  it('derives record names and fields from exported collection writes', () => {
    expect(extractInMemoryRecordCollections(source)).toEqual([
      {
        variable: 'pets',
        name: 'Pet',
        line: 1,
        fields: [{ name: 'id', type: 'number' }, { name: 'name', type: 'string' }],
      },
      {
        variable: 'users',
        name: 'User',
        line: 3,
        fields: [
          { name: 'id', type: 'number' },
          { name: 'name', type: 'string' },
          { name: 'pets', type: 'array' },
        ],
      },
    ]);
  });

  it('emits domain-shape nodes through the language analyzer', async () => {
    const project = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-in-memory-records-'));
    try {
      await fs.writeFile(path.join(project, 'db.js'), source);
      const contribution = await new TypeScriptJavaScriptAnalyzer().analyze({ projectPath: project } as any);
      const pet = contribution.nodes?.find(node => node.type === 'model' && node.name === 'Pet');
      expect(pet?.subcategories).toEqual(expect.arrayContaining(['domain-shape', 'in-memory-store']));
      expect((pet?.metadata?.attributes as Record<string, unknown>)?.fields).toEqual([
        { name: 'id', type: 'number' },
        { name: 'name', type: 'string' },
      ]);
    } finally {
      await fs.remove(project);
    }
  });

  it('attributes REST lifecycle operations to the terminal route resource', () => {
    const model = (id: string, name: string): CASNode => ({
      id,
      name,
      type: 'model',
      level: 3,
      category: 'structures',
      subcategories: ['domain-shape', 'in-memory-store'],
      metadata: { attributes: { fields: [{ name: 'id', type: 'number' }] } },
    });
    const route = (id: string, name: string, method: string, routePath: string): CASNode => ({
      id,
      name,
      type: 'route',
      level: 3,
      category: 'route',
      metadata: { attributes: { method, path: routePath } },
    });
    const nodes = [
      model('model_user', 'User'),
      model('model_pet', 'Pet'),
      route('route_create_pet', 'POST /user/:user_id/pet', 'post', '/user/:user_id/pet'),
      route('route_update_user', 'PUT /user/:user_id', 'put', '/user/:user_id'),
    ];
    const entities = (new AnalyzerOrchestrator() as any).buildDataEntities(nodes, []);
    const user = entities.find((entity: { name: string }) => entity.name === 'User');
    const pet = entities.find((entity: { name: string }) => entity.name === 'Pet');
    expect(pet.lifecycle.created_by).toContain('route_create_pet');
    expect(user.lifecycle.created_by).not.toContain('route_create_pet');
    expect(user.lifecycle.updated_by).toContain('route_update_user');
  });
});
