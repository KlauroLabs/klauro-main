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
async function analyzeSources(files: Record<string, string>): Promise<CASExitPoint[]> {
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
