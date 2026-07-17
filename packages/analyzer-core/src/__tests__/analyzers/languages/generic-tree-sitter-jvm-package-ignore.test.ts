jest.unmock('glob');
jest.unmock('fs');
jest.unmock('fs-extra');

import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { GenericTreeSitterLanguageAnalyzer } from '../../../analyzer/languages/generic-tree-sitter-language-analyzer';

/**
 * Regression companion to java-analyzer-samples-package-ignore.test.ts and
 * kotlin-analyzer-samples-package-ignore.test.ts, for the breadth
 * (non-deep-owned) tree-sitter walker: Groovy is a JVM-family language walked
 * by GenericTreeSitterLanguageAnalyzer (it has no deep analyzer of its own),
 * so it shares Java/Kotlin's package-to-directory convention where
 * `samples`/`examples`/`fixtures`/`testdata` are commonly real package
 * segments, not vendored scaffolding. The walker now globs JVM-family
 * extensions through BaseAnalyzer.getPackageDirSafeIgnorePatterns() while
 * every other breadth grammar keeps the full denylist unfiltered. (Scala is
 * nominally owned by JavaAnalyzer per languages/index.ts, so it never reaches
 * this walker at all today — that's a pre-existing gap, not covered here.)
 */
describe('GenericTreeSitterLanguageAnalyzer JVM-family package-dir-safe ignore routing', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'generic-ts-jvm-pkg-'));
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  async function writeFile(relPath: string, content: string): Promise<void> {
    const full = path.join(tmpDir, relPath);
    await fs.ensureDir(path.dirname(full));
    await fs.writeFile(full, content, 'utf-8');
  }

  it('walks a Groovy file living under a literal "examples" package directory', async () => {
    await writeFile(
      'src/main/groovy/org/example/examples/app/Widget.groovy',
      ['package org.example.examples.app', '', 'class Widget {', '  String name() { return "widget" }', '}', ''].join('\n')
    );

    const analyzer = new GenericTreeSitterLanguageAnalyzer();
    expect(await analyzer.canAnalyze(tmpDir)).toBe(true);
  });

  it('still excludes a non-JVM breadth language file under a literal "samples" directory', async () => {
    await writeFile(
      'samples/hello.zig',
      ['const std = @import("std");', '', 'pub fn main() void {}', ''].join('\n')
    );

    const analyzer = new GenericTreeSitterLanguageAnalyzer();
    expect(await analyzer.canAnalyze(tmpDir)).toBe(false);

    const contribution = await analyzer.analyze({ projectPath: tmpDir } as any);
    expect((contribution.nodes || []).some(n => n.type === 'file')).toBe(false);
  });

  it('still walks the same non-JVM breadth language file outside samples/', async () => {
    await writeFile(
      'src/hello.zig',
      ['const std = @import("std");', '', 'pub fn main() void {}', ''].join('\n')
    );

    const analyzer = new GenericTreeSitterLanguageAnalyzer();
    expect(await analyzer.canAnalyze(tmpDir)).toBe(true);
  });
});
