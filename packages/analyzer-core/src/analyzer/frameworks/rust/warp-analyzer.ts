import { AnalysisContext, BaseAnalyzer } from '../../core/base-analyzer';
import { CASContribution, CASEntryPoint } from '../../../types/cas.types';
import { RustAnalyzer } from '../../languages/rust-analyzer';
import * as fs from 'fs-extra';
import * as path from 'path';
import { cachedGlob as glob } from '../../core/glob-cache';















export class WarpAnalyzer extends BaseAnalyzer {
  private rustAnalyzer: RustAnalyzer;

  constructor() {
    super('warp', 'Warp Framework Analyzer', '1.0.0', 'framework');
    this.rustAnalyzer = new RustAnalyzer();
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    if (!(await fs.pathExists(path.join(projectPath, 'Cargo.toml')))) return false;
    try {
      const cargo = await fs.readFile(path.join(projectPath, 'Cargo.toml'), 'utf-8');
      if (!/^\s*warp\s*=/m.test(cargo) && !/^\s*"warp"/m.test(cargo)) return false;
      for (const file of await this.findRustFiles(projectPath)) {
        const content = await fs.readFile(file, 'utf-8');
        if (/\bwarp::path\s*[!(]/.test(content) && /\.and\s*\(/.test(content)) return true;
      }
    } catch {
      return false;
    }
    return false;
  }

  async analyze(context: AnalysisContext): Promise<CASContribution> {
    const rust = await this.rustAnalyzer.analyze(context);
    const nodes = [...(rust.nodes || [])];
    const edges = [...(rust.edges || [])];
    const entryPoints = [...(rust.entry_points || [])];
    const exitPoints = [...(rust.exit_points || [])];

    try {
      const files = await this.findRustFiles(context.projectPath);
      for (const file of files) {
        const relativePath = path.relative(context.projectPath, file);
        const content = await fs.readFile(file, 'utf-8');
        this.extractWarpRoutes(content, relativePath, entryPoints);
      }

      return this.createContribution(nodes, edges, entryPoints, exitPoints, {
        framework_specific: {
          framework: 'warp',
          route_count: entryPoints.filter(ep => ep.metadata?.framework === 'warp').length,
        },
      });
    } catch (error) {
      throw new Error(`Warp analysis failed: ${(error as Error).message}`);
    }
  }

  protected getCapabilities(): string[] {
    return ['filter-chain-route-detection', 'method-filter-resolution', 'handler-resolution'];
  }

  protected getLevelName(level: number): string {
    switch (level) {
      case 1: return 'warp-framework';
      case 2: return 'filters';
      case 3: return 'handlers';
      default: return `warp-level-${level}`;
    }
  }








  private extractWarpRoutes(content: string, relativePath: string, entryPoints: CASEntryPoint[]): void {
    if (!/\bwarp::path\s*[!(]/.test(content)) return;

    const lineForIndex = this.buildLineIndex(content);
    const seen = new Set<string>();




    for (const m of content.matchAll(/\b(?:let\s+(?:mut\s+)?([a-z_][A-Za-z0-9_]*)\s*=\s*)?(warp::path[\s\S]*?);/g)) {
      const exprStart = m.index! + (m[1] ? m[0].indexOf(m[2]) : 0);
      this.parseFilterChainExpression(m[2], relativePath, exprStart, content, lineForIndex, entryPoints, seen);
    }
  }







  private parseFilterChainExpression(
    expr: string,
    relativePath: string,
    exprOffset: number,
    fullContent: string,
    lineForIndex: (idx: number) => number,
    entryPoints: CASEntryPoint[],
    seen: Set<string>
  ): void {
    for (const branch of this.splitTopLevelOr(expr)) {
      if (!/warp::path/.test(branch)) continue;



      const segments: string[] = [];
      for (const pm of branch.matchAll(/warp::path\s*!\s*\(\s*((?:"[^"]*"\s*\/?\s*)+)\)/g)) {
        for (const seg of pm[1].matchAll(/"([^"]*)"/g)) segments.push(seg[1]);
      }
      for (const pm of branch.matchAll(/warp::path\s*\(\s*"([^"]*)"\s*\)/g)) segments.push(pm[1]);


      const paramCount = (branch.match(/warp::path::param\s*\(\s*\)/g) || []).length;
      for (let i = 0; i < paramCount; i++) segments.push(':param');

      const routePath = segments.length > 0 ? `/${segments.join('/')}` : '/';


      const methodMatch = branch.match(/\bwarp::(get|post|put|patch|delete|head|options)\s*\(\s*\)/);
      const method = methodMatch ? methodMatch[1].toUpperCase() : 'GET';





      const handler = this.resolveTerminalHandler(branch);
      if (!handler) continue;

      const dedupeKey = `${relativePath}:${method}:${routePath}:${handler}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      const line = lineForIndex(exprOffset);
      const nodeId = `function:${relativePath}:${handler}`;
      entryPoints.push(this.createEntryPoint(
        `entry:http:${relativePath}:${handler}:${method}:${routePath}`,
        nodeId,
        'http',
        `${method} ${routePath}`,
        `Warp filter-chain route handled by ${handler}`,
        { method, path: routePath },
        undefined,
        { framework: 'warp', method, path: routePath, handler, file: relativePath, line },
        { node_id: nodeId, method_name: handler, file: relativePath, line }
      ));
    }
  }




  private splitTopLevelOr(expr: string): string[] {
    const branches: string[] = [];
    let depth = 0;
    let cur = '';
    for (let i = 0; i < expr.length; i++) {
      const ch = expr[i];
      if (ch === '(' || ch === '[' || ch === '{') depth++;
      if (ch === ')' || ch === ']' || ch === '}') depth--;
      if (depth === 0 && expr.slice(i, i + 4) === '.or(') {
        branches.push(cur);
        cur = '';



        continue;
      }
      cur += ch;
    }
    branches.push(cur);
    return branches;
  }




  private resolveTerminalHandler(branch: string): string | undefined {
    let last: string | undefined;
    for (const m of branch.matchAll(/\.(?:and_then|map)\s*\(\s*([^)]*)\)/g)) {
      const raw = m[1].trim();
      last = this.describeHandler(raw);
    }
    return last;
  }

  private describeHandler(raw: string): string {
    if (/^[A-Za-z_][\w:]*$/.test(raw)) return raw;
    if (/^async\s+[A-Za-z_][\w:]*$/.test(raw)) return raw.replace(/^async\s+/, '');
    if (/^move\s*\|/.test(raw) || /^\|/.test(raw) || /^async\s+move\s*\|/.test(raw)) return 'inline handler';
    return 'inline handler';
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

  private async findRustFiles(projectPath: string): Promise<string[]> {
    const files = await glob('**/*.rs', { cwd: projectPath, ignore: this.getIgnorePatterns({ projectPath }), nodir: true });
    return files.map(file => path.join(projectPath, file));
  }
}
