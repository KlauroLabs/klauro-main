jest.unmock('glob');
jest.unmock('fs');
jest.unmock('fs-extra');

import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { KotlinAnalyzer } from '../../../analyzer/languages/kotlin-analyzer';

/**
 * Regression test companion to java-analyzer-samples-package-ignore.test.ts:
 * Kotlin shares Java's JVM package-to-directory convention, so a package like
 * `org.example.samples.app` is real source living under a directory path
 * containing a literal `samples` segment, not vendored example scaffolding.
 * KotlinAnalyzer now routes its glob calls through BaseAnalyzer.
 * getPackageDirSafeIgnorePatterns() instead of the raw getIgnorePatterns()
 * denylist (which would otherwise drop this file entirely).
 */
describe('KotlinAnalyzer does not exclude real code living under a samples/examples/fixtures/testdata package segment', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kotlin-samples-pkg-'));
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  async function writeFile(relPath: string, content: string): Promise<void> {
    const full = path.join(tmpDir, relPath);
    await fs.ensureDir(path.dirname(full));
    await fs.writeFile(full, content, 'utf-8');
  }

  it('extracts classes and functions from a package path containing a literal "samples" directory', async () => {
    await writeFile(
      'build.gradle.kts',
      ['plugins {', '    kotlin("jvm")', '}'].join('\n')
    );

    await writeFile(
      'src/main/kotlin/org/example/samples/app/service/OwnerService.kt',
      [
        'package org.example.samples.app.service',
        '',
        'class OwnerService {',
        '    fun findName(id: Int): String {',
        '        return "owner-$id"',
        '    }',
        '}',
        '',
      ].join('\n')
    );

    const analyzer = new KotlinAnalyzer();
    const canAnalyze = await analyzer.canAnalyze(tmpDir);
    expect(canAnalyze).toBe(true);

    const relevantFiles = await analyzer.getRelevantFiles(tmpDir);
    expect(relevantFiles).toEqual(
      expect.arrayContaining(['src/main/kotlin/org/example/samples/app/service/OwnerService.kt'])
    );

    const contribution = await analyzer.analyze({ projectPath: tmpDir } as any);
    const classNodes = (contribution.nodes || []).filter(n => n.type === 'class');
    expect(classNodes.map(n => n.name)).toContain('OwnerService');
  });

  it('still excludes genuinely vendored code under build/ even with a samples segment nearby', async () => {
    await writeFile(
      'src/main/kotlin/org/example/samples/Real.kt',
      ['package org.example.samples', 'class Real {', '    fun run() {}', '}', ''].join('\n')
    );

    // A build-output copy under build/ (already covered by the shared build/**
    // ignore, unaffected by this fix) — must NOT be double-counted.
    await writeFile(
      'build/classes/org/example/samples/Real.kt',
      ['package org.example.samples', 'class Real {', '    fun run() {}', '}', ''].join('\n')
    );

    const analyzer = new KotlinAnalyzer();
    const files = await analyzer.getRelevantFiles(tmpDir);

    expect(files).toContain('src/main/kotlin/org/example/samples/Real.kt');
    expect(files.some(f => f.startsWith('build/'))).toBe(false);
  });
});
