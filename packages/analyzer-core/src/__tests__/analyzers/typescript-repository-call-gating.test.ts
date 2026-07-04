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
});
