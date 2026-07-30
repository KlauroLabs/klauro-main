import { parse } from '@typescript-eslint/typescript-estree';
import * as fs from 'fs';
import * as path from 'path';
import { AIStackAnalyzer } from '../../analyzer/libraries/ai-stack-analyzer';

/**
 * blankComments is a SHARED primitive: several regex-based analyzers scan raw
 * source text for call-site patterns and rely on it so a doc comment
 * illustrating the exact shape being detected is not extracted as a real call.
 *
 * It tracked string state but not REGEX LITERALS. A regex whose body contains
 * an unbalanced quote — `/([^'"`]+)/` is ordinary in this codebase — was read
 * as opening a string, and the scanner stayed desynchronised for the REST OF
 * THE FILE, so every comment after it silently stopped being blanked. The
 * failure is invisible at the call site: blanking is applied, it just quietly
 * stops working partway through the file.
 */
describe('blankComments', () => {
  const blank = (src: string) => (new AIStackAnalyzer() as any).blankComments(src) as string;

  /** Authoritative check: blanked positions must be exactly the comment ranges
   *  the TypeScript parser reports — nothing missed, no real code destroyed. */
  const assertMatchesParser = (source: string, label: string) => {
    const ast = parse(source, { comment: true, range: true, loc: false });
    const inComment = new Uint8Array(source.length);
    for (const c of ast.comments || []) {
      for (let i = c.range[0]; i < c.range[1]; i++) inComment[i] = 1;
    }
    const blanked = blank(source);
    expect(blanked.length).toBe(source.length);

    const missed: number[] = [];
    const over: number[] = [];
    for (let i = 0; i < source.length; i++) {
      if (source[i] === '\n' || source[i] === ' ') continue;
      const wasBlanked = blanked[i] === ' ';
      if (inComment[i] && !wasBlanked) missed.push(i);
      if (!inComment[i] && wasBlanked) over.push(i);
    }
    const ctx = (idxs: number[]) =>
      idxs.slice(0, 3).map(i => JSON.stringify(source.slice(Math.max(0, i - 30), i + 30)));
    expect({ label, missedComment: ctx(missed) }).toEqual({ label, missedComment: [] });
    expect({ label, blankedRealCode: ctx(over) }).toEqual({ label, blankedRealCode: [] });
  };

  it('stays synchronised past a regex literal containing quote characters', () => {
    const source = [
      "const head = /([A-Za-z_$][\\w$]*)\\s*\\.\\s*registerTool\\s*\\(\\s*(['\"`])([^'\"`]+)\\2/g;",
      '',
      "/** `<receiver>.registerTool('name', ...)` */",
      'function real() { return 1; }',
    ].join('\n');

    const blanked = blank(source);
    // The doc comment is gone...
    expect(blanked).not.toContain("registerTool('name'");
    // ...and the regex that precedes it is untouched real code.
    expect(blanked).toContain('const head = /(');
    expect(blanked).toContain('function real()');
    assertMatchesParser(source, 'regex-with-quotes');
  });

  it('does not mistake division for a regex', () => {
    const source = [
      'const ratio = total / count;',
      'const nested = (a + b) / (c - d) / 2;',
      'const idx = arr[0] / x;',
      '// a comment after division',
      'const after = 1;',
    ].join('\n');

    const blanked = blank(source);
    expect(blanked).toContain('const ratio = total / count;');
    expect(blanked).toContain('const nested = (a + b) / (c - d) / 2;');
    expect(blanked).toContain('const after = 1;');
    expect(blanked).not.toContain('a comment after division');
    assertMatchesParser(source, 'division');
  });

  it('handles regex character classes containing a slash, and regex after keywords', () => {
    const source = [
      'const p = /[/]path[^/]+/g;',
      'function f(s) { return /^a\\/b$/.test(s); }',
      'const q = s.split(/[,;]/);',
      '/* trailing block comment */',
      'const end = 2;',
    ].join('\n');

    const blanked = blank(source);
    expect(blanked).toContain('const p = /[/]path[^/]+/g;');
    expect(blanked).toContain('/^a\\/b$/.test(s)');
    expect(blanked).toContain('const end = 2;');
    expect(blanked).not.toContain('trailing block comment');
    assertMatchesParser(source, 'regex-edge-cases');
  });

  it('leaves comment markers inside strings and templates alone', () => {
    const source = [
      'const url = "https://example.com/path";',
      "const tpl = `a // not a comment ${x} /* nor this */`;",
      '// but this is',
      'const done = 3;',
    ].join('\n');

    const blanked = blank(source);
    expect(blanked).toContain('"https://example.com/path"');
    expect(blanked).toContain('a // not a comment');
    expect(blanked).not.toContain('but this is');
    assertMatchesParser(source, 'strings');
  });

  it('agrees with the parser on the real analyzer sources that depend on it', () => {
    // These two files are why this matters: both are regex-heavy scanners whose
    // own doc comments illustrate the call shapes they detect.
    const roots = [
      'src/analyzer/libraries/mcp-tool-registration-analyzer.ts',
      'src/analyzer/libraries/ai-stack-analyzer.ts',
    ];
    for (const relative of roots) {
      const file = path.resolve(__dirname, '../../..', relative);
      assertMatchesParser(fs.readFileSync(file, 'utf-8'), relative);
    }
  });

  it('preserves byte offsets and line numbers', () => {
    const source = 'const a = 1; // note\nconst b = /x"y/;\n/* gone */ const c = 3;\n';
    const blanked = blank(source);
    expect(blanked.length).toBe(source.length);
    expect(blanked.split('\n').length).toBe(source.split('\n').length);
    for (let i = 0; i < source.length; i++) {
      if (source[i] === '\n') expect(blanked[i]).toBe('\n');
    }
  });
});
