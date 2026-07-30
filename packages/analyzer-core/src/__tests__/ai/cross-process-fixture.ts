import * as fs from 'fs';
import * as path from 'path';

/**
 * Larger ambiguity fixture for cross-process determinism verification (see
 * run-stability-cross-process.test.ts). Unlike the 2-way fixture in
 * run-stability.test.ts (writeReferenceFixture: one name declared in 2 files),
 * this generates GROUPS of names each declared in 3 DIFFERENT files, spread
 * across many directories, plus a large batch of unrelated filler files — so
 * file discovery/read/parse has real concurrent-I/O surface for a completion-
 * order race to show up in, rather than a handful of files where any race
 * window is too narrow to matter in practice.
 *
 * Each group `g` declares `Shape{g}` / `VALUE{g}` / `LIMIT{g}` identically in
 * decl-a/b/c.ts, and six consumers (two per declaring file) import and READ
 * (never call) them — a plain read is what makes typescript-javascript-
 * analyzer.ts emit a `references` edge resolved by name (see
 * findNodeIdByNameIndexed / selectDeclarationCandidate).
 */
export function writeCrossProcessAmbiguityFixture(
  root: string,
  { groups = 12, fillers = 150 }: { groups?: number; fillers?: number } = {},
): void {
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'klauro-crossproc-ambiguity-fixture', version: '1.0.0' }, null, 2),
  );

  for (let g = 0; g < groups; g++) {
    const dir = path.join(root, 'src', `mod${g}`);
    fs.mkdirSync(dir, { recursive: true });
    const declModule = (tag: string): string =>
      [
        `export interface Shape${g} {`,
        '  region: string;',
        '  retries: number;',
        '}',
        '',
        `export const VALUE${g}: Shape${g} = {`,
        `  region: '${tag}',`,
        '  retries: 3,',
        '};',
        '',
        `export const LIMIT${g} = {`,
        `  ${tag}Max: 100,`,
        '};',
        '',
      ].join('\n');

    // Three declarations of the SAME names for this group, in three different
    // files — a 3-way ambiguity, not just 2-way.
    fs.writeFileSync(path.join(dir, 'decl-a.ts'), declModule('alpha'));
    fs.writeFileSync(path.join(dir, 'decl-b.ts'), declModule('beta'));
    fs.writeFileSync(path.join(dir, 'decl-c.ts'), declModule('gamma'));

    const consumer = (n: number, from: string): string =>
      [
        `import { VALUE${g}, LIMIT${g} } from './${from}';`,
        `import type { Shape${g} } from './${from}';`,
        '',
        `export function consumeG${g}_${n}(): number {`,
        `  const s: Shape${g} = VALUE${g};`,
        `  const region = VALUE${g}.region;`,
        `  const cap = LIMIT${g};`,
        '  return s.retries + region.length + Object.keys(cap).length;',
        '}',
        '',
      ].join('\n');

    fs.writeFileSync(path.join(dir, 'consumer-1.ts'), consumer(1, 'decl-a'));
    fs.writeFileSync(path.join(dir, 'consumer-2.ts'), consumer(2, 'decl-b'));
    fs.writeFileSync(path.join(dir, 'consumer-3.ts'), consumer(3, 'decl-c'));
    fs.writeFileSync(path.join(dir, 'consumer-4.ts'), consumer(4, 'decl-a'));
    fs.writeFileSync(path.join(dir, 'consumer-5.ts'), consumer(5, 'decl-b'));
    fs.writeFileSync(path.join(dir, 'consumer-6.ts'), consumer(6, 'decl-c'));
  }

  // Unrelated filler files: no ambiguity, just more file-discovery/read/parse
  // concurrency surface for a would-be I/O-order race to act on.
  const fillerDir = path.join(root, 'src', 'filler');
  fs.mkdirSync(fillerDir, { recursive: true });
  for (let i = 0; i < fillers; i++) {
    fs.writeFileSync(
      path.join(fillerDir, `f${i}.ts`),
      [`export function filler${i}(x: number): number {`, `  return x + ${i};`, '}', ''].join('\n'),
    );
  }

  // Expected consumer -> declaring-module attribution, keyed by basename, for
  // the runner/test to assert against.
  const expected: Record<string, string> = {};
  for (let g = 0; g < groups; g++) {
    expected[`consumer-1.ts::mod${g}`] = 'decl-a.ts';
    expected[`consumer-2.ts::mod${g}`] = 'decl-b.ts';
    expected[`consumer-3.ts::mod${g}`] = 'decl-c.ts';
    expected[`consumer-4.ts::mod${g}`] = 'decl-a.ts';
    expected[`consumer-5.ts::mod${g}`] = 'decl-b.ts';
    expected[`consumer-6.ts::mod${g}`] = 'decl-c.ts';
  }
  fs.writeFileSync(path.join(root, 'expected-attributions.json'), JSON.stringify(expected, null, 2));
}
