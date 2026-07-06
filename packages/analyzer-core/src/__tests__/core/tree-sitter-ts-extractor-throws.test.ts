import { TreeSitterTSExtractor } from '../../analyzer/core/tree-sitter-ts-extractor';

/**
 * Regression tests for `throw`-statement type extraction (2026-07-05): the TS/JS
 * extractor now lifts the error TYPE name from `throw new Foo(...)` / `throw Foo(...)`
 * into `TSExtractedFunction.throws`, which the analyzer merges (with JSDoc `@throws`)
 * into `node.signature.throws`. Before this, `signature.throws` was never populated for
 * TS/JS, leaving both `get_error_contracts` and the flow-concepts error-kind constraint
 * deriver dead for every TS/JS repo. Evidence-gated: bare `throw err` re-throws yield no
 * recoverable type and are omitted rather than emitting a placeholder.
 * See tree-sitter-ts-extractor.ts extractThrows / throwTypeName.
 */
describe('TreeSitterTSExtractor throw-statement type extraction', () => {
  const extractor = new TreeSitterTSExtractor();

  function fnThrows(source: string, fnName: string): string[] | undefined {
    const extraction = extractor.extractFromSource(source, 'file.ts');
    const fn = extraction.functions.find(f => f.name === fnName);
    if (fn) return fn.throws;
    for (const cls of extraction.classes) {
      const m = cls.methods.find(mm => mm.name === fnName);
      if (m) return m.throws;
    }
    return undefined;
  }

  it('lifts the constructor name from `throw new Foo()`', () => {
    const source = `
      function loadConfig() {
        if (!process.env.X) throw new MissingEnvVarError('X');
        return process.env.X;
      }
    `;
    expect(fnThrows(source, 'loadConfig')).toEqual(['MissingEnvVarError']);
  });

  it('lifts the trailing property from `throw new ns.Foo()`', () => {
    const source = `
      function guard() {
        throw new errors.ValidationError('bad');
      }
    `;
    expect(fnThrows(source, 'guard')).toEqual(['ValidationError']);
  });

  it('lifts a PascalCase factory call `throw Foo()`', () => {
    const source = `
      function boom() {
        throw HttpError(500);
      }
    `;
    expect(fnThrows(source, 'boom')).toEqual(['HttpError']);
  });

  it('does NOT lift a lowercase helper call `throw buildResponse()`', () => {
    const source = `
      function h() {
        throw buildResponse();
      }
    `;
    expect(fnThrows(source, 'h')).toBeUndefined();
  });

  it('omits bare re-throws `throw err` (no recoverable type)', () => {
    const source = `
      function rethrow() {
        try { risky(); } catch (err) { throw err; }
      }
    `;
    expect(fnThrows(source, 'rethrow')).toBeUndefined();
  });

  it('dedupes repeated throw types', () => {
    const source = `
      function multi(x: number) {
        if (x < 0) throw new RangeError('neg');
        if (x > 10) throw new RangeError('big');
        throw new TypeError('nan');
      }
    `;
    const t = fnThrows(source, 'multi');
    expect(t).toBeDefined();
    expect(new Set(t)).toEqual(new Set(['RangeError', 'TypeError']));
    expect(t!.length).toBe(2);
  });

  it('attributes a throw to the method whose body contains it, not a nested callback', () => {
    const source = `
      class Svc {
        run() {
          throw new OuterError('x');
          [1].forEach(() => { throw new InnerError('y'); });
        }
      }
    `;
    // The method's own throw is captured; the nested arrow's throw is not folded up
    // into run() (the arrow gets its own scan).
    expect(fnThrows(source, 'run')).toEqual(['OuterError']);
  });
});
