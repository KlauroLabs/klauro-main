jest.unmock('glob');
jest.unmock('fs');
jest.unmock('fs-extra');

import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { GenericTreeSitterLanguageAnalyzer } from '../../../analyzer/languages/generic-tree-sitter-language-analyzer';
import { LanguageAnalyzers } from '../../../analyzer/languages/index';

/**
 * Regression for the defect where LanguageAnalyzers (languages/index.ts) mapped
 * scala -> 'JavaAnalyzer', so extensionToGrammar() (in
 * generic-tree-sitter-language-analyzer.ts) treated scala as deep-owned and
 * excluded .scala/.sc/.sbt from the breadth map — but JavaAnalyzer only ever
 * globbed **\/*.java, so scala source produced ZERO nodes anywhere. Fixed by no
 * longer deep-mapping scala, so it now reaches this walker. Scala is JVM-family
 * (JVM_FAMILY_GRAMMAR_IDS), so a literal org/example/samples/ package directory
 * must still be walked, not treated as vendored scaffolding.
 */
describe('GenericTreeSitterLanguageAnalyzer scala breadth coverage', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'generic-ts-scala-'));
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  async function writeFile(relPath: string, content: string): Promise<void> {
    const full = path.join(tmpDir, relPath);
    await fs.ensureDir(path.dirname(full));
    await fs.writeFile(full, content, 'utf-8');
  }

  it('does not claim scala as a deep-owned language', () => {
    expect('scala' in LanguageAnalyzers).toBe(false);
  });

  it('walks a .scala file under a literal org/example/samples/ package directory and emits nodes', async () => {
    await writeFile(
      'src/main/scala/org/example/samples/Widget.scala',
      [
        'package org.example.samples',
        '',
        'class Widget {',
        '  def name(): String = "widget"',
        '}',
        '',
        'object Widget {',
        '  def create(): Widget = new Widget()',
        '}',
        '',
      ].join('\n')
    );

    const analyzer = new GenericTreeSitterLanguageAnalyzer();
    expect(await analyzer.canAnalyze(tmpDir)).toBe(true);

    const contribution = await analyzer.analyze({ projectPath: tmpDir } as any);
    const fileNodes = (contribution.nodes || []).filter(n => n.type === 'file');
    expect(fileNodes.length).toBeGreaterThan(0);
    expect(fileNodes[0].metadata?.language).toBe('scala');

    const classNodes = (contribution.nodes || []).filter(n => n.metadata?.language === 'scala' && n.type !== 'file');
    expect(classNodes.length).toBeGreaterThan(0);
  });

  it('walks a build.sbt file (the sbt/Scala build manifest)', async () => {
    await writeFile(
      'build.sbt',
      ['name := "widget"', 'version := "0.1"', 'scalaVersion := "2.13.12"', ''].join('\n')
    );

    const analyzer = new GenericTreeSitterLanguageAnalyzer();
    expect(await analyzer.canAnalyze(tmpDir)).toBe(true);

    const contribution = await analyzer.analyze({ projectPath: tmpDir } as any);
    const fileNodes = (contribution.nodes || []).filter(n => n.type === 'file' && n.metadata?.language === 'scala');
    expect(fileNodes.length).toBeGreaterThan(0);
  });
});
