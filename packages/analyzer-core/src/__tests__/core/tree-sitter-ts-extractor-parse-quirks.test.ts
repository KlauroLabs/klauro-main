import { TreeSitterTSExtractor, sanitizeForTreeSitterParse, sanitizeAbstractPropertyKeyword } from '../../analyzer/core/tree-sitter-ts-extractor';
import { sanitizeContextualUsingIdentifiers, sanitizeInlineImportTypePrefixes, sanitizeTaggedTemplateTypeArguments } from '../../analyzer/core/tree-sitter-grammar-limitations';

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

  it('parses typed tagged templates without changing source offsets', () => {
    const source = 'const rows = await sql<Array<Row>>`SELECT * FROM rows`;';
    const sanitized = sanitizeTaggedTemplateTypeArguments(source);
    const extraction = extractor.extractFromSource(source, 'typed-query.ts');

    expect(sanitized.length).toBe(source.length);
    expect(sanitized.slice(sanitized.indexOf('sql') + 3, sanitized.indexOf('`'))).toMatch(/^ +$/);
    expect(extraction.hasSyntaxErrors).toBe(false);
  });

  it('leaves comparison expressions and untyped tagged templates unchanged', () => {
    const source = 'const lower = a < b; const query = sql`SELECT 1`;';
    expect(sanitizeTaggedTemplateTypeArguments(source)).toBe(source);
  });

  it('does not consume comparisons that precede later template literals', () => {
    const source = `
      export function summarize(values: number[], coverage: number): string {
        for (let index = 0; index < values.length; index++) {
          if (coverage <= 1) return \`\${Math.round(coverage * 100)}%\`;
        }
        return \`count: \${values.length}\`;
      }
    `;
    expect(sanitizeTaggedTemplateTypeArguments(source)).toBe(source);
    expect(extractor.extractFromSource(source, 'comparisons.ts').hasSyntaxErrors).toBe(false);
  });

  it('skips parser child slots that resolve to no node', () => {
    const root = {
      type: 'program',
      namedChildCount: 1,
      namedChild: () => undefined,
    };

    expect(() => (extractor as any).buildTraversalIndex(root)).not.toThrow();
  });
});

/**
 * Regression fixtures for valid TypeScript constructs that the pinned native
 * grammar cannot parse directly. Parser-only rewrites preserve byte offsets:
 * inline import-type prefixes are blanked while retaining the referenced type,
 * and contextual `using` identifiers are renamed without touching resource
 * declarations. Extraction still reads names from the original source.
 */
describe('TreeSitterTSExtractor known grammar limitations', () => {
  const extractor = new TreeSitterTSExtractor();

  it('flags an array-suffixed inline import type as a known limitation, still extracts the rest of the file', () => {
    const source = `
      export type Foo = import('./bar').Bar[];

      export function realFunctionAfter(x: number): number {
        return x + 1;
      }

      export class RealClassAfter {
        method() { return 1; }
      }
    `;
    const extraction = extractor.extractFromSource(source, 'import-type-array-suffix.ts');
    expect(sanitizeInlineImportTypePrefixes(source)).toHaveLength(source.length);
    expect(sanitizeInlineImportTypePrefixes(source)).toContain('Bar[]');
    expect(extraction.hasSyntaxErrors).toBe(false);
    // The parser-only rewrite retains the constructs after the import type.
    expect(extraction.functions.some(f => f.name === 'realFunctionAfter')).toBe(true);
    expect(extraction.classes.some(c => c.name === 'RealClassAfter')).toBe(true);
  });

  it('does NOT misclassify a bare (non-suffixed) inline import type — it parses cleanly', () => {
    const source = `export type Foo = import('./bar').Bar;\n`;
    const extraction = extractor.extractFromSource(source, 'import-type-bare.ts');
    expect(extraction.hasSyntaxErrors).toBe(false);
  });

  it('classifies indexed-access inline import types and their parser recovery tokens', () => {
    const source = `
      export interface Result {
        decision?: import('./protocol').Accepted['decision'];
        cas?: Response['cas'];
        source?: 'head' | 'tree';
      }
    `;
    const extraction = extractor.extractFromSource(source, 'import-type-indexed-access.ts');
    expect(sanitizeInlineImportTypePrefixes(source)).toHaveLength(source.length);
    expect(extraction.hasSyntaxErrors).toBe(false);
  });

  it('flags `using` used as an arrow-function parameter name as a known limitation, still extracts the rest of the file', () => {
    const source = `
      export const handler = using => using.x;

      export function realFunctionAfter(x: number): number {
        return x + 1;
      }
    `;
    const extraction = extractor.extractFromSource(source, 'using-arrow-param.ts');
    expect(sanitizeContextualUsingIdentifiers(source)).toContain('us1ng => us1ng.x');
    expect(extraction.hasSyntaxErrors).toBe(false);
    expect(extraction.functions.some(f => f.name === 'realFunctionAfter')).toBe(true);
  });

  it('flags `using` used as a normal function parameter name as a known limitation, still extracts the function itself', () => {
    const source = `
      export function processResource(using) {
        return using.value;
      }
    `;
    const extraction = extractor.extractFromSource(source, 'using-fn-param.ts');
    expect(extraction.hasSyntaxErrors).toBe(false);
    expect(extraction.functions.some(f => f.name === 'processResource')).toBe(true);
  });

  it('does NOT misclassify a real `using` resource declaration — it parses cleanly, no error at all', () => {
    const source = `
      function f() {
        using x = getResource();
        return x;
      }
    `;
    const extraction = extractor.extractFromSource(source, 'using-real-declaration.ts');
    expect(sanitizeContextualUsingIdentifiers(source)).toContain('using x = getResource()');
    expect(extraction.hasSyntaxErrors).toBe(false);
  });

  it('leaves a genuinely unrecognized construct unclassified (no knownLimitation) rather than over-claiming', () => {
    const source = `
      export function broken(: number {
        return 1;
      }
    `;
    const extraction = extractor.extractFromSource(source, 'genuinely-broken.ts');
    expect(extraction.hasSyntaxErrors).toBe(true);
    expect(extraction.syntaxErrorLocations?.some(l => !l.knownLimitation)).toBe(true);
  });
});
