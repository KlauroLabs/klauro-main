import { TreeSitterTSExtractor, TSDecoratorDetail } from '../../analyzer/core/tree-sitter-ts-extractor';

/**
 * Regression tests for the generic decorator-argument capture (2026-07-05): the TS
 * analyzer used to keep only a bare decorator NAME (`decorators: ["Endpoint"]`) for any
 * decorator it did not recognize as a known framework, so a custom route decorator like
 * `@Endpoint('/orders','GET')` reached the CAS with zero argument text — the `.klaurorc`
 * conventions applier then correctly refused to emit a route (evidence-gated) because it
 * had no path/method to resolve. `extractDecoratorArgs` now captures the literal-evaluable
 * call arguments of EVERY decorator generically, alongside the bare-name list, feeding
 * CASDecorator.parameters. Only statically-evaluable literals are surfaced — an identifier,
 * call, member access, computed object value, spread, or `${}` template is omitted rather
 * than guessed. See tree-sitter-ts-extractor.ts extractDecoratorArgs / evaluateLiteralNode.
 */
describe('TreeSitterTSExtractor decorator-argument capture', () => {
  const extractor = new TreeSitterTSExtractor();

  function methodDecoratorArgs(source: string, methodName: string): TSDecoratorDetail[] {
    const extraction = extractor.extractFromSource(source, 'file.ts');
    for (const cls of extraction.classes) {
      const method = cls.methods.find(m => m.name === methodName);
      if (method) return method.decoratorArgs || [];
    }
    return [];
  }

  it('captures positional string arguments of a custom decorator by index', () => {
    const source = `
      class OrdersController {
        @Endpoint('/orders', 'GET')
        listOrders() {}
      }
    `;
    const args = methodDecoratorArgs(source, 'listOrders');
    expect(args).toEqual([
      {
        name: 'Endpoint',
        args: [
          { name: '0', value: '/orders', type: 'string' },
          { name: '1', value: 'GET', type: 'string' },
        ],
      },
    ]);
  });

  it('captures object-argument properties by key, across literal types', () => {
    const source = `
      class OrdersController {
        @Route({ path: '/orders/:id', method: 'POST', secure: true, retries: 3, note: null })
        create() {}
      }
    `;
    const args = methodDecoratorArgs(source, 'create');
    expect(args).toEqual([
      {
        name: 'Route',
        args: [
          { name: 'path', value: '/orders/:id', type: 'string' },
          { name: 'method', value: 'POST', type: 'string' },
          { name: 'secure', value: true, type: 'boolean' },
          { name: 'retries', value: 3, type: 'number' },
          { name: 'note', value: null, type: 'null' },
        ],
      },
    ]);
  });

  it('captures a no-substitution template string as a literal', () => {
    const source = `
      class Svc {
        @Cache(\`v1\`)
        cached() {}
      }
    `;
    const args = methodDecoratorArgs(source, 'cached');
    expect(args).toEqual([
      { name: 'Cache', args: [{ name: '0', value: 'v1', type: 'string' }] },
    ]);
  });

  it('skips a non-literal argument (identifier / member access) rather than fabricating it', () => {
    const source = `
      class Svc {
        @Guard(RolesEnum.ADMIN)
        danger() {}
      }
    `;
    const args = methodDecoratorArgs(source, 'danger');
    // Decorator still recorded (so its presence is known) but with NO resolved args.
    expect(args).toEqual([{ name: 'Guard', args: [] }]);
  });

  it('skips call / substituted-template / computed args but keeps preceding literals in position', () => {
    const source = `
      class Svc {
        @Mixed('/keep', foo(), \`x\${y}\`, 42)
        m() {}
      }
    `;
    const args = methodDecoratorArgs(source, 'm');
    // '/keep' is index 0, the skipped foo()/template hold indices 1 and 2, 42 is index 3 —
    // positional indices reflect the true call site so a consumer selecting arg[3] is correct.
    expect(args).toEqual([
      {
        name: 'Mixed',
        args: [
          { name: '0', value: '/keep', type: 'string' },
          { name: '3', value: 42, type: 'number' },
        ],
      },
    ]);
  });

  it('skips only the non-literal object properties, keeping the literal ones', () => {
    const source = `
      class Svc {
        @Route({ path: '/p', handler: someHandler, method: 'PUT' })
        m() {}
      }
    `;
    const args = methodDecoratorArgs(source, 'm');
    expect(args).toEqual([
      {
        name: 'Route',
        args: [
          { name: 'path', value: '/p', type: 'string' },
          { name: 'method', value: 'PUT', type: 'string' },
        ],
      },
    ]);
  });

  it('records a bare (no-call) decorator with empty args and does not break the name list', () => {
    const source = `
      class Svc {
        @Deprecated
        old() {}
      }
    `;
    const extraction = extractor.extractFromSource(source, 'file.ts');
    const method = extraction.classes[0].methods.find(m => m.name === 'old')!;
    expect(method.decorators).toEqual(['Deprecated']);
    expect(method.decoratorArgs).toEqual([{ name: 'Deprecated', args: [] }]);
  });

  it('captures class-level and property-level decorator arguments too', () => {
    const source = `
      @Module({ prefix: 'orders' })
      class OrdersModule {
        @Column({ nullable: false, length: 255 })
        name: string;
      }
    `;
    const extraction = extractor.extractFromSource(source, 'file.ts');
    const cls = extraction.classes[0];
    expect(cls.decoratorArgs).toEqual([
      { name: 'Module', args: [{ name: 'prefix', value: 'orders', type: 'string' }] },
    ]);
    const prop = cls.properties.find(p => p.name === 'name')!;
    expect(prop.decoratorArgs).toEqual([
      { name: 'Column', args: [{ name: 'nullable', value: false, type: 'boolean' }, { name: 'length', value: 255, type: 'number' }] },
    ]);
  });
});
