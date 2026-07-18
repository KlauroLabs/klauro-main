import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { SwiftPlatformAnalyzer } from './swift-platform-analyzer';

/** Write a throwaway Swift project and return its path. */
async function fixture(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'swift-platform-test-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    await fs.ensureDir(path.dirname(full));
    await fs.writeFile(full, content);
  }
  return dir;
}

test('detects SwiftUI + AppKit + macOS platform + SwiftPM deps for a menu-bar app', async () => {
  const dir = await fixture({
    'Package.swift': `
// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "MenuBarApp",
    platforms: [.macOS(.v15)],
    dependencies: [
        .package(url: "https://github.com/sparkle-project/Sparkle.git", from: "2.6.0"),
        .package(url: "https://github.com/apple/swift-log.git", from: "1.5.0"),
    ],
    targets: [.executableTarget(name: "MenuBarApp", dependencies: ["Sparkle"])]
)
`,
    'Sources/MenuBarApp/App.swift': `
import SwiftUI

@main
struct MenuBarApp: App {
    var body: some Scene {
        MenuBarExtra("App", systemImage: "gear") {
            ContentView()
        }
    }
}
`,
    'Sources/MenuBarApp/StatusController.swift': `
import AppKit

final class StatusController: NSObject {
    let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
}
`,
  });

  const analyzer = new SwiftPlatformAnalyzer();
  assert.equal(await analyzer.canAnalyze(dir), true);

  const contribution = await analyzer.analyze({ projectPath: dir } as any);
  const meta = contribution.analyzer_metadata as any;

  assert.equal(meta.frameworks_detected.swiftui, true);
  assert.equal(meta.frameworks_detected.appkit, true);
  assert.equal(meta.frameworks_detected.uikit, undefined);
  assert.equal(meta.frameworks_detected['apple-platform-macos'], true);
  assert.equal(meta.frameworks_detected['apple-platform-ios'], undefined);

  const libraryNames = (contribution.libraries || []).map(l => l.name);
  assert.ok(libraryNames.includes('Sparkle'));
  assert.ok(libraryNames.includes('swift-log'));

  await fs.remove(dir);
});

test('detects UIKit + iOS platform for an iOS app, no AppKit/macOS facts', async () => {
  const dir = await fixture({
    'Package.swift': `
// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "MobileApp",
    platforms: [.iOS(.v16)],
    targets: [.target(name: "MobileApp")]
)
`,
    'Sources/MobileApp/AppDelegate.swift': `
import UIKit

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?
}
`,
  });

  const analyzer = new SwiftPlatformAnalyzer();
  assert.equal(await analyzer.canAnalyze(dir), true);

  const contribution = await analyzer.analyze({ projectPath: dir } as any);
  const meta = contribution.analyzer_metadata as any;

  assert.equal(meta.frameworks_detected.uikit, true);
  assert.equal(meta.frameworks_detected['apple-platform-ios'], true);
  assert.equal(meta.frameworks_detected.appkit, undefined);
  assert.equal(meta.frameworks_detected.swiftui, undefined);
  assert.equal(meta.frameworks_detected['apple-platform-macos'], undefined);

  await fs.remove(dir);
});

test('canAnalyze returns false for a Swift project with no SwiftUI/AppKit/UIKit and no platforms manifest key', async () => {
  const dir = await fixture({
    'Package.swift': `
// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "PlainLib",
    targets: [.target(name: "PlainLib")]
)
`,
    'Sources/PlainLib/Util.swift': `
struct Util {
    static func double(_ x: Int) -> Int { x * 2 }
}
`,
  });

  const analyzer = new SwiftPlatformAnalyzer();
  assert.equal(await analyzer.canAnalyze(dir), false);

  await fs.remove(dir);
});
