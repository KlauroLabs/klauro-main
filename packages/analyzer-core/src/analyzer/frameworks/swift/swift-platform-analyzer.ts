import { BaseAnalyzer, AnalysisContext } from '../../core/base-analyzer';
import {
  CASContribution, CASEntryPoint, CASExitPoint, CASNode, CASEdge, CASLibrary
} from '../../../types/cas.types';
import * as fs from 'fs-extra';
import { cachedGlob as glob } from '../../core/glob-cache';
import * as path from 'path';

























const SWIFT_GLOB = ['**/*.swift'];
const IMPORT_SWIFTUI = /^\s*import\s+SwiftUI\b/m;
const IMPORT_APPKIT = /^\s*import\s+AppKit\b/m;
const IMPORT_UIKIT = /^\s*import\s+UIKit\b/m;

export class SwiftPlatformAnalyzer extends BaseAnalyzer {
  constructor() {
    super('swift-platform', 'Swift Platform Analyzer', '1.0.0', 'framework');
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    try {
      const pkgPath = path.join(projectPath, 'Package.swift');
      if (await fs.pathExists(pkgPath)) {
        const content = await fs.readFile(pkgPath, 'utf-8').catch(() => '');
        if (/platforms\s*:\s*\[/.test(content) || /\.package\s*\(/.test(content)) return true;
      }
      for (const file of await this.findSwiftFiles(projectPath)) {
        const content = await fs.readFile(file, 'utf-8').catch(() => '');
        if (IMPORT_SWIFTUI.test(content) || IMPORT_APPKIT.test(content) || IMPORT_UIKIT.test(content)) {
          return true;
        }
      }
      return false;
    } catch {
      return false;
    }
  }

  async analyze(context: AnalysisContext): Promise<CASContribution> {
    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const entryPoints: CASEntryPoint[] = [];
    const exitPoints: CASExitPoint[] = [];
    const libraries: CASLibrary[] = [];

    let swiftui = false;
    let appkit = false;
    let uikit = false;

    for (const file of await this.findSwiftFiles(context.projectPath)) {
      const content = await fs.readFile(file, 'utf-8').catch(() => '');
      if (!swiftui && IMPORT_SWIFTUI.test(content)) swiftui = true;
      if (!appkit && IMPORT_APPKIT.test(content)) appkit = true;
      if (!uikit && IMPORT_UIKIT.test(content)) uikit = true;
      if (swiftui && appkit && uikit) break;
    }

    let macos = false;
    let ios = false;
    const pkgPath = path.join(context.projectPath, 'Package.swift');
    if (await fs.pathExists(pkgPath)) {
      const pkgContent = await fs.readFile(pkgPath, 'utf-8').catch(() => '');
      const platformsMatch = pkgContent.match(/platforms\s*:\s*\[([\s\S]*?)\]/);
      if (platformsMatch) {
        const block = platformsMatch[1];
        macos = /\.macOS\s*\(/.test(block);
        ios = /\.iOS\s*\(/.test(block);
      }
      this.extractPackageDependencies(pkgContent, libraries);
    }

    const frameworksDetected: Record<string, boolean> = {};
    if (swiftui) frameworksDetected.swiftui = true;
    if (appkit) frameworksDetected.appkit = true;
    if (uikit) frameworksDetected.uikit = true;




    if (macos) frameworksDetected['apple-platform-macos'] = true;
    if (ios) frameworksDetected['apple-platform-ios'] = true;

    const contribution = this.createContribution(nodes, edges, entryPoints, exitPoints, {
      framework: 'swift-platform',
      frameworks_detected: frameworksDetected,
      framework_specific: {
        framework: 'swift-platform',
        swiftui,
        appkit,
        uikit,
        platforms: { macos, ios },
        dependency_count: libraries.length,
      },
    });
    if (libraries.length > 0) {
      contribution.libraries = libraries;
    }
    return contribution;
  }

  protected getCapabilities(): string[] {
    return ['swift-ui-framework-detection', 'swiftpm-platform-detection', 'swiftpm-dependency-extraction'];
  }

  protected getLevelName(level: number): string {
    switch (level) {
      case 1: return 'swift-platform';
      default: return `swift-platform-level-${level}`;
    }
  }







  private extractPackageDependencies(pkgContent: string, libraries: CASLibrary[]): void {
    const depRegex = /\.package\s*\(\s*(?:name\s*:\s*"[^"]*"\s*,\s*)?url\s*:\s*"([^"]+)"/g;
    const seen = new Set<string>();
    let match: RegExpExecArray | null;
    while ((match = depRegex.exec(pkgContent)) !== null) {
      const url = match[1];
      const nameMatch = url.match(/\/([^/]+?)(?:\.git)?$/);
      const name = nameMatch ? nameMatch[1] : url;
      if (seen.has(name)) continue;
      seen.add(name);
      libraries.push({
        id: `swiftpm:${name}`,
        name,
        package_manager: 'swiftpm',
        category: 'dependency',
      });
    }
  }

  private async findSwiftFiles(projectPath: string): Promise<string[]> {
    const files = await glob(SWIFT_GLOB, {
      cwd: projectPath,
      ignore: this.getIgnorePatterns({ projectPath } as AnalysisContext),
      nodir: true,
    });
    return files.map(file => path.join(projectPath, file));
  }
}

export default { SwiftPlatformAnalyzer };
