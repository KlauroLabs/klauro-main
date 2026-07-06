import { TypeScriptJavaScriptAnalyzer } from '../../analyzer/languages/typescript-javascript-analyzer';

/**
 * Verifies `signature.throws` is populated for TS/JS from BOTH evidence sources
 * (2026-07-05): JSDoc `@throws {FooError}` (via the already-parsed `documentation.throws`)
 * and actual `throw new Bar()` statements (via the tree-sitter extractor's `throws`),
 * merged + deduped by `buildSignatureThrows`. Evidence-gated: a bare `throw err` re-throw
 * contributes no type, and when neither source yields a type the field stays absent.
 * See typescript-javascript-analyzer.ts buildSignatureThrows.
 */
describe('TypeScript signature.throws population', () => {
  const analyzer = new TypeScriptJavaScriptAnalyzer() as any;

  it('surfaces the JSDoc @throws type name into signature.throws', () => {
    const jsdoc = [
      '/**',
      ' * Loads a required env var.',
      ' * @throws {MissingEnvVarError} when the var is unset',
      ' */',
    ].join('\n');
    const doc = analyzer.parseJSDoc(jsdoc, 0, 1);
    expect(doc.throws?.[0]?.type).toBe('MissingEnvVarError');

    const throws = analyzer.buildSignatureThrows(undefined, doc);
    expect(throws).toEqual(['MissingEnvVarError']);
  });

  it('surfaces a throw-statement type into signature.throws', () => {
    const throws = analyzer.buildSignatureThrows(['BarError'], undefined);
    expect(throws).toEqual(['BarError']);
  });

  it('merges and dedupes JSDoc + throw-statement types', () => {
    const jsdoc = ['/**', ' * @throws {SharedError}', ' */'].join('\n');
    const doc = analyzer.parseJSDoc(jsdoc, 0, 1);
    const throws = analyzer.buildSignatureThrows(['SharedError', 'ExtraError'], doc);
    expect(new Set(throws)).toEqual(new Set(['SharedError', 'ExtraError']));
    expect(throws!.length).toBe(2);
  });

  it('stays undefined when neither source yields a type (bare re-throw case)', () => {
    // A `throw err` re-throw produces no extractor type and no JSDoc @throws.
    expect(analyzer.buildSignatureThrows(undefined, undefined)).toBeUndefined();
    expect(analyzer.buildSignatureThrows([], { throws: [] } as any)).toBeUndefined();
  });
});
