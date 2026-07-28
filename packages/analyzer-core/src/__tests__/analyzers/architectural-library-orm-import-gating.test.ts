jest.unmock('fs');
jest.unmock('fs-extra');
jest.unmock('glob');

import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { ArchitecturalLibraryAnalyzer } from '../../analyzer/libraries/architecture/architectural-library-analyzer';
import { CASContribution, CASNode } from '../../types/cas.types';

describe('ORM/framework attribution is gated on real import source, not bare symbol name', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-orm-gating-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function analyzeProject(
    packageJson: Record<string, unknown>,
    files: Record<string, string>
  ): Promise<CASContribution> {
    await fs.writeJson(path.join(tempDir, 'package.json'), packageJson);
    for (const [relativePath, content] of Object.entries(files)) {
      const fullPath = path.join(tempDir, relativePath);
      await fs.ensureDir(path.dirname(fullPath));
      await fs.writeFile(fullPath, content);
    }
    const analyzer = new ArchitecturalLibraryAnalyzer();
    return analyzer.analyze({ projectPath: tempDir } as any);
  }

  function libraryNodeNames(contribution: CASContribution): string[] {
    return (contribution.nodes || []).map((node: CASNode) => node.name);
  }

  it('labels a real MikroORM EntityManager usage as MikroORM, not TypeORM, even when typeorm is also a declared dependency', async () => {
    // Mirrors the real zerac-api / proof-of-concept shape: both `typeorm` and
    // `@mikro-orm/core` are declared dependencies (e.g. via @nestjs/typeorm being a
    // leftover/transitional dep), but the actual persistence code only imports and
    // uses MikroORM's EntityManager. Before the fix, TypeORM's bare-symbol regex
    // matched `EntityManager` regardless of import source and fabricated a TypeORM
    // attribution.
    const contribution = await analyzeProject(
      {
        dependencies: {
          typeorm: '^0.3.20',
          '@nestjs/typeorm': '^10.0.2',
          '@mikro-orm/core': '^6.4.4',
        },
      },
      {
        'src/services/widget.service.ts': [
          "import { Injectable } from '@nestjs/common';",
          "import { EntityManager } from '@mikro-orm/core';",
          '',
          '@Injectable()',
          'export class WidgetService {',
          '  constructor(private readonly em: EntityManager) {}',
          '',
          '  async findAll() {',
          "    return this.em.find('Widget', {});",
          '  }',
          '}',
        ].join('\n'),
      }
    );

    const names = libraryNodeNames(contribution);
    expect(names.some(name => name.startsWith('MikroORM:'))).toBe(true);
    expect(names.some(name => name.startsWith('TypeORM:'))).toBe(false);

    const libraryNames = (contribution.libraries || []).map(lib => lib.name);
    expect(libraryNames).toContain('@mikro-orm/core');
  });

  it('still labels real TypeORM usage as TypeORM when the file actually imports from typeorm', async () => {
    const contribution = await analyzeProject(
      { dependencies: { typeorm: '^0.3.20' } },
      {
        'src/services/order.service.ts': [
          "import { Injectable } from '@nestjs/common';",
          "import { Repository, DataSource } from 'typeorm';",
          "import { InjectRepository } from '@nestjs/typeorm';",
          "import { Order } from '../entities/order.entity';",
          '',
          '@Injectable()',
          'export class OrderService {',
          '  constructor(',
          '    @InjectRepository(Order)',
          '    private readonly orderRepository: Repository<Order>,',
          '  ) {}',
          '',
          '  async findAll() {',
          '    return this.orderRepository.find();',
          '  }',
          '}',
        ].join('\n'),
      }
    );

    const names = libraryNodeNames(contribution);
    expect(names.some(name => name.startsWith('TypeORM:'))).toBe(true);
  });

  it('does not fabricate a specific ORM label when the bare symbol appears with no matching import in the file', async () => {
    // Both typeorm and @mikro-orm/core are declared, but this particular file
    // defines its own local `EntityManager`-named class unrelated to either ORM.
    // Neither rule's import-gated patterns should fire for this file.
    const contribution = await analyzeProject(
      {
        dependencies: {
          typeorm: '^0.3.20',
          '@mikro-orm/core': '^6.4.4',
        },
      },
      {
        'src/local/entity-manager.ts': [
          'export class EntityManager {',
          '  private items: unknown[] = [];',
          '  find(_query: unknown) {',
          '    return this.items;',
          '  }',
          '}',
        ].join('\n'),
      }
    );

    const names = libraryNodeNames(contribution);
    expect(names.some(name => name.startsWith('TypeORM: repository access'))).toBe(false);
    expect(names.some(name => name.startsWith('MikroORM: repository access'))).toBe(false);
  });

  it('uses language-pass import evidence instead of rescanning unrelated source files', async () => {
    await fs.writeJson(path.join(tempDir, 'package.json'), {
      dependencies: { '@mikro-orm/core': '^6.4.4' },
    });
    await fs.ensureDir(path.join(tempDir, 'src'));
    await fs.writeFile(path.join(tempDir, 'src/real.ts'), [
      "import { EntityManager } from '@mikro-orm/core';",
      'export const load = (em: EntityManager) => em.findAll();',
    ].join('\n'));
    await fs.writeFile(path.join(tempDir, 'src/decoy.ts'), [
      'class EntityManager { findAll() { return []; } }',
      'export const local = new EntityManager().findAll();',
    ].join('\n'));

    const analyzer = new ArchitecturalLibraryAnalyzer();
    const contribution = await analyzer.analyze({
      projectPath: tempDir,
      analysisRootPath: tempDir,
      existingAnalysis: [{
        nodes: [{
          id: 'import_real_mikro',
          name: 'import @mikro-orm/core',
          type: 'import',
          source: { file: 'src/real.ts', line: 1 },
          metadata: { source: '@mikro-orm/core' },
        } as CASNode],
        edges: [],
        entry_points: [],
        exit_points: [],
        analyzer_metadata: {
          analyzer_id: 'typescript-javascript',
          analyzer_name: 'TypeScript/JavaScript Analyzer',
          version: '1.0.0',
          contribution_type: 'language',
          nodes_contributed: 1,
          edges_contributed: 0,
          contributed_entry_points: 0,
          contributed_exit_points: 0,
        },
      }],
    });

    const sourceFiles = (contribution.nodes || []).map(node => node.source?.file).filter(Boolean);
    expect(sourceFiles.some(file => String(file).endsWith('src/real.ts'))).toBe(true);
    expect(sourceFiles.some(file => String(file).endsWith('src/decoy.ts'))).toBe(false);
  });
});
