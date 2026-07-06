jest.unmock('glob');
jest.unmock('fs');
jest.unmock('fs-extra');

import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { JavaAnalyzer } from '../../../analyzer/languages/java-analyzer';
import { CASNode } from '../../../types/cas.types';

/**
 * Regression tests (2026-07-06, #100): the Java analyzer now mirrors the TS/JS fix by
 * surfacing declared `throws` clause type names, javadoc `@throws` tags, and body
 * `throw new Foo(...)` statements into `node.signature.throws` (string[] of type names).
 * Before this, Java throws lived only in `metadata.throwsExceptions`, so both
 * `get_error_contracts` and the flow-concepts error-kind constraint deriver (which read
 * `node.signature.throws`) were dead for every Java repo. Evidence-gated: methods that
 * neither declare nor throw a recoverable type carry no `signature.throws`.
 * See java-analyzer.ts extractThrownTypes / buildSignatureThrows.
 */
describe('JavaAnalyzer signature.throws population', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'java-throws-'));
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  async function analyzeJava(fileName: string, source: string): Promise<CASNode[]> {
    const filePath = path.join(tmpDir, fileName);
    await fs.writeFile(filePath, source, 'utf-8');
    const analyzer = new JavaAnalyzer();
    const result = await analyzer.analyzeFileSingle({
      projectPath: tmpDir,
      filePath,
      relativePath: fileName,
    });
    return result.nodes;
  }

  function methodNode(nodes: CASNode[], name: string): CASNode | undefined {
    return nodes.find(n => (n.type === 'method' || n.type === 'interface_method') && n.name === name);
  }

  it('lifts declared `throws IOException, SQLException` into signature.throws', async () => {
    const source = [
      'package demo;',
      'import java.io.IOException;',
      'import java.sql.SQLException;',
      'public class Reader {',
      '    void foo() throws IOException, SQLException {',
      '        System.out.println("x");',
      '    }',
      '}',
    ].join('\n');

    const nodes = await analyzeJava('Reader.java', source);
    const foo = methodNode(nodes, 'foo');
    expect(foo).toBeDefined();
    expect(foo!.signature?.throws).toEqual(
      expect.arrayContaining(['IOException', 'SQLException'])
    );
    expect(foo!.signature?.throws).toHaveLength(2);
  });

  it('lifts body `throw new FooException(...)` into signature.throws', async () => {
    const source = [
      'package demo;',
      'public class Guard {',
      '    void check(int n) {',
      '        if (n < 0) {',
      '            throw new IllegalStateException("negative");',
      '        }',
      '    }',
      '}',
    ].join('\n');

    const nodes = await analyzeJava('Guard.java', source);
    const check = methodNode(nodes, 'check');
    expect(check).toBeDefined();
    expect(check!.signature?.throws).toEqual(['IllegalStateException']);
  });

  it('merges declared + thrown + fully-qualified thrown types (deduped, simple names)', async () => {
    const source = [
      'package demo;',
      'import java.io.IOException;',
      'public class Mixed {',
      '    void run() throws IOException {',
      '        if (bad()) throw new IllegalArgumentException("bad");',
      '        throw new java.util.NoSuchElementException();',
      '    }',
      '    boolean bad() { return false; }',
      '}',
    ].join('\n');

    const nodes = await analyzeJava('Mixed.java', source);
    const run = methodNode(nodes, 'run');
    expect(run).toBeDefined();
    expect(run!.signature?.throws).toEqual(
      expect.arrayContaining(['IOException', 'IllegalArgumentException', 'NoSuchElementException'])
    );
    expect(run!.signature?.throws).toHaveLength(3);
  });

  it('does NOT populate signature.throws for a method with no declared/thrown types', async () => {
    const source = [
      'package demo;',
      'public class Quiet {',
      '    int add(int a, int b) {',
      '        return a + b;',
      '    }',
      '}',
    ].join('\n');

    const nodes = await analyzeJava('Quiet.java', source);
    const add = methodNode(nodes, 'add');
    expect(add).toBeDefined();
    expect(add!.signature?.throws).toBeUndefined();
  });

  it('does NOT lift a bare rethrow `throw e;` (no recoverable type)', async () => {
    const source = [
      'package demo;',
      'public class Rethrow {',
      '    void wrap() {',
      '        try {',
      '            work();',
      '        } catch (RuntimeException e) {',
      '            throw e;',
      '        }',
      '    }',
      '    void work() {}',
      '}',
    ].join('\n');

    const nodes = await analyzeJava('Rethrow.java', source);
    const wrap = methodNode(nodes, 'wrap');
    expect(wrap).toBeDefined();
    // Only the catch parameter type is not a throw-new; nothing recoverable.
    expect(wrap!.signature?.throws).toBeUndefined();
  });

  it('lifts a multi-line `throws` clause (wrapped across lines) into signature.throws', async () => {
    const source = [
      'package demo;',
      'import java.io.IOException;',
      'import java.sql.SQLException;',
      'public class Wrapper {',
      '    void f()',
      '        throws IOException,',
      '        SQLException {',
      '        System.out.println("x");',
      '    }',
      '}',
    ].join('\n');

    const nodes = await analyzeJava('Wrapper.java', source);
    const f = methodNode(nodes, 'f');
    expect(f).toBeDefined();
    expect(f!.signature?.throws).toEqual(
      expect.arrayContaining(['IOException', 'SQLException'])
    );
    expect(f!.signature?.throws).toHaveLength(2);
  });

  it('does NOT classify a `throw new X()` statement line as a method declaration', async () => {
    const source = [
      'package demo;',
      'public class Thrower {',
      '    void go() {',
      '        throw new IllegalStateException("boom");',
      '    }',
      '}',
    ].join('\n');

    const nodes = await analyzeJava('Thrower.java', source);
    // The only real method is `go`. The `throw new IllegalStateException(...)`
    // line must not be lifted into a phantom `IllegalStateException` method.
    const methods = nodes.filter(
      n => n.type === 'method' || n.type === 'interface_method'
    );
    expect(methods.map(m => m.name).sort()).toEqual(['go']);
    // Sanity: the real throw is still surfaced on the method signature.
    const go = methodNode(nodes, 'go');
    expect(go!.signature?.throws).toEqual(['IllegalStateException']);
  });

  it('lifts declared throws on an interface method into signature.throws', async () => {
    const source = [
      'package demo;',
      'import java.io.IOException;',
      'public interface Store {',
      '    void save(String key) throws IOException;',
      '}',
    ].join('\n');

    const nodes = await analyzeJava('Store.java', source);
    const save = methodNode(nodes, 'save');
    expect(save).toBeDefined();
    expect(save!.signature?.throws).toEqual(['IOException']);
  });
});
