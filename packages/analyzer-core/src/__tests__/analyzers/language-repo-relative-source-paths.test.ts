jest.unmock('fs-extra');
jest.unmock('fs');
jest.unmock('glob');

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { JavaAnalyzer } from '../../analyzer/languages/java-analyzer';
import { GoAnalyzer } from '../../analyzer/languages/go-analyzer';
import { PythonAnalyzer } from '../../analyzer/languages/python-analyzer';
import { PHPAnalyzer } from '../../analyzer/languages/php-analyzer';
import { CSharpAnalyzer } from '../../analyzer/languages/csharp-analyzer';
import { RubyAnalyzer } from '../../analyzer/languages/ruby-analyzer';
import { RustAnalyzer } from '../../analyzer/languages/rust-analyzer';
import { DartAnalyzer } from '../../analyzer/languages/dart-analyzer';

/**
 * Task #115, language-analyzer half. Same defect as the framework half: an
 * analyzer builds an absolute path to READ a file and then also stores it as
 * the node's source.file, leaking the analysis sandbox's layout.
 *
 * The language analyzers additionally leak it through two channels the
 * `withSource({ file: ... })` grep never sees:
 *   - `createNode(id, name, type, level, filePath, ...)`, whose 5th positional
 *     argument becomes source.file, and
 *   - comments/todos, whose `location.file` is a top-level CASNode field.
 * Both are asserted here, not just node.source.file.
 */
describe('language analyzers record repo-relative paths, never absolute', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-lang-relative-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const write = (relative: string, body: string) => {
    const full = path.join(root, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  };

  /** Absolute AND under the project root — the sandbox-layout leak exactly. */
  const leaks = (root_: string, values: Array<{ what: string; file?: string }>) =>
    values
      .filter(v => v.file && path.isAbsolute(v.file))
      .filter(v => {
        const rel = path.relative(root_, v.file as string);
        return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
      })
      .map(v => `${v.what} -> ${v.file}`);

  /** Every stored path an analyzer emitted: node source, comments, todos. */
  const storedPaths = (nodes: Array<any>) => {
    const out: Array<{ what: string; file?: string }> = [];
    for (const node of nodes) {
      out.push({ what: `${node.id}.source`, file: node?.source?.file });
      for (const comment of node?.comments ?? []) {
        out.push({ what: `${node.id}.comment`, file: comment?.location?.file });
      }
      for (const todo of node?.todos ?? []) {
        out.push({ what: `${node.id}.todo`, file: todo?.location?.file });
      }
    }
    return out;
  };

  const run = async (analyzer: any) => {
    const contribution = await analyzer.analyze({
      projectPath: root,
      config: {},
      metadata: {},
    });
    return contribution?.nodes ?? [];
  };

  const expectClean = (nodes: Array<any>) => {
    expect(nodes.length).toBeGreaterThan(0);
    expect(leaks(root, storedPaths(nodes))).toEqual([]);
  };

  it('Java: file, class, interface and method nodes stay repo-relative', async () => {
    write('pom.xml', '<project><groupId>fx</groupId></project>');
    write(
      'src/main/java/com/fx/OrderService.java',
      [
        'package com.fx;',
        'import java.util.List;',
        '// TODO: paginate this',
        'public class OrderService {',
        '  private String name;',
        '  public List<String> findAll() { return null; }',
        '}',
      ].join('\n')
    );
    write(
      'src/main/java/com/fx/Repo.java',
      ['package com.fx;', 'public interface Repo {', '  void save(String s);', '}'].join('\n')
    );

    expectClean(await run(new JavaAnalyzer()));
  });

  it('Go: file, struct, interface and function nodes stay repo-relative', async () => {
    write('go.mod', 'module fx\n\ngo 1.21\n');
    write(
      'main.go',
      [
        'package main',
        'import "fmt"',
        '// Order is a customer order.',
        'type Order struct {',
        '\tID string',
        '}',
        'type Store interface {',
        '\tSave(o Order) error',
        '}',
        '// TODO: handle errors',
        'func main() { fmt.Println("hi") }',
      ].join('\n')
    );

    expectClean(await run(new GoAnalyzer()));
  });

  it('Python: module, class and function nodes stay repo-relative', async () => {
    write('requirements.txt', 'requests==2.31.0\n');
    write(
      'orders.py',
      [
        'import os',
        '',
        '# TODO: add validation',
        'class Order:',
        '    """An order."""',
        '    def total(self):',
        '        return 0',
        '',
        'def make_order():',
        '    return Order()',
      ].join('\n')
    );

    expectClean(await run(new PythonAnalyzer()));
  });

  it('PHP: file, class, interface and trait nodes stay repo-relative', async () => {
    write('composer.json', JSON.stringify({ name: 'fx/app' }));
    write(
      'src/Order.php',
      [
        '<?php',
        'namespace Fx;',
        '// TODO: validate',
        'class Order {',
        '  private $id;',
        '  public function total() { return 0; }',
        '}',
        'interface Repo { public function save(); }',
        'trait Loggable { public function log() {} }',
      ].join('\n')
    );

    expectClean(await run(new PHPAnalyzer()));
  });

  it('C#: file, class, interface, enum and struct nodes stay repo-relative', async () => {
    write('fx.csproj', '<Project Sdk="Microsoft.NET.Sdk"></Project>');
    write(
      'Order.cs',
      [
        'namespace Fx {',
        '  // TODO: add validation',
        '  public class Order {',
        '    public string Id { get; set; }',
        '    public int Total() { return 0; }',
        '  }',
        '  public interface IRepo { void Save(); }',
        '  public enum Status { New, Done }',
        '  public struct Money { public int Cents; }',
        '}',
      ].join('\n')
    );

    expectClean(await run(new CSharpAnalyzer()));
  });

  it('Ruby: class, module, method and constant nodes stay repo-relative', async () => {
    write('Gemfile', "source 'https://rubygems.org'\n");
    write(
      'app/models/order.rb',
      [
        'module Billing',
        '  MAX = 10',
        '  class Order',
        '    def total',
        '      0',
        '    end',
        '  end',
        'end',
      ].join('\n')
    );

    expectClean(await run(new RubyAnalyzer()));
  });

  it('Rust: file and item nodes stay repo-relative', async () => {
    write('Cargo.toml', '[package]\nname = "fx"\nversion = "0.1.0"\n');
    write(
      'src/main.rs',
      [
        '// TODO: wire up config',
        'pub struct Order {',
        '    pub id: String,',
        '}',
        'pub fn main() {',
        '    println!("hi");',
        '}',
      ].join('\n')
    );

    expectClean(await run(new RustAnalyzer()));
  });

  it('Dart: file, class, function and route nodes stay repo-relative', async () => {
    write('pubspec.yaml', 'name: fx\nenvironment:\n  sdk: ">=3.0.0 <4.0.0"\n');
    write(
      'lib/main.dart',
      [
        "import 'dart:async';",
        '',
        '// TODO: add tests',
        'class Order {',
        '  final String id;',
        '  Order(this.id);',
        '}',
        '',
        'void main() {',
        '  print(Order("1").id);',
        '}',
      ].join('\n')
    );

    expectClean(await run(new DartAnalyzer()));
  });
});
