import { AnalysisContext, BaseAnalyzer } from '../../core/base-analyzer';
import { CASContribution, CASEntryPoint } from '../../../types/cas.types';
import * as fs from 'fs-extra';
import * as path from 'path';
import { cachedGlob as glob } from '../../core/glob-cache';

/**
 * Drogon (C++) framework analyzer.
 *
 * Drogon exposes routes two ways, both handled here:
 *  1. Controller macro: `ADD_METHOD_TO(Controller::method, "/path", Get)` (or the
 *     path-parameter form `ADD_METHOD_TO(Controller::method, "/path/{id}", Get)`),
 *     usually inside `PATH_LIST_BEGIN ... PATH_LIST_END` in a `HttpController`
 *     subclass's header.
 *  2. Programmatic registration: `app().registerHandler("/path", &handler, {Get})`.
 * Real dependency gate: a CMakeLists.txt (or vcpkg/conan manifest) referencing Drogon,
 * or a direct `#include <drogon/...>` — never inferred from folder names.
 */
export class DrogonAnalyzer extends BaseAnalyzer {
  constructor() {
    super('drogon', 'Drogon Framework Analyzer', '1.0.0', 'framework');
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    try {
      if (!(await this.hasDrogonBuildDependency(projectPath))) return false;
      for (const file of await this.findCppFiles(projectPath)) {
        const content = await fs.readFile(file, 'utf-8');
        if (this.hasDrogonUsage(content)) return true;
      }
    } catch {
      return false;
    }
    return false;
  }

  async analyze(context: AnalysisContext): Promise<CASContribution> {
    const nodes: any[] = [];
    const edges: any[] = [];
    const entryPoints: CASEntryPoint[] = [];
    const exitPoints: any[] = [];

    try {
      const files = await this.findCppFiles(context.projectPath);
      for (const file of files) {
        const relativePath = path.relative(context.projectPath, file);
        const content = await fs.readFile(file, 'utf-8');
        this.extractAddMethodToRoutes(content, relativePath, entryPoints);
        this.extractRegisterHandlerRoutes(content, relativePath, entryPoints);
      }

      return this.createContribution(nodes, edges, entryPoints, exitPoints, {
        framework_specific: {
          framework: 'drogon',
          route_count: entryPoints.filter(ep => ep.metadata?.framework === 'drogon').length,
        },
      });
    } catch (error) {
      throw new Error(`Drogon analysis failed: ${(error as Error).message}`);
    }
  }

  protected getCapabilities(): string[] {
    return ['controller-macro-route-detection', 'register-handler-detection'];
  }

  protected getLevelName(level: number): string {
    switch (level) {
      case 1: return 'drogon-framework';
      case 2: return 'controllers';
      case 3: return 'routes';
      default: return `drogon-level-${level}`;
    }
  }

  private async hasDrogonBuildDependency(projectPath: string): Promise<boolean> {
    const buildFiles = await glob(['**/CMakeLists.txt', '**/vcpkg.json', '**/conanfile.txt', '**/conanfile.py'], {
      cwd: projectPath,
      ignore: this.getIgnorePatterns({ projectPath }),
      nodir: true,
    });
    for (const file of buildFiles) {
      const content = await fs.readFile(path.join(projectPath, file), 'utf-8').catch(() => '');
      if (/\bdrogon\b/i.test(content)) return true;
    }
    // Fall back to a direct include, in case the build system reference is indirect
    // (e.g. a vendored/system-installed Drogon with no manifest entry).
    for (const file of await this.findCppFiles(projectPath)) {
      const content = await fs.readFile(file, 'utf-8').catch(() => '');
      if (/#include\s*[<"]drogon\//.test(content)) return true;
    }
    return false;
  }

  private hasDrogonUsage(content: string): boolean {
    const includesDrogon = /#include\s*[<"]drogon\//.test(content);
    const hasMacroRoute = /\bADD_METHOD_TO\s*\(/.test(content);
    const hasRegisterHandler = /\bapp\s*\(\s*\)\s*\.\s*registerHandler\s*\(/.test(content);
    return includesDrogon && (hasMacroRoute || hasRegisterHandler);
  }

  /**
   * `ADD_METHOD_TO(Controller::method, "/path", Get[, Post, ...])` — one macro
   * invocation can list multiple HTTP methods for the same handler/path, so each
   * listed method becomes its own entry point.
   */
  private extractAddMethodToRoutes(content: string, relativePath: string, entryPoints: CASEntryPoint[]): void {
    if (!/\bADD_METHOD_TO\s*\(/.test(content)) return;
    const lineForIndex = this.buildLineIndex(content);
    const pattern = /ADD_METHOD_TO\s*\(\s*([A-Za-z_]\w*)::([A-Za-z_]\w*)\s*,\s*"([^"]+)"\s*((?:,\s*[A-Za-z_]\w*\s*)*)\)/g;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(content)) !== null) {
      const controllerName = m[1];
      const handlerMethod = m[2];
      const routePath = m[3];
      const methodsRaw = m[4] || '';
      const methods = [...methodsRaw.matchAll(/[A-Za-z_]\w*/g)].map(x => x[0]).filter(name => this.isHttpMethodToken(name));
      const httpMethods = methods.length > 0 ? methods : ['GET'];
      const line = lineForIndex(m.index);

      for (const drogonMethod of httpMethods) {
        const method = drogonMethod.toUpperCase();
        const nodeId = `method_${this.sanitizeId(relativePath)}_${this.sanitizeId(controllerName)}_${this.sanitizeId(handlerMethod)}`;
        entryPoints.push(this.createEntryPoint(
          `entry:http:${relativePath}:${controllerName}:${handlerMethod}:${method}:${routePath}`,
          nodeId,
          'http',
          `${method} ${routePath}`,
          `Drogon controller route handled by ${controllerName}::${handlerMethod}`,
          { method, path: routePath },
          undefined,
          { framework: 'drogon', method, path: routePath, handler: `${controllerName}::${handlerMethod}`, controller: controllerName, file: relativePath, line },
          { node_id: nodeId, method_name: handlerMethod, file: relativePath, line }
        ));
      }
    }
  }

  /**
   * `app().registerHandler("/path", &SomeClass::method, {Get, Post})` (methods list
   * optional — Drogon defaults to Get when omitted) or a free-function/lambda handler.
   */
  private extractRegisterHandlerRoutes(content: string, relativePath: string, entryPoints: CASEntryPoint[]): void {
    if (!/\bapp\s*\(\s*\)\s*\.\s*registerHandler\s*\(/.test(content)) return;
    const lineForIndex = this.buildLineIndex(content);
    const pattern = /app\s*\(\s*\)\s*\.\s*registerHandler\s*\(\s*"([^"]+)"\s*,\s*&?([A-Za-z_][\w:]*)\s*(?:,\s*\{([^}]*)\})?/g;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(content)) !== null) {
      const routePath = m[1];
      const handler = m[2];
      const methodsRaw = m[3] || '';
      const methods = [...methodsRaw.matchAll(/[A-Za-z_]\w*/g)].map(x => x[0]).filter(name => this.isHttpMethodToken(name));
      const httpMethods = methods.length > 0 ? methods : ['GET'];
      const line = lineForIndex(m.index);

      for (const drogonMethod of httpMethods) {
        const method = drogonMethod.toUpperCase();
        const nodeId = `function_${this.sanitizeId(relativePath)}_${this.sanitizeId(handler.replace(/::/g, '_'))}`;
        entryPoints.push(this.createEntryPoint(
          `entry:http:${relativePath}:${handler}:${method}:${routePath}`,
          nodeId,
          'http',
          `${method} ${routePath}`,
          `Drogon registerHandler route handled by ${handler}`,
          { method, path: routePath },
          undefined,
          { framework: 'drogon', method, path: routePath, handler, file: relativePath, line },
          { node_id: nodeId, method_name: handler, file: relativePath, line }
        ));
      }
    }
  }

  /** Drogon's HttpMethod enum values used in ADD_METHOD_TO / registerHandler lists. */
  private isHttpMethodToken(token: string): boolean {
    return /^(Get|Post|Put|Delete|Patch|Head|Options)$/i.test(token);
  }

  private buildLineIndex(content: string): (idx: number) => number {
    const offsets: number[] = [];
    let offset = 0;
    for (const line of content.split('\n')) { offsets.push(offset); offset += line.length + 1; }
    return (idx: number) => {
      let low = 0, high = offsets.length - 1, result = 0;
      while (low <= high) { const mid = (low + high) >> 1; if (offsets[mid] <= idx) { result = mid; low = mid + 1; } else { high = mid - 1; } }
      return result + 1;
    };
  }

  private async findCppFiles(projectPath: string): Promise<string[]> {
    const files = await glob(['**/*.cpp', '**/*.cc', '**/*.cxx', '**/*.h', '**/*.hpp', '**/*.hh', '**/*.hxx'], {
      cwd: projectPath,
      ignore: this.getIgnorePatterns({ projectPath }),
      nodir: true,
    });
    return files.map(file => path.join(projectPath, file));
  }
}
