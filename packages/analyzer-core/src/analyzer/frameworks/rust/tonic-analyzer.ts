import { AnalysisContext, BaseAnalyzer } from '../../core/base-analyzer';
import { CASContribution, CASEntryPoint } from '../../../types/cas.types';
import { RustAnalyzer } from '../../languages/rust-analyzer';
import * as fs from 'fs-extra';
import * as path from 'path';
import { cachedGlob as glob } from '../../core/glob-cache';
















export class TonicAnalyzer extends BaseAnalyzer {
  private rustAnalyzer: RustAnalyzer;

  constructor() {
    super('tonic', 'Tonic gRPC Framework Analyzer', '1.0.0', 'framework');
    this.rustAnalyzer = new RustAnalyzer();
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    if (!(await fs.pathExists(path.join(projectPath, 'Cargo.toml')))) return false;
    try {
      const cargo = await fs.readFile(path.join(projectPath, 'Cargo.toml'), 'utf-8');
      if (!/^\s*tonic\s*=/m.test(cargo) && !/^\s*"tonic"/m.test(cargo)) return false;
      for (const file of await this.findRustFiles(projectPath)) {
        const content = await fs.readFile(file, 'utf-8');
        if (this.hasTonicServiceImpl(content)) return true;
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
      const protoRpcsByService = await this.collectProtoRpcNames(context.projectPath);

      for (const file of files) {
        const relativePath = path.relative(context.projectPath, file);
        const content = await fs.readFile(file, 'utf-8');
        this.extractTonicServiceMethods(content, relativePath, protoRpcsByService, entryPoints);
      }

      return this.createContribution(nodes, edges, entryPoints, exitPoints, {
        framework_specific: {
          framework: 'tonic',
          rpc_count: entryPoints.filter(ep => ep.metadata?.framework === 'tonic').length,
        },
      });
    } catch (error) {
      throw new Error(`Tonic analysis failed: ${(error as Error).message}`);
    }
  }

  protected getCapabilities(): string[] {
    return ['grpc-service-impl-detection', 'rpc-entry-point-resolution', 'proto-cross-check'];
  }

  protected getLevelName(level: number): string {
    switch (level) {
      case 1: return 'tonic-framework';
      case 2: return 'services';
      case 3: return 'rpc-methods';
      default: return `tonic-level-${level}`;
    }
  }






  private hasTonicServiceImpl(content: string): boolean {
    if (!/impl\s+\w+\s+for\s+\w+/.test(content)) return false;
    if (!/async_trait/.test(content)) return false;
    return /Request\s*<|tonic::Request/.test(content) && /Response\s*<|tonic::Response/.test(content);
  }








  private extractTonicServiceMethods(
    content: string,
    relativePath: string,
    protoRpcsByService: Map<string, Set<string>>,
    entryPoints: CASEntryPoint[]
  ): void {
    if (!/async_trait/.test(content)) return;
    const lineForIndex = this.buildLineIndex(content);



    const implPattern = /#\[\s*(?:tonic::)?async_trait(?:::async_trait)?\s*\]\s*(?:#\[[^\]]*\]\s*)*impl(?:<[^>]*>)?\s+([A-Za-z_]\w*)\s+for\s+([A-Za-z_]\w*)/g;
    let m: RegExpExecArray | null;
    while ((m = implPattern.exec(content)) !== null) {
      const serviceTraitName = m[1];
      const structName = m[2];




      const serviceName = serviceTraitName.replace(/Server$/, '');

      const braceOpen = content.indexOf('{', m.index + m[0].length);
      if (braceOpen === -1) continue;
      const braceEnd = this.matchBrace(content, braceOpen);
      if (braceEnd === -1) continue;
      const implBody = content.slice(braceOpen + 1, braceEnd);
      const implBodyOffset = braceOpen + 1;

      const knownRpcs = protoRpcsByService.get(serviceName);





      const methodPattern = /async\s+fn\s+([A-Za-z_]\w*)\s*\(\s*&self[^)]*\)\s*->\s*(?:std::result::)?Result\s*<\s*(?:tonic::)?Response\s*</g;
      let mm: RegExpExecArray | null;
      while ((mm = methodPattern.exec(implBody)) !== null) {
        const rpcName = mm[1];






        if (knownRpcs && !knownRpcs.has(this.normalizeRpcName(rpcName))) continue;

        const absoluteIndex = implBodyOffset + mm.index!;
        const line = lineForIndex(absoluteIndex);
        const fullPath = `/${serviceName}/${rpcName}`;
        const nodeId = `method:${relativePath}:${structName}:${rpcName}`;

        entryPoints.push(this.createEntryPoint(
          `entry:rpc:${relativePath}:${structName}:${rpcName}`,
          nodeId,
          'http',
          `gRPC ${serviceName}.${rpcName}`,
          `Tonic gRPC RPC handled by ${structName}::${rpcName}`,
          { method: 'POST', path: fullPath },
          undefined,
          {
            framework: 'tonic',
            protocol: 'grpc',
            service: serviceName,
            rpc: rpcName,
            handler: `${structName}::${rpcName}`,
            path: fullPath,
            file: relativePath,
            line,
            proto_verified: !!knownRpcs,
          },
          { node_id: nodeId, method_name: rpcName, file: relativePath, line }
        ));
      }
    }
  }






  private async collectProtoRpcNames(projectPath: string): Promise<Map<string, Set<string>>> {
    const result = new Map<string, Set<string>>();
    try {
      const protoFiles = await glob('**/*.proto', { cwd: projectPath, ignore: this.getIgnorePatterns({ projectPath }), nodir: true });
      for (const file of protoFiles) {
        const content = await fs.readFile(path.join(projectPath, file), 'utf-8');
        const servicePattern = /service\s+([A-Za-z_]\w*)\s*\{/g;
        let sm: RegExpExecArray | null;
        while ((sm = servicePattern.exec(content)) !== null) {
          const braceOpen = content.indexOf('{', sm.index + sm[0].length - 1);
          const braceEnd = this.matchBrace(content, braceOpen);
          if (braceEnd === -1) continue;
          const body = content.slice(braceOpen + 1, braceEnd);
          const rpcs = new Set<string>();
          for (const rm of body.matchAll(/rpc\s+([A-Za-z_]\w*)\s*\(/g)) rpcs.add(this.normalizeRpcName(rm[1]));
          result.set(sm[1], rpcs);
        }
      }
    } catch {

    }
    return result;
  }




  private normalizeRpcName(name: string): string {
    return name.toLowerCase().replace(/_/g, '');
  }

  private matchBrace(content: string, openIndex: number): number {
    let depth = 0;
    for (let i = openIndex; i < content.length; i++) {
      if (content[i] === '{') depth++;
      else if (content[i] === '}') { depth--; if (depth === 0) return i; }
    }
    return -1;
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
