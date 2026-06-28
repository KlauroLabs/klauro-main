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
  } finally {
    await fs.remove(projectPath);
  }
});
