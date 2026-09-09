jest.unmock('fs');
jest.unmock('fs-extra');
jest.unmock('glob');

import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { TypeScriptJavaScriptAnalyzer } from '../../analyzer/languages/typescript-javascript-analyzer';
import type { CASExitPoint } from '../../types/cas.types';

/**
 * THE DEFECT UNDER TEST: an in-memory collection call classified as a database
 * exit. Measured on a real repository, `.map()` and `.slice()` on locals shipped
 * as `database` exits — so every number keyed on terminus kind (the data-access
 * picture, "data touched", state-change side effects, criticality scoring on
 * database access) counted list work as persistence.
 *
 * Two mechanisms produced it, and both are asserted here:
 *   1. receiver evidence with NO operation evidence — a declared repository type
 *      on file for the receiver name skipped the operation check entirely, so
 *      any method on it counted;
 *   2. the project-wide receiver table is keyed by BARE PROPERTY NAME, so a
 *      repository-typed field in one class laundered every same-named local
 *      anywhere else in the project.
 *
 * The contract: a `database` exit needs a persistence operation AND a store
 * receiver. A genuine ORM call still classifies; anything unproven is not a
 * store.
 */
async function analyzeSources(files: Record<string, string>, observe?: (contribution: any) => void): Promise<CASExitPoint[]> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-collection-exit-'));
  try {
    await fs.writeJson(path.join(dir, 'package.json'), {
      name: 'collection-exit-fixture',
      version: '1.0.0',
      dependencies: { '@mikro-orm/core': '^6.0.0' },
    });
    for (const [relative, content] of Object.entries(files)) {
      const target = path.join(dir, relative);
      await fs.ensureDir(path.dirname(target));
      await fs.writeFile(target, content);
    }
    const contribution = await new TypeScriptJavaScriptAnalyzer().analyze({ projectPath: dir } as any);
    observe?.(contribution);
    return (contribution.exit_points || []) as CASExitPoint[];
  } finally {
    await fs.remove(dir);
  }
}

/** A class whose injected repository field is named `entities` — the name that
 *  a plain local in another file collides with. */
const REPOSITORY_OWNER = [
  "import { EntityRepository } from '@mikro-orm/core';",
  'export class Thing { id!: string; }',
  'export class ThingService {',
  '  constructor(private readonly entities: EntityRepository<Thing>) {}',
  '  async load(id: string) {',
  '    return this.entities.findOne({ id });',
  '  }',
  '}',
  '',
].join('\n');

describe('collection calls are not database exits', () => {
  it('does not emit a database exit for .map/.slice/.filter on a local array', async () => {
    const exits = await analyzeSources({
      'src/service.ts': REPOSITORY_OWNER,
      'src/view.ts': [
        'export function renderList(entities: string[], rows: string[]) {',
        '  const labels = entities.map(name => name.toUpperCase());',
        '  const firstThree = rows.slice(0, 3);',
        '  const visible = labels.filter(label => label.length > 2);',
        '  return { labels, firstThree, visible };',
        '}',
        '',
      ].join('\n'),
    });

    const databaseExits = exits.filter(exit => exit.type === 'database');
    expect(databaseExits.map(exit => exit.id)).toEqual(['exit_db_load_findOne_6']);
    expect(databaseExits.some(exit => /_map_|_slice_|_filter_/.test(exit.id))).toBe(false);
  });

  it('still classifies a genuine repository call on the declaring class', async () => {
    const exits = await analyzeSources({ 'src/service.ts': REPOSITORY_OWNER });
    const databaseExits = exits.filter(exit => exit.type === 'database');
    expect(databaseExits).toHaveLength(1);
    expect(databaseExits[0].name).toContain('findOne');
  });

  it('does not treat Array.find on a repository-typed name as persistence', async () => {
    const exits = await analyzeSources({
      'src/service.ts': REPOSITORY_OWNER,
      'src/pick.ts': [
        'export function pick(entities: string[]) {',
        "  return entities.find(name => name === 'x');",
        '}',
        '',
      ].join('\n'),
    });

    // `find` IS a persistence verb, so this case turns entirely on the receiver:
    // a bare local is an unresolved receiver, which is unknown, never a store.
    const fromPick = exits.filter(exit => exit.type === 'database' && exit.id.includes('pick'));
    expect(fromPick).toEqual([]);
  });

  it('does not treat an array-of-rows field as a store handle', async () => {
    const exits = await analyzeSources({
      'src/cache.ts': [
        'export class RowModel { id!: string; }',
        'export class RowCache {',
        '  private rowModels: RowModel[] = [];',
        '  first(id: string) {',
        '    return this.rowModels.find(row => row.id === id);',
        '  }',
        '}',
        '',
      ].join('\n'),
    });

    expect(exits.filter(exit => exit.type === 'database')).toEqual([]);
  });
  it('does not treat Array.find on a module constant as persistence', async () => {
    const exits = await analyzeSources({
      'src/lenses.ts': [
        "const LENSES = [{ id: 'concepts' }, { id: 'deployables' }];",
        "const Perspectives = [{ id: 'runtime' }];",
        'export function pickLens(id: string) {',
        '  return {',
        '    lens: LENSES.find(entry => entry.id === id),',
        '    perspective: Perspectives.find(entry => entry.id === id),',
        '  };',
        '}',
        '',
      ].join('\n'),
    });

    // Capitalization is not receiver evidence: ALL_CAPS is the constant
    // convention, and a capitalized name declared here as a variable is a
    // value. Neither is a store handle.
    expect(exits.filter(exit => exit.type === 'database')).toEqual([]);
  });
  it('keeps a SQL driver handle\'s prepared statements and executions', async () => {
    const exits = await analyzeSources({
      'src/store.ts': [
        'export class Store {',
        '  private db: Database;',
        '  constructor(db: Database) { this.db = db; }',
        '  init() {',
        "    this.db.exec('CREATE TABLE t (id TEXT)');",
        '  }',
        '  insertRow(id: string) {',
        "    return this.db.prepare('INSERT INTO t VALUES (?)').run(id);",
        '  }',
        '}',
        'export interface Database { exec(sql: string): void; prepare(sql: string): { run(id: string): void }; }',
        '',
      ].join('\n'),
    });

    // A driver handle's execution verbs ARE the data-access surface for a
    // codebase with no ORM; the vocabulary has to cover them or the whole
    // surface disappears.
    const names = exits.filter(exit => exit.type === 'database').map(exit => exit.name);
    expect(names).toEqual(expect.arrayContaining([expect.stringContaining('exec'), expect.stringContaining('prepare')]));
  });
});

describe('database model receivers require declaration evidence', () => {
  test.each(['Object.assign(response, { status: "success" })', 'Object.create(response)', 'globalThis.Object.assign(response, { status: "success" })'])('does not classify %s as persistence', async expression => {
    const exits = await analyzeSources({ 'src/response.ts': `export function complete(response: object) { return ${expression}; }` });
    expect(exits.filter(exit => exit.type === 'database')).toEqual([]);
  });

  test('resolves an ordinary capitalized class method as a call, not a database exit', async () => {
    let contribution: any;
    const exits = await analyzeSources({ 'src/registry.ts': [
      'export class Registry { static find(key: string) { return key; } }',
      'export function lookup(key: string) { return Registry.find(key); }',
    ].join('\n') }, result => { contribution = result; });
    expect(exits.filter(exit => exit.type === 'database')).toEqual([]);
    const caller = contribution.nodes.find((node: any) => node.name === 'lookup');
    const callee = contribution.nodes.find((node: any) => node.name === 'find' && node.type === 'method');
    expect(contribution.edges.some((edge: any) => edge.type === 'calls' && edge.source === caller.id && edge.target === callee.id)).toBe(true);
  });

  test('does not borrow an ORM declaration for a global receiver in another file', async () => {
    const exits = await analyzeSources({
      'src/model.ts': "import { BaseEntity } from 'typeorm'; export class Object extends BaseEntity {}",
      'src/response.ts': 'export function complete(response: object) { return Object.assign(response, { status: "success" }); }',
    });
    expect(exits.filter(exit => exit.type === 'database')).toEqual([]);
  });

  test('preserves imported Active Record model operations', async () => {
    const exits = await analyzeSources({
      'src/person.ts': "import { BaseEntity as RecordBase } from 'typeorm'; export class Person extends RecordBase {}",
      'src/query.ts': "import { Person } from './person'; export function lookup() { return Person.find(); }",
    });
    expect(exits.filter(exit => exit.type === 'database').map(exit => exit.name)).toContain('Person.find');
  });

  test('preserves Sequelize model inheritance', async () => {
    const exits = await analyzeSources({ 'src/person.ts': [
      "import { Model } from 'sequelize';",
      'export class Person extends Model {}',
      'export function lookup() { return Person.findAll(); }',
    ].join('\n') });
    expect(exits.filter(exit => exit.type === 'database').map(exit => exit.name)).toContain('Person.findAll');
  });

  test('preserves Mongoose model factories including imported aliases', async () => {
    const exits = await analyzeSources({ 'src/person.ts': [
      "import { model as defineDocument, Schema } from 'mongoose';",
      "const Person = defineDocument('Person', new Schema({ name: String }));",
      'export function lookup() { return Person.findOne({ name: "Ada" }); }',
    ].join('\n') });
    expect(exits.filter(exit => exit.type === 'database').map(exit => exit.name)).toContain('Person.findOne');
  });

  test('a non-database Model base is not persistence evidence', async () => {
    const exits = await analyzeSources({
      'src/ui.ts': 'export class Model {}',
      'src/dialog.ts': "import { Model } from './ui'; export class Dialog extends Model {} export function open() { return Dialog.create(); }",
    });
    expect(exits.filter(exit => exit.type === 'database')).toEqual([]);
  });
});

test('keeps call-target caching scoped when an ORM and an ordinary class share a name', async () => {
  let contribution: any;
  const exits = await analyzeSources({
    'src/a-person.ts': "import { BaseEntity } from 'typeorm'; export class Person extends BaseEntity {}",
    'src/b-query.ts': "import { Person } from './a-person'; export function query() { return Person.find(); }",
    'src/z-local.ts': 'export class Person { static find() { return "local"; } } export function local() { return Person.find(); }',
  }, result => { contribution = result; });
  expect(exits.filter(exit => exit.type === 'database').map(exit => exit.name)).toEqual(['Person.find']);
  const caller = contribution.nodes.find((node: any) => node.name === 'local');
  const callee = contribution.nodes.find((node: any) => node.name === 'find' && node.source?.file === 'src/z-local.ts');
  expect(contribution.edges.some((edge: any) => edge.type === 'calls' && edge.source === caller.id && edge.target === callee.id)).toBe(true);
});

test.each([
  ["import mongoose from 'mongoose';", "const Person = mongoose.model('Person', new mongoose.Schema({ name: String }));"],
  ["import { Sequelize } from 'sequelize';", "const database = new Sequelize('sqlite::memory:'); const Person = database.define('Person', {});"],
  ["import { getModelForClass } from '@typegoose/typegoose';", "class PersonDocument { name!: string; } const Person = getModelForClass(PersonDocument);"],
])('retains database model factory evidence from %s', async (imports, definition) => {
  const exits = await analyzeSources({ 'src/person.ts': [
    imports, definition, 'export function lookup() { return Person.findOne({ name: "Ada" }); }',
  ].join('\n') });
  expect(exits.filter(exit => exit.type === 'database').map(exit => exit.name)).toContain('Person.findOne');
});

test('an explicitly imported ORM model can shadow a global without contaminating other files', async () => {
  const exits = await analyzeSources({
    'src/a-model.ts': "import { BaseEntity } from 'typeorm'; export class Object extends BaseEntity {}",
    'src/b-store.ts': "import { Object } from './a-model'; export function persist() { return Object.save({}); }",
    'src/z-response.ts': 'export function complete(response: object) { return Object.assign(response, { status: "success" }); }',
  });
  expect(exits.filter(exit => exit.type === 'database').map(exit => exit.name)).toEqual(['Object.save']);
});

test('does not let a different file overwrite a model import alias', async () => {
  const exits = await analyzeSources({
    'src/a-person.ts': "import { BaseEntity } from 'typeorm'; export class Person extends BaseEntity {}",
    'src/b-query.ts': "import { Person as Record } from './a-person'; export function lookup() { return Record.find(); }",
    'src/y-ui.ts': 'export class Dialog {}',
    'src/z-view.ts': "import { Dialog as Record } from './y-ui'; export function open() { return Record.create(); }",
  });
  expect(exits.filter(exit => exit.type === 'database').map(exit => exit.name)).toEqual(['Record.find']);
});

test.each([
  ["import { BaseEntity } from 'typeorm'; export default class Person extends BaseEntity {}", 'find'],
  ["import { BaseEntity } from 'typeorm'; class Person extends BaseEntity {} export { Person as default };", 'find'],
  ["import { model, Schema } from 'mongoose'; const Person = model('Person', new Schema({})); export default Person;", 'findOne'],
])('preserves the declared default model independently of its import name: %s', async (definition, method) => {
  const exits = await analyzeSources({
    'src/person.ts': definition,
    'src/query.ts': `import Account from './person'; export function lookup() { return Account.${method}(); }`,
  });
  expect(exits.filter(exit => exit.type === 'database').map(exit => exit.name)).toEqual([`Account.${method}`]);
});

test('does not substitute a named model for a different default export', async () => {
  const exits = await analyzeSources({
    'src/person.ts': "import { BaseEntity } from 'typeorm'; export class Person extends BaseEntity { static label = 'export default'; } export default class View {}",
    'src/query.ts': "import Person from './person'; export function lookup() { return Person.find(); }",
  });
  expect(exits.filter(exit => exit.type === 'database')).toEqual([]);
});
