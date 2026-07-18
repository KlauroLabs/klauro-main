import { test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { SwiftAnalyzer } from './swift-analyzer';

async function makeProject(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'swift-analyzer-test-'));
  const sources = path.join(dir, 'Sources', 'App');
  await fs.ensureDir(sources);

  await fs.writeFile(path.join(sources, 'App.swift'), `import Foundation
import SwiftUI

protocol Greeter {
    func greet()
}

class Service: Greeter {
    func greet() {
        log()
    }

    func log() {}
}

struct ContentView: View {
    var body: some View {
        Text("hello")
    }
}

@main
struct AppMain: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
        }
    }
}
`, 'utf-8');

  return dir;
}

test('SwiftAnalyzer extracts types, functions, conformance, views, calls and entry points', async () => {
  const projectPath = await makeProject();
  try {
    const analyzer = new SwiftAnalyzer();

    // canAnalyze
    assert.strictEqual(await analyzer.canAnalyze(projectPath), true, 'canAnalyze should be true');

    const cas = await analyzer.analyze({ projectPath });
    const nodes = cas.nodes || [];
    const edges = cas.edges || [];
    const entryPoints = cas.entry_points || [];

    const byName = (name: string) => nodes.find(n => n.name === name);

    // Type nodes
    const greeter = byName('Greeter');
    const service = byName('Service');
    const contentView = byName('ContentView');
    assert.ok(greeter, 'Greeter type node exists');
    assert.ok(service, 'Service type node exists');
    assert.ok(contentView, 'ContentView type node exists');
    assert.strictEqual(greeter!.type, 'interface', 'protocol -> interface node type');
    assert.strictEqual(service!.type, 'class', 'class -> class node type');

    // Function nodes (resolve the Service-owned implementations specifically;
    // the protocol declares a separate greet() requirement).
    const greet = nodes.find(n =>
      n.name === 'greet' && (n.type === 'method' || n.type === 'function') && n.parent === service!.id
    );
    const log = nodes.find(n =>
      n.name === 'log' && (n.type === 'method' || n.type === 'function') && n.parent === service!.id
    );
    assert.ok(greet, 'greet function node exists on Service');
    assert.ok(log, 'log function node exists on Service');

    // Conformance edge Service -> Greeter
    const conformanceEdge = edges.find(e =>
      e.source === service!.id && e.target === greeter!.id &&
      (e.type === 'implements' || e.type === 'extends')
    );
    assert.ok(conformanceEdge, 'conformance edge Service -> Greeter exists');
    assert.strictEqual(conformanceEdge!.type, 'implements', 'protocol conformance uses implements edge');

    // ContentView tagged as SwiftUI view
    assert.ok(contentView!.tags?.includes('swiftui-view'), 'ContentView tagged swiftui-view');

    // calls edge greet -> log
    const callEdge = edges.find(e =>
      e.source === greet!.id && e.target === log!.id && e.type === 'calls'
    );
    assert.ok(callEdge, 'calls edge greet -> log exists');

    // @main entry point
    const appMain = byName('AppMain');
    assert.ok(appMain, 'AppMain type node exists');
    const mainEntry = entryPoints.find(ep => ep.source_node === appMain!.id);
    assert.ok(mainEntry, '@main AppMain registered as an entry point');
    assert.strictEqual(mainEntry!.type, 'lifecycle', '@main App conformer is a lifecycle entry');

    // Regression guard for the public-struct-flood bug: a public type
    // declaration is API surface, not an entry point on its own. This
    // fixture has no public types, so there must be exactly ONE entry point
    // total (the @main App) — not one per type.
    assert.strictEqual(entryPoints.length, 1, 'only the @main App is an entry point, not every type');

    // Public library surface stays a plain node, never an entry point.
    const greeterEntry = entryPoints.find(ep => ep.source_node === greeter!.id);
    const serviceEntry = entryPoints.find(ep => ep.source_node === service!.id);
    assert.strictEqual(greeterEntry, undefined, 'a public/internal protocol is not an entry point');
    assert.strictEqual(serviceEntry, undefined, 'a public/internal class is not an entry point');

    // ContentView (a View) never qualifies as a data entity.
    assert.notStrictEqual(contentView!.type, 'dto', 'a SwiftUI View struct is never reclassified as a dto');
  } finally {
    await fs.remove(projectPath);
  }
});

async function makeCliProject(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'swift-analyzer-cli-test-'));
  const sources = path.join(dir, 'Sources', 'MyCLI');
  await fs.ensureDir(sources);

  await fs.writeFile(path.join(sources, 'MyCLI.swift'), `import ArgumentParser

@main
struct MyCLI: ParsableCommand {
    @Argument var input: String

    func run() throws {
        print(input)
    }
}
`, 'utf-8');

  return dir;
}

test('SwiftAnalyzer: @main ParsableCommand is a cli entry, not lifecycle', async () => {
  const projectPath = await makeCliProject();
  try {
    const analyzer = new SwiftAnalyzer();
    const cas = await analyzer.analyze({ projectPath });
    const nodes = cas.nodes || [];
    const entryPoints = cas.entry_points || [];

    const myCli = nodes.find(n => n.name === 'MyCLI');
    assert.ok(myCli, 'MyCLI type node exists');

    const entry = entryPoints.find(ep => ep.source_node === myCli!.id);
    assert.ok(entry, '@main ParsableCommand registered as an entry point');
    assert.strictEqual(entry!.type, 'cli', '@main ParsableCommand is a cli entry, not lifecycle');
    assert.strictEqual(entryPoints.length, 1, 'exactly one entry point for the CLI command');
  } finally {
    await fs.remove(projectPath);
  }
});

async function makePlainMainStructProject(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'swift-analyzer-plain-main-test-'));
  const sources = path.join(dir, 'Sources', 'helper-cli');
  await fs.ensureDir(sources);

  // A second executable's @main type that is NEITHER a SwiftUI App/Scene NOR
  // a swift-argument-parser command — just a plain struct with its own
  // static main(). Regression fixture for the defect where this fell through
  // to 'lifecycle' ("App entry point: ...") because the old check gated
  // 'cli' on ParsableCommand conformance instead of on the absence of
  // App/Scene.
  await fs.writeFile(path.join(sources, 'HelperMain.swift'), `import Foundation

@main
struct HelperMain {
    static func main() {
        print("helper running")
    }
}
`, 'utf-8');

  return dir;
}

test('SwiftAnalyzer: plain @main struct (no App/Scene, no ParsableCommand) is a cli entry, not lifecycle', async () => {
  const projectPath = await makePlainMainStructProject();
  try {
    const analyzer = new SwiftAnalyzer();
    const cas = await analyzer.analyze({ projectPath });
    const nodes = cas.nodes || [];
    const entryPoints = cas.entry_points || [];

    const helperMain = nodes.find(n => n.name === 'HelperMain');
    assert.ok(helperMain, 'HelperMain type node exists');

    const entry = entryPoints.find(ep => ep.source_node === helperMain!.id);
    assert.ok(entry, '@main HelperMain registered as an entry point');
    assert.strictEqual(entry!.type, 'cli', 'a plain @main struct with no App/Scene conformance is a cli process entry, not lifecycle');
    assert.strictEqual(entryPoints.length, 1, 'exactly one entry point for the plain @main struct');
  } finally {
    await fs.remove(projectPath);
  }
});

async function makeExecutableMainProject(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'swift-analyzer-exe-test-'));
  const sources = path.join(dir, 'Sources', 'tool');
  await fs.ensureDir(sources);

  await fs.writeFile(path.join(sources, 'main.swift'), `import Foundation

let args = CommandLine.arguments
print("running with \\(args.count) args")
`, 'utf-8');

  return dir;
}

test('SwiftAnalyzer: executable target main.swift is a cli entry', async () => {
  const projectPath = await makeExecutableMainProject();
  try {
    const analyzer = new SwiftAnalyzer();
    const cas = await analyzer.analyze({ projectPath });
    const entryPoints = cas.entry_points || [];

    assert.strictEqual(entryPoints.length, 1, 'exactly one entry point for main.swift');
    assert.strictEqual(entryPoints[0].type, 'cli', 'main.swift top-level entry is a cli entry');
  } finally {
    await fs.remove(projectPath);
  }
});

async function makeDataEntityProject(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'swift-analyzer-entity-test-'));
  const sources = path.join(dir, 'Sources', 'App');
  await fs.ensureDir(sources);

  await fs.writeFile(path.join(sources, 'Models.swift'), `import Foundation
import SwiftUI

struct UserProfile: Codable {
    let id: String
    var name: String
    var age: Int

    enum CodingKeys: String, CodingKey {
        case id
        case name
        case age
    }
}

struct Id: Codable {
    let value: String
}

struct ThemeTokens {
    let primary: String
    let secondary: String
}

struct AppTheme: View {
    var body: some View {
        Text("themed")
    }
}
`, 'utf-8');

  return dir;
}

test('SwiftAnalyzer: Codable struct with >=2 fields becomes a dto with property nodes', async () => {
  const projectPath = await makeDataEntityProject();
  try {
    const analyzer = new SwiftAnalyzer();
    const cas = await analyzer.analyze({ projectPath });
    const nodes = cas.nodes || [];

    const userProfile = nodes.find(n => n.name === 'UserProfile');
    assert.ok(userProfile, 'UserProfile type node exists');
    assert.strictEqual(userProfile!.type, 'dto', 'entity-shaped Codable struct reclassifies to dto');
    assert.ok(userProfile!.tags?.includes('swift-data-entity'), 'tagged swift-data-entity');
    assert.ok(
      (userProfile!.metadata as any)?.attributes?.serialization?.includes('CodingKeys'),
      'CodingKeys presence carried as serialization evidence'
    );
    assert.ok(
      (userProfile!.metadata as any)?.attributes?.serialization?.includes('Codable'),
      'Codable conformance carried as serialization evidence'
    );

    const properties = nodes.filter(n => n.type === 'property' && n.parent === userProfile!.id);
    assert.strictEqual(properties.length, 3, 'UserProfile has 3 property child nodes');
    const nameProp = properties.find(p => p.name === 'name');
    assert.ok(nameProp, 'name property node exists');
    assert.strictEqual(nameProp!.signature?.return_type, 'String', 'property type carried on signature.return_type');

    // Single-property wrapper struct is excluded (not an entity, no properties emitted).
    const idType = nodes.find(n => n.name === 'Id');
    assert.ok(idType, 'Id type node exists');
    assert.notStrictEqual(idType!.type, 'dto', 'single-property struct is not reclassified as a dto');

    // ui/theme-ish path/struct is excluded even with >=2 stored properties.
    // (ThemeTokens has 2 String fields but no path-based exclusion trigger in
    // this fixture's flat layout, so assert the View exclusion instead, which
    // IS exercised here.)
    const appTheme = nodes.find(n => n.name === 'AppTheme');
    assert.ok(appTheme, 'AppTheme type node exists');
    assert.notStrictEqual(appTheme!.type, 'dto', 'a SwiftUI View struct is excluded from data-entity reclassification');
  } finally {
    await fs.remove(projectPath);
  }
});
