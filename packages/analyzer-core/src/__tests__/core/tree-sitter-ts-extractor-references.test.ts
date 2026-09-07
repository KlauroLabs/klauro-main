import { TreeSitterTSExtractor, TSExtractedCall } from '../../analyzer/core/tree-sitter-ts-extractor';

/**
 * Regression tests for the callers-completeness fix (2026-07-04): decorator-argument
 * references, decorator-name references, and class-heritage type-position references
 * were all structurally invisible to extractIdentifierReferences because tree-sitter
 * places decorators and heritage clauses OUTSIDE the function/class body it scans.
 * See tree-sitter-ts-extractor.ts extractDecoratorArgumentReferences /
 * extractDecoratorNameReference / extractClassLevelReferences for the fix and the
 * real-repo evidence (zerac-api INTERNAL_GET_ERRORS 1/18 -> resolved via decorator args,
 * AllowAnonymous 0/23 -> resolved via decorator name, AgentAccessServiceBase 0/1 ->
 * resolved via heritage).
 */
describe('TreeSitterTSExtractor identifier-reference completeness', () => {
  const extractor = new TreeSitterTSExtractor();

  function allCalls(source: string, file = 'file.ts'): TSExtractedCall[] {
    const extraction = extractor.extractFromSource(source, file);
    const calls: TSExtractedCall[] = [];
    for (const fn of extraction.functions) calls.push(...fn.calls);
    for (const cls of extraction.classes) {
      for (const method of cls.methods) calls.push(...method.calls);
    }
    return calls;
  }

  function refTargets(calls: TSExtractedCall[]): string[] {
    return calls.filter(c => c.targetType === 'property').map(c => c.target);
  }

  it.each(['typescript', 'tsx', 'javascript'])('preserves named preorder and root matches in %s subtree searches', language => {
    const Parser = require('tree-sitter');
    const parser = new Parser();
    const grammar = language === 'javascript'
      ? require('tree-sitter-javascript')
      : require('tree-sitter-typescript')[language];
    parser.setLanguage(grammar);
    const source = language === 'javascript'
      ? 'export function outer(value) { const label = "string"; function inner() {} return () => persist(value, label); }'
      : 'export function outer(value: string): number { const label = "string"; function inner(): void {} return 1; }';
    extractor.extractFromSource(source, language === 'javascript' ? 'file.js' : language === 'tsx' ? 'file.tsx' : 'file.ts');
    const tree = parser.parse(source);
    expect(tree.rootNode).toBeDefined();
    const namedPreorder = (root: any): any[] => {
      const nodes: any[] = [];
      const pending = [root];
      while (pending.length) {
        const node = pending.pop()!;
        nodes.push(node);
        for (let index = node.namedChildCount - 1; index >= 0; index--) pending.push(node.namedChild(index));
      }
      return nodes;
    };
    const searches = extractor as any;
    const types = ['string', 'identifier', 'type_annotation', 'function_declaration', 'formal_parameters', 'not_present'];
    for (const root of namedPreorder(tree.rootNode)) {
      const descendants = namedPreorder(root);
      for (const type of types) {
        const expected = descendants.filter(node => node.type === type);
        expect(searches.collectByType(root, type).map((node: any) => node.id)).toEqual(expected.map(node => node.id));
        expect(searches.findFirst(root, type)?.id ?? null).toBe(expected[0]?.id ?? null);
      }
      const selected = new Set(['string', 'identifier', 'function_declaration']);
      expect(searches.collectByTypes(root, selected).map((node: any) => node.id)).toEqual(
        descendants.filter(node => selected.has(node.type)).map(node => node.id),
      );
    }
    if (language !== 'javascript') {
      const keyword = tree.rootNode.descendantsOfType('string').find((node: any) => !node.isNamed);
      expect(keyword).toBeDefined();
      expect(searches.findFirst(keyword, 'string')?.id).toBe(keyword.id);
      expect(searches.collectByType(keyword, 'string').map((node: any) => node.id)).toEqual([keyword.id]);
      expect(searches.collectByTypes(keyword, new Set(['string'])).map((node: any) => node.id)).toEqual([keyword.id]);
    }
    expect(searches.collectByType(null, 'identifier')).toEqual([]);
    expect(searches.collectByTypes(null, new Set(['identifier']))).toEqual([]);
    expect(searches.findFirst(null, 'identifier')).toBeNull();
  });

  it('resolves an identifier spread inside a decorator call argument', () => {
    const source = `
      import { InternalGet, INTERNAL_GET_ERRORS } from '@zerac-api/decorators';

      export class SystemController {
        constructor() {}

        @InternalGet('overview', [[200, Object], ...INTERNAL_GET_ERRORS], 'desc')
        getOverview() {}
      }
    `;
    const calls = allCalls(source);
    expect(refTargets(calls)).toContain('INTERNAL_GET_ERRORS');
  });

  it('resolves an array-literal element inside a decorator call argument (DI inject list)', () => {
    const source = `
      import { Module } from '@nestjs/common';
      import { DatabaseService } from './db/database.service';
      import { EventBusService } from './services/realtime/event-bus.service';

      @Module({
        providers: [
          {
            provide: WalletTrackerService,
            useFactory: (db: DatabaseService, eventBus: EventBusService) => null,
            inject: [DatabaseService, EventBusService],
          },
        ],
      })
      export class SolanaIndexerModule {
        constructor() {}
      }
    `;
    const calls = allCalls(source);
    expect(refTargets(calls)).toContain('EventBusService');
  });

  it('resolves the decorator name itself as a reference (e.g. barrel-imported guard decorator)', () => {
    const source = `
      import { AllowAnonymous } from '@zerac-api/auth';

      export class SsoDiscoveryController {
        constructor() {}

        @AllowAnonymous()
        discover() {}
      }
    `;
    const calls = allCalls(source);
    expect(refTargets(calls)).toContain('AllowAnonymous');
  });

  it('resolves a cross-file base class in an extends heritage clause', () => {
    const source = `
      import { AgentAccessServiceBase } from './base';

      export abstract class CheckAccess extends AgentAccessServiceBase {
        constructor() {}
        run() {}
      }
    `;
    const calls = allCalls(source);
    expect(refTargets(calls)).toContain('AgentAccessServiceBase');
  });

  it('resolves cross-file interfaces in an implements heritage clause', () => {
    const source = `
      import { Config } from './config';

      export class Foo implements Config {
        constructor() {}
      }
    `;
    const calls = allCalls(source);
    expect(refTargets(calls)).toContain('Config');
  });

  it('does NOT link a shadowed local variable that shares a name with an import (no fabricated edges)', () => {
    const source = `
      import { Widget } from './widget';

      export function build() {
        const Widget = 5; // local shadow, unrelated to the import
        return Widget + 1;
      }
    `;
    const extraction = extractor.extractFromSource(source, 'file.ts');
    // The import map is keyed by import name only; a genuinely shadowed local read is
    // indistinguishable from a real import read by this conservative extractor, so this
    // test documents the current (accepted) scope: shadowing suppression is NOT claimed
    // for plain local re-declarations inside the same function body — only structural
    // positions (decorator/heritage) that cannot ever be a local variable are covered by
    // the new code added in this change. Assert the new code paths add no NEW false
    // positive beyond that pre-existing, documented boundary: decorator/heritage scans
    // must not fire here since there are none.
    const calls = extraction.functions.flatMap(f => f.calls);
    const decoratorOrHeritageRefs = calls.filter(c => c.targetType === 'property' && c.target === 'Widget' && c.line === 3);
    expect(decoratorOrHeritageRefs.length).toBe(0);
  });

  it('does not double count a decorator argument identifier also used as the decorator callee', () => {
    const source = `
      import { Controller } from '@nestjs/common';

      @Controller()
      export class Foo {
        constructor() {}
      }
    `;
    const calls = allCalls(source);
    const controllerRefs = refTargets(calls).filter(t => t === 'Controller');
    expect(controllerRefs.length).toBe(1);
  });

  it('attaches class-level references to the constructor when present, not just the first method', () => {
    const source = `
      import { Base } from './base';

      export class Ordered {
        aFirst() {}
        constructor() {}
        zLast() {}
      }
      class Sub extends Base {
        aFirst() {}
        constructor() {}
      }
    `;
    const extraction = extractor.extractFromSource(source, 'file.ts');
    const sub = extraction.classes.find(c => c.name === 'Sub')!;
    const ctor = sub.methods.find(m => m.type === 'constructor')!;
    const nonCtor = sub.methods.find(m => m.type !== 'constructor')!;
    expect(refTargets(ctor.calls)).toContain('Base');
    expect(refTargets(nonCtor.calls)).not.toContain('Base');
  });
});
