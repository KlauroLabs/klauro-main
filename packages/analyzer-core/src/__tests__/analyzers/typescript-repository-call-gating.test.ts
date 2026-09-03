jest.unmock('fs');
jest.unmock('fs-extra');
jest.unmock('glob');

import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { TypeScriptJavaScriptAnalyzer } from '../../analyzer/languages/typescript-javascript-analyzer';
import { CASContribution, CASExitPoint, CASNode } from '../../types/cas.types';

describe('Repository/ORM exit-point routing is gated on receiver evidence, not bare method names', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-repocall-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function analyzeProject(files: Record<string, string>): Promise<CASContribution> {
    for (const [relativePath, content] of Object.entries(files)) {
      const fullPath = path.join(tempDir, relativePath);
      await fs.ensureDir(path.dirname(fullPath));
      await fs.writeFile(fullPath, content);
    }
    const analyzer = new TypeScriptJavaScriptAnalyzer();
    return analyzer.analyze({ projectPath: tempDir } as any);
  }

  function methodNode(contribution: CASContribution, className: string, methodName: string): CASNode | undefined {
    return (contribution.nodes || []).find(node => {
      if (node.type !== 'method' || node.name !== methodName) return false;
      const parent = (contribution.nodes || []).find(n => n.id === node.parent);
      return parent?.name === className;
    });
  }

  function dbExitPointsFor(contribution: CASContribution, sourceNodeId: string | undefined): CASExitPoint[] {
    if (!sourceNodeId) return [];
    return (contribution.exit_points || []).filter(
      ep => ep.type === 'database' && ep.source_node === sourceNodeId
    );
  }

  it('routes a real repository-typed field call to a DB exit point', async () => {
    // TypeORM-style injection: `Repository<Foo>` comes from the `typeorm` package,
    // not a locally-declared class, so DI-field resolution (which needs a real
    // class-like node to resolve TO) cannot resolve it — this is exactly the shape
    // where receiver-type evidence (classFieldTypes / repositoryPropertyTypes)
    // must still route the call to a DB exit point via isRepositoryCall.
    const contribution = await analyzeProject({
      'src/entities/foo.entity.ts': [
        'export class Foo {',
        '  id: string;',
        '}',
      ].join('\n'),
      'src/services/foo.service.ts': [
        "import { Injectable } from '@nestjs/common';",
        "import { InjectRepository } from '@nestjs/typeorm';",
        "import { Repository } from 'typeorm';",
        "import { Foo } from '../entities/foo.entity';",
        '',
        '@Injectable()',
        'export class FooService {',
        '  constructor(',
        '    @InjectRepository(Foo)',
        '    private readonly fooRepository: Repository<Foo>,',
        '  ) {}',
        '',
        '  async lookup(id: string) {',
        '    return this.fooRepository.find(id);',
        '  }',
        '}',
      ].join('\n'),
    });

    const callerMethod = methodNode(contribution, 'FooService', 'lookup');
    expect(callerMethod).toBeDefined();

    const dbExitPoints = dbExitPointsFor(contribution, callerMethod!.id);
    expect(dbExitPoints.length).toBeGreaterThan(0);
    expect(dbExitPoints.some(ep => ep.metadata?.method === 'find')).toBe(true);
  });

  it('preserves a dynamic query as a database effect for an imported database client', async () => {
    const contribution = await analyzeProject({
      'src/database.ts': [
        "import { Pool } from 'pg';",
        'const pool = new Pool();',
        'export async function runQuery(sql: string) {',
        '  return pool.query(sql);',
        '}',
      ].join('\n'),
    });

    const functionNode = (contribution.nodes || []).find(node => node.type === 'function' && node.name === 'runQuery');
    const dbExits = dbExitPointsFor(contribution, functionNode?.id);
    expect(dbExits).toHaveLength(1);
    expect(dbExits[0].name).toBe('Pool.query');
    expect(dbExits[0].target?.resource).toBe('Pool');
  });

  it('preserves an imported filesystem write as a file effect', async () => {
    const contribution = await analyzeProject({
      'src/reports.ts': [
        "import * as fs from 'fs';",
        'export function persistToDisk(filePath: string, contents: string) {',
        '  fs.writeFileSync(filePath, contents);',
        '}',
      ].join('\n'),
    });

    const functionNode = (contribution.nodes || []).find(node => node.type === 'function' && node.name === 'persistToDisk');
    const fileExits = (contribution.exit_points || []).filter(
      exitPoint => exitPoint.type === 'file' && exitPoint.source_node === functionNode?.id,
    );
    expect(fileExits).toHaveLength(1);
    expect(fileExits[0].target?.resource).toBe('(runtime-resolved)');
  });

  it('does NOT route a plain service method named findAll to a DB exit point', async () => {
    const contribution = await analyzeProject({
      'src/services/organizations.service.ts': [
        "import { Injectable } from '@nestjs/common';",
        '',
        '@Injectable()',
        'export class OrganizationsService {',
        '  findAll() {',
        "    return ['org-a', 'org-b'];",
        '  }',
        '}',
      ].join('\n'),
      'src/controllers/organizations.controller.ts': [
        "import { Controller, Get } from '@nestjs/common';",
        "import { OrganizationsService } from '../services/organizations.service';",
        '',
        '@Controller()',
        'export class OrganizationsController {',
        '  constructor(private readonly organizationsService: OrganizationsService) {}',
        '',
        '  @Get()',
        '  findAll() {',
        '    return this.organizationsService.findAll();',
        '  }',
        '}',
      ].join('\n'),
    });

    const controllerMethod = methodNode(contribution, 'OrganizationsController', 'findAll');
    const serviceMethod = methodNode(contribution, 'OrganizationsService', 'findAll');
    expect(controllerMethod).toBeDefined();
    expect(serviceMethod).toBeDefined();

    // No fabricated DB exit point on the controller for calling the plain service method.
    expect(dbExitPointsFor(contribution, controllerMethod!.id).length).toBe(0);

    // And the call should resolve to the REAL service method instead (DI-field resolution),
    // not be silently dropped.
    const edges = (contribution.edges || []).filter(e => e.type === 'calls');
    const realCallEdge = edges.find(
      e => e.source === controllerMethod!.id && e.target === serviceMethod!.id
    );
    expect(realCallEdge).toBeDefined();
  });

  it('does NOT route a bare local-array .find() call to a DB exit point', async () => {
    const contribution = await analyzeProject({
      'src/services/array.service.ts': [
        "import { Injectable } from '@nestjs/common';",
        '',
        '@Injectable()',
        'export class ArrayService {',
        '  locate(items: number[], target: number) {',
        '    const arr = items;',
        '    return arr.find(x => x === target);',
        '  }',
        '}',
      ].join('\n'),
    });

    const method = methodNode(contribution, 'ArrayService', 'locate');
    expect(method).toBeDefined();

    expect(dbExitPointsFor(contribution, method!.id).length).toBe(0);
  });

  /**
   * An unresolved receiver — a call on the result of another call — is UNKNOWN,
   * and unknown is not a store. Before the receiver-naming fix the call target
   * carried the receiver's raw SOURCE TEXT, whose dot-separated tail was read
   * as a repository name: a plain `.find` at the end of a `.map().filter()
   * .sort()` chain shipped as a `database` exit on a repository called
   * `Length)`. Measured on a real analysis of this repo.
   */
  it('does NOT route a chained-call .find() to a DB exit point, or name it from source text', async () => {
    const contribution = await analyzeProject({
      'src/services/chain.service.ts': [
        "import { Injectable } from '@nestjs/common';",
        '',
        '@Injectable()',
        'export class ChainService {',
        '  anchor(entities: any[]) {',
        '    return entities',
        '      .map(entity => ({ entity, canonical: entity.name }))',
        '      .filter(item => item.canonical.length >= 4)',
        '      .sort((left, right) => right.canonical.length - left.canonical.length)',
        "      .find(item => item.canonical.includes('x'));",
        '  }',
        '}',
      ].join('\n'),
    });

    const method = methodNode(contribution, 'ChainService', 'anchor');
    expect(method).toBeDefined();
    expect(dbExitPointsFor(contribution, method!.id).length).toBe(0);

    // Nothing anywhere in the contribution may be named out of source text.
    const sourceTextShaped = (contribution.exit_points || [])
      .map(ep => ep.name || '')
      .filter(name => /[()[\]{}\s]/.test(name));
    expect(sourceTextShaped).toEqual([]);
  });

  it('does NOT route a call on a call result to an API exit point', async () => {
    // `getClient().get('/users')` has a URL-shaped first argument, which is the
    // evidence isApiCall leans on for wrapped HTTP clients. That evidence is
    // only meaningful once we know WHAT the receiver is; here we do not.
    const contribution = await analyzeProject({
      'src/services/client.service.ts': [
        "import { Injectable } from '@nestjs/common';",
        '',
        'declare function getClient(): any;',
        '',
        '@Injectable()',
        'export class ClientService {',
        '  load() {',
        "    return getClient().get('/users');",
        '  }',
        '}',
      ].join('\n'),
    });

    const method = methodNode(contribution, 'ClientService', 'load');
    expect(method).toBeDefined();

    const apiExits = (contribution.exit_points || []).filter(
      ep => ep.type === 'api' && ep.source_node === method!.id
    );
    expect(apiExits).toEqual([]);
  });
});
