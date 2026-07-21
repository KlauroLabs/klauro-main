import { TreeSitterTSExtractor, sanitizeForTreeSitterParse, sanitizeAbstractPropertyKeyword } from '../../analyzer/core/tree-sitter-ts-extractor';

/**
 * Regression fixtures for the self-analysis defect class where valid TS/JS
 * source made tree-sitter-typescript (0.23.2) report a false ERROR/hasError,
 * which the analyzer surfaced as an "analysis error" against perfectly valid
 * source. Two distinct root causes, both confirmed by direct repro against
 * the native grammar (see sanitizeForTreeSitterParse / sanitizeAbstractPropertyKeyword
 * doc comments in tree-sitter-ts-extractor.ts):
 *
 * 1. A literal embedded NUL byte (used deliberately in this codebase as a
 *    collision-proof separator inside template-literal cache/hash keys, e.g.
 *    `` `${a}\0${b}` ``) is treated by the native scanner as an end-of-input
 *    sentinel, not an ordinary character.
 * 2. The bare word `abstract` used AS a property/field name (not as the real
 *    `abstract` modifier) immediately followed by `:`/`?:` inside an
 *    interface body, object type, or class field is mis-lexed as the
 *    modifier keyword.
 *
 * Both are grammar limitations on genuinely valid source, not corruption or
 * real syntax errors — the fix sanitizes only the string handed to the
 * parser, never the file content returned to any other caller.
 */
describe('TreeSitterTSExtractor parse quirks (NUL separator + abstract-as-property-name)', () => {
  const extractor = new TreeSitterTSExtractor();

  it('does not report a syntax error for a real embedded-NUL hash-key separator', () => {
    const source = `
      export function cacheKey(a: string, b: string): string {
        return \`\${a}\\0\${b}\`;
      }
    `;
    const extraction = extractor.extractFromSource(source, 'cache-key.ts');
    expect(extraction.hasSyntaxErrors).toBe(false);
    expect(extraction.functions.some(f => f.name === 'cacheKey')).toBe(true);
  });

  it('sanitizeForTreeSitterParse replaces NUL bytes 1:1 without changing length', () => {
    const source = 'const x = `a\0b`;';
    const sanitized = sanitizeForTreeSitterParse(source);
    expect(sanitized).not.toContain('\0');
    expect(sanitized.length).toBe(source.length);
  });

  it('leaves NUL-free source untouched (identity fast path)', () => {
    const source = 'const x = 1;';
    expect(sanitizeForTreeSitterParse(source)).toBe(source);
  });

  it('does not report a syntax error for `abstract?:` as an interface property name', () => {
    const source = `
      export interface Method {
        name: string;
        static?: boolean;
        abstract?: boolean;
      }
    `;
    const extraction = extractor.extractFromSource(source, 'ast-types-fixture.ts');
    expect(extraction.hasSyntaxErrors).toBe(false);
  });

  it('does not report a syntax error for non-optional `abstract:` as an object-type property name', () => {
    const source = `
      export type ModelMeta = {
        dbTable?: string;
        abstract: boolean;
      };
    `;
    const extraction = extractor.extractFromSource(source, 'django-fixture.ts');
    expect(extraction.hasSyntaxErrors).toBe(false);
  });

  it('leaves real `abstract class` / `abstract method()` usage untouched and correctly extracted', () => {
    const source = `
      export abstract class Base {
        abstract run(): void;
      }
    `;
    const sanitized = sanitizeAbstractPropertyKeyword(source);
    expect(sanitized).toBe(source);
    const extraction = extractor.extractFromSource(source, 'abstract-class.ts');
    expect(extraction.hasSyntaxErrors).toBe(false);
    expect(extraction.classes.some(c => c.name === 'Base')).toBe(true);
  });

  it('sanitizeAbstractPropertyKeyword only quotes `abstract` in key position, not other modifiers', () => {
    const source = 'interface X { abstract?: boolean; static?: boolean; }';
    const sanitized = sanitizeAbstractPropertyKeyword(source);
    expect(sanitized).toContain('"abstract"?:');
    expect(sanitized).toContain('static?:');
    expect(sanitized).not.toContain('"static"');
  });
});
