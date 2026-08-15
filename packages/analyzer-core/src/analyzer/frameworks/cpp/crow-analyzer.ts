import { AnalysisContext, BaseAnalyzer } from '../../core/base-analyzer';
import { CASContribution, CASEntryPoint } from '../../../types/cas.types';
import * as fs from 'fs-extra';
import * as path from 'path';
import { cachedGlob as glob } from '../../core/glob-cache';














export class CrowAnalyzer extends BaseAnalyzer {
  constructor() {
    super('crow', 'Crow Framework Analyzer', '1.0.0', 'framework');
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    try {
      if (!(await this.hasCrowBuildDependency(projectPath))) return false;
      for (const file of await this.findCppFiles(projectPath)) {
        const content = await fs.readFile(file, 'utf-8');
        if (this.hasCrowUsage(content)) return true;
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
        this.extractCrowRoutes(content, relativePath, entryPoints);
      }

      return this.createContribution(nodes, edges, entryPoints, exitPoints, {
        framework_specific: {
          framework: 'crow',
          route_count: entryPoints.filter(ep => ep.metadata?.framework === 'crow').length,
        },
      });
    } catch (error) {
      throw new Error(`Crow analysis failed: ${(error as Error).message}`);
    }
  }

  protected getCapabilities(): string[] {
    return ['macro-route-detection', 'method-modifier-resolution'];
  }

  protected getLevelName(level: number): string {
    switch (level) {
      case 1: return 'crow-framework';
      case 2: return 'routes';
      case 3: return 'handlers';
      default: return `crow-level-${level}`;
    }
  }

  private async hasCrowBuildDependency(projectPath: string): Promise<boolean> {
    const buildFiles = await glob(['**/CMakeLists.txt', '**/vcpkg.json', '**/conanfile.txt', '**/conanfile.py'], {
      cwd: projectPath,
      ignore: this.getIgnorePatterns({ projectPath }),
      nodir: true,
    });
    for (const file of buildFiles) {
      const content = await fs.readFile(path.join(projectPath, file), 'utf-8').catch(() => '');
      if (/\bcrow\b/i.test(content)) return true;
    }
    for (const file of await this.findCppFiles(projectPath)) {
      const content = await fs.readFile(file, 'utf-8').catch(() => '');
      if (/#include\s*[<"]crow(?:\.h|\/[^">]*)?[>"]/.test(content)) return true;
    }
    return false;
  }

  private hasCrowUsage(content: string): boolean {
    const includesCrow = /#include\s*[<"]crow(?:\.h|\/[^">]*)?[>"]/.test(content);
    const hasRoute = /\bCROW_ROUTE\s*\(/.test(content);
    return includesCrow && hasRoute;
  }









  private extractCrowRoutes(content: string, relativePath: string, entryPoints: CASEntryPoint[]): void {
    if (!/\bCROW_ROUTE\s*\(/.test(content)) return;
    const lineForIndex = this.buildLineIndex(content);
    const macroPattern = /CROW_ROUTE\s*\(\s*[A-Za-z_]\w*\s*,\s*"([^"]+)"\s*\)/g;
    let m: RegExpExecArray | null;
    while ((m = macroPattern.exec(content)) !== null) {
      const routePath = m[1];
      const afterMacro = m.index + m[0].length;


      const windowEnd = Math.min(content.length, afterMacro + 400);
      const window = content.slice(afterMacro, windowEnd);

      const methodsMatch = window.match(/^\s*\.methods\s*\(([^)]*)\)/);
      let methods: string[] = ['GET'];
      let searchFrom = afterMacro;
      if (methodsMatch) {
        const listed = [...methodsMatch[1].matchAll(/HTTPMethod::([A-Za-z]+)/g)].map(x => x[1].toUpperCase());
        if (listed.length > 0) methods = listed;
        searchFrom = afterMacro + methodsMatch[0].length;
      }



      const attachMatch = content.slice(searchFrom, searchFrom + 200).match(/^\s*\(\s*(\[[^\]]*\][\s\S]*)/);
      const line = lineForIndex(m.index);
      const handlerDescriptor = attachMatch ? 'inline handler' : 'unresolved handler';

      for (const crowMethod of methods) {
        const method = this.normalizeMethod(crowMethod);
        if (!method) continue;
        const nodeId = `function_${this.sanitizeId(relativePath)}_crow_route_${this.sanitizeId(routePath)}_${line}`;
        entryPoints.push(this.createEntryPoint(
          `entry:http:${relativePath}:${method}:${routePath}:${line}`,
          nodeId,
          'http',
          `${method} ${routePath}`,
          `Crow route (${handlerDescriptor}) at ${relativePath}:${line}`,
          { method, path: routePath },
          undefined,
          { framework: 'crow', method, path: routePath, handler: handlerDescriptor, file: relativePath, line },
          { node_id: nodeId, method_name: handlerDescriptor, file: relativePath, line }
        ));
      }
    }
  }



  private normalizeMethod(name: string): string | undefined {
    const known = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS', 'CONNECT', 'TRACE', 'PURGE']);
    const upper = name.toUpperCase();
    return known.has(upper) ? upper : undefined;
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
