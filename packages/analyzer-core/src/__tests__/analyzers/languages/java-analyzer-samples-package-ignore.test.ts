jest.unmock('glob');
jest.unmock('fs');
jest.unmock('fs-extra');

import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { JavaAnalyzer } from '../../../analyzer/languages/java-analyzer';

/**
 * Regression test (2026-07-17, R7): the shared base-analyzer ignore denylist
 * (getIgnorePatterns) excludes any directory literally named `samples`,
 * `examples`, `fixtures`, or `testdata` to skip vendored example code in
 * JS/Python-style repos. Java's package-to-directory convention turns those
 * into common REAL package segments instead: a codebase using the groupId
 * `org.springframework.samples.petclinic` (the reference Spring PetClinic
 * app, and any codebase following the same convention) physically stores
 * every source file under a directory path that contains a literal `samples`
 * segment. Left unfiltered, JavaAnalyzer's own `**`+`/*.java` glob excluded
 * every file in such a project (0 methods, 0 classes extracted from 100% real
 * source), and framework analyzers layered on top of Java (Spring Boot)
 * inherited the same blindness for controllers/entities/routes.
 *
 * This is a MULTI-MODULE maven layout (each module has its own src/main/java)
 * to also exercise that the fix holds across module boundaries, and it
 * includes a `samples` package segment specifically because that is the
 * reported collision.
 */
describe('JavaAnalyzer does not exclude real code living under a samples/examples/fixtures/testdata package segment', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'java-samples-pkg-'));
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  async function writeFile(relPath: string, content: string): Promise<void> {
    const full = path.join(tmpDir, relPath);
    await fs.ensureDir(path.dirname(full));
    await fs.writeFile(full, content, 'utf-8');
  }

  it('extracts classes and methods from a package path containing a literal "samples" directory, across maven modules', async () => {
    // Root parent pom (multi-module maven layout).
    await writeFile(
      'pom.xml',
      [
        '<project>',
        '  <modelVersion>4.0.0</modelVersion>',
        '  <packaging>pom</packaging>',
        '  <modules>',
        '    <module>module-a</module>',
        '  </modules>',
        '</project>',
      ].join('\n')
    );

    // Module A's real source, physically nested under a "samples" package
    // directory (mirrors org.springframework.samples.petclinic).
    await writeFile(
      'module-a/src/main/java/com/example/samples/app/service/OwnerService.java',
      [
        'package com.example.samples.app.service;',
        '',
        'public class OwnerService {',
        '    public String findName(int id) {',
        '        return "owner-" + id;',
        '    }',
        '',
        '    public void save(String name) {',
        '        System.out.println(name);',
        '    }',
        '}',
      ].join('\n')
    );

    const analyzer = new JavaAnalyzer();
    const canAnalyze = await analyzer.canAnalyze(tmpDir);
    expect(canAnalyze).toBe(true);

    const relevantFiles = await analyzer.getRelevantFiles(tmpDir);
    expect(relevantFiles).toEqual(
      expect.arrayContaining(['module-a/src/main/java/com/example/samples/app/service/OwnerService.java'])
    );

    const contribution = await analyzer.analyze({ projectPath: tmpDir } as any);
    const classNodes = (contribution.nodes || []).filter(n => n.type === 'class');
    const methodNodes = (contribution.nodes || []).filter(n => n.type === 'method');

    expect(classNodes.map(n => n.name)).toContain('OwnerService');
    expect(methodNodes.map(n => n.name)).toEqual(expect.arrayContaining(['findName', 'save']));
  });

  it('still excludes genuinely vendored code under target/ and node_modules/ even with a samples segment nearby', async () => {
    await writeFile('pom.xml', '<project><modelVersion>4.0.0</modelVersion></project>');

    // A real source file, findable.
    await writeFile(
      'src/main/java/com/example/samples/Real.java',
      ['package com.example.samples;', 'public class Real {', '    public void run() {}', '}'].join('\n')
    );

    // A build-output copy under target/ (already covered by the shared
    // target/** ignore, unaffected by this fix) — must NOT be double-counted.
    await writeFile(
      'target/classes/com/example/samples/Real.java',
      ['package com.example.samples;', 'public class Real {', '    public void run() {}', '}'].join('\n')
    );

    const analyzer = new JavaAnalyzer();
    const files = await analyzer.getRelevantFiles(tmpDir);

    expect(files).toContain('src/main/java/com/example/samples/Real.java');
    expect(files.some(f => f.startsWith('target/'))).toBe(false);
  });
});
