jest.unmock('fs');
jest.unmock('fs-extra');
jest.unmock('glob');

import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { TypeScriptJavaScriptAnalyzer } from '../../analyzer/languages/typescript-javascript-analyzer';
import { CASContribution, CASEdge, CASNode } from '../../types/cas.types';

describe('TypeScript DI-injected method call resolution', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-di-call-'));
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

  function callEdges(contribution: CASContribution): CASEdge[] {
    return (contribution.edges || []).filter(edge => edge.type === 'calls');
  }

  it('resolves this.<field>.<method>() to the real callee method when the field is a constructor-injected typed dependency', async () => {
    const contribution = await analyzeProject({
      'src/repositories/analysis.repository.ts': [
        "import { Injectable } from '@nestjs/common';",
        '',
        '@Injectable()',
        'export class AnalysisRepository {',
        '  create(data: any) {',
        '    return data;',
        '  }',
        '}',
      ].join('\n'),
      'src/services/analysis.service.ts': [
        "import { Injectable } from '@nestjs/common';",
        "import { AnalysisRepository } from '../repositories/analysis.repository';",
        '',
        '@Injectable()',
        'export class AnalysisService {',
        '  constructor(private readonly analysisRepository: AnalysisRepository) {}',
        '',
        '  async createAnalysis(data: any) {',
        '    return this.analysisRepository.create(data);',
        '  }',
        '}',
      ].join('\n'),
    });

    const callerMethod = methodNode(contribution, 'AnalysisService', 'createAnalysis');
    const targetMethod = methodNode(contribution, 'AnalysisRepository', 'create');

    expect(callerMethod).toBeDefined();
    expect(targetMethod).toBeDefined();

    const edges = callEdges(contribution);
    const diEdge = edges.find(e => e.source === callerMethod!.id && e.target === targetMethod!.id);

    expect(diEdge).toBeDefined();
    expect(diEdge!.metadata?.attributes?.resolution_type).toBe('di_field');
  });

  it('does not fabricate an edge when the injected field has no declared type', async () => {
    const contribution = await analyzeProject({
      'src/services/loose.service.ts': [
        "import { Injectable } from '@nestjs/common';",
        '',
        '@Injectable()',
        'export class LooseService {',
        '  constructor(private readonly untypedDep) {}',
        '',
        '  async run() {',
        '    return this.untypedDep.doThing();',
        '  }',
        '}',
      ].join('\n'),
    });

    const callerMethod = methodNode(contribution, 'LooseService', 'run');
    expect(callerMethod).toBeDefined();

    const edges = callEdges(contribution);
    const diEdges = edges.filter(
      e => e.source === callerMethod!.id && e.metadata?.attributes?.resolution_type === 'di_field'
    );

    expect(diEdges.length).toBe(0);
  });

  it('resolves ambiguously (to all real matches, never a guess) when multiple classes share the injected type name', async () => {
    const contribution = await analyzeProject({
      'src/repositories/impl-a.repository.ts': [
        'export class Store {',
        '  save(data: any) {',
        '    return data;',
        '  }',
        '}',
      ].join('\n'),
      'src/repositories/impl-b.repository.ts': [
        'export class Store {',
        '  save(data: any) {',
        '    return data;',
        '  }',
        '}',
      ].join('\n'),
      'src/services/ambiguous.service.ts': [
        "import { Injectable } from '@nestjs/common';",
        "import { Store } from '../repositories/impl-a.repository';",
        '',
        '@Injectable()',
        'export class AmbiguousService {',
        '  constructor(private readonly store: Store) {}',
        '',
        '  async persist(data: any) {',
        '    return this.store.save(data);',
        '  }',
        '}',
      ].join('\n'),
    });

    const callerMethod = methodNode(contribution, 'AmbiguousService', 'persist');
    expect(callerMethod).toBeDefined();

    const storeSaveMethods = (contribution.nodes || []).filter(node => {
      if (node.type !== 'method' || node.name !== 'save') return false;
      const parent = (contribution.nodes || []).find(n => n.id === node.parent);
      return parent?.name === 'Store';
    });
    expect(storeSaveMethods.length).toBe(2);

    const edges = callEdges(contribution);
    const diEdges = edges.filter(
      e => e.source === callerMethod!.id && e.metadata?.attributes?.resolution_type === 'di_field'
    );

    // Never guess: resolve to all real matches, not a single arbitrarily-chosen one.
    expect(diEdges.length).toBe(storeSaveMethods.length);
    const targets = new Set(diEdges.map(e => e.target));
    for (const method of storeSaveMethods) {
      expect(targets.has(method.id)).toBe(true);
    }
    expect(diEdges.every(e => e.metadata?.attributes?.ambiguous === true)).toBe(true);
  });
});
