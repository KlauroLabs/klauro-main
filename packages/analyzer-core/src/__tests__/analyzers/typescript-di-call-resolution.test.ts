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

  it('resolves this.<field>.<method>() to the real callee method when the field is a typed class property with no constructor (Angular DI)', async () => {
    const contribution = await analyzeProject({
      'src/services/fuel.service.ts': [
        'export class FuelService {',
        '  getCards() {',
        '    return [];',
        '  }',
        '}',
      ].join('\n'),
      'src/components/fuel.component.ts': [
        "import { FuelService } from '../services/fuel.service';",
        '',
        'export class FuelComponent {',
        '  private fuelService: FuelService;',
        '',
        '  load() {',
        '    return this.fuelService.getCards();',
        '  }',
        '}',
      ].join('\n'),
    });

    const callerMethod = methodNode(contribution, 'FuelComponent', 'load');
    const targetMethod = methodNode(contribution, 'FuelService', 'getCards');
    expect(callerMethod).toBeDefined();
    expect(targetMethod).toBeDefined();

    const edges = callEdges(contribution);
    const diEdge = edges.find(e => e.source === callerMethod!.id && e.target === targetMethod!.id);
    expect(diEdge).toBeDefined();
  });

  it("resolves this.<field>.<method>() when the field is Angular's field-style inject() with no constructor", async () => {
    const contribution = await analyzeProject({
      'src/services/fuel.service.ts': [
        'export class FuelService {',
        '  getFuelStationsArray() {',
        '    return [];',
        '  }',
        '}',
      ].join('\n'),
      'src/components/map-data-source.ts': [
        "import { inject } from '@angular/core';",
        "import { FuelService } from '../services/fuel.service';",
        '',
        'export class FeaturedMapDataSource {',
        '  protected readonly fuelService = inject(FuelService);',
        '',
        '  refresh() {',
        '    return this.fuelService.getFuelStationsArray();',
        '  }',
        '}',
      ].join('\n'),
    });

    const callerMethod = methodNode(contribution, 'FeaturedMapDataSource', 'refresh');
    const targetMethod = methodNode(contribution, 'FuelService', 'getFuelStationsArray');
    expect(callerMethod).toBeDefined();
    expect(targetMethod).toBeDefined();

    const edges = callEdges(contribution);
    const diEdge = edges.find(e => e.source === callerMethod!.id && e.target === targetMethod!.id);
    expect(diEdge).toBeDefined();
    expect(diEdge!.metadata?.attributes?.resolution_type).toBe('di_field');
  });

  it('resolves an inject()-style field to the ONE class the import pins, when two classes share its name', async () => {
    const contribution = await analyzeProject({
      'src/services/impl-a/notification.service.ts': [
        'export class NotificationService {',
        '  notify(msg: string) {',
        '    return msg;',
        '  }',
        '}',
      ].join('\n'),
      'src/services/impl-b/notification.service.ts': [
        'export class NotificationService {',
        '  notify(msg: string) {',
        '    return msg;',
        '  }',
        '}',
      ].join('\n'),
      'src/components/toast.component.ts': [
        "import { inject } from '@angular/core';",
        "import { NotificationService } from '../services/impl-a/notification.service';",
        '',
        'export class ToastComponent {',
        '  private readonly notificationService = inject(NotificationService);',
        '',
        '  fire() {',
        '    return this.notificationService.notify("hi");',
        '  }',
        '}',
      ].join('\n'),
    });

    const callerMethod = methodNode(contribution, 'ToastComponent', 'fire');
    expect(callerMethod).toBeDefined();

    const notifyMethods = (contribution.nodes || []).filter(node => {
      if (node.type !== 'method' || node.name !== 'notify') return false;
      const parent = (contribution.nodes || []).find(n => n.id === node.parent);
      return parent?.name === 'NotificationService';
    });
    expect(notifyMethods.length).toBe(2);

    const edges = callEdges(contribution);
    const diEdges = edges.filter(
      e => e.source === callerMethod!.id && e.metadata?.attributes?.resolution_type === 'di_field'
    );

    // Import-path evidence pins exactly ONE of the two same-named classes —
    // resolve precisely to it, not a fan-out to both.
    expect(diEdges.length).toBe(1);
    const implANode = (contribution.nodes || []).find(n => n.id === diEdges[0].target);
    const implAParent = (contribution.nodes || []).find(n => n.id === implANode?.parent);
    expect(implAParent?.source?.file).toBe('src/services/impl-a/notification.service.ts');
    expect(diEdges[0].metadata?.attributes?.ambiguous).toBeUndefined();
  });

  it('abstains (no edge) for an inject()-style field whose type name is ambiguous with no disambiguating import', async () => {
    const contribution = await analyzeProject({
      'src/services/impl-a/broadcast.service.ts': [
        'export class BroadcastService {',
        '  send(msg: string) {',
        '    return msg;',
        '  }',
        '}',
      ].join('\n'),
      'src/services/impl-b/broadcast.service.ts': [
        'export class BroadcastService {',
        '  send(msg: string) {',
        '    return msg;',
        '  }',
        '}',
      ].join('\n'),
      'src/components/radio.component.ts': [
        "import { inject } from '@angular/core';",
        '',
        'export class RadioComponent {',
        '  private readonly broadcastService = inject(BroadcastService);',
        '',
        '  fire() {',
        '    return this.broadcastService.send("hi");',
        '  }',
        '}',
      ].join('\n'),
    });

    const callerMethod = methodNode(contribution, 'RadioComponent', 'fire');
    expect(callerMethod).toBeDefined();

    const edges = callEdges(contribution);
    const diEdges = edges.filter(
      e => e.source === callerMethod!.id && e.metadata?.attributes?.resolution_type === 'di_field'
    );

    // No import evidence to disambiguate BroadcastService -> abstain, never guess.
    expect(diEdges.length).toBe(0);
  });
});
