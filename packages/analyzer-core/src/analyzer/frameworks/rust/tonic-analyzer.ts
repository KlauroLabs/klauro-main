import { AnalysisContext, BaseAnalyzer } from '../../core/base-analyzer';
import { CASContribution, CASEntryPoint } from '../../../types/cas.types';
import { RustAnalyzer } from '../../languages/rust-analyzer';
import * as fs from 'fs-extra';
import * as path from 'path';
import { glob } from 'glob';

/**
 * Tonic (gRPC) framework analyzer.
 *
 * Tonic generates a `<Name>Server` trait per proto `service` and the handwritten
 * server code implements it: `#[tonic::async_trait] impl <Name> for MyServer { async
 * fn some_rpc(&self, request: Request<...>) -> Result<Response<...>, Status> { ... }
 * ... }`. Full route facts (request/response message shapes) require parsing the
 * originating `.proto` file, which is out of scope here — this analyzer surfaces the
 * REAL entry point that matters to an agent: each gRPC-service-trait impl method is an
 * RPC entry point (analogous to an HTTP route), resolved to the real impl-method node,
 * without fabricating proto-level detail we can't verify from Rust source alone. If a
 * sibling `.proto` file for the same service name is present, its RPC method names are
 * cross-checked so only real trait methods (not incidental helper methods on the same
 * impl block) are reported.
 */
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

  /** True if the file has at least one `#[tonic::async_trait] impl X for Y { ... }`
   *  block (with or without the attribute being written exactly that way — tonic's
   *  generated `*Server` traits are also frequently implemented via the re-exported
   *  `#[async_trait::async_trait]` or plain `#[async_trait]` when the crate imports
   *  tonic's re-export under that name) whose body has a Request/Response method. */
  private hasTonicServiceImpl(content: string): boolean {
    if (!/impl\s+\w+\s+for\s+\w+/.test(content)) return false;
    if (!/async_trait/.test(content)) return false;
    return /Request\s*<|tonic::Request/.test(content) && /Response\s*<|tonic::Response/.test(content);
  }

  /**
   * Extract each `#[tonic::async_trait] impl <ServiceTrait> for <Struct> { ... }`
   * block's RPC methods (any `async fn <name>(&self, request: Request<...>) ->
   * Result<Response<...>, Status>` inside it — the exact shape tonic-build generates
   * per proto RPC). Each method becomes one gRPC entry point resolved to the real
   * impl-method source location.
   */
  private extractTonicServiceMethods(
    content: string,
    relativePath: string,
    protoRpcsByService: Map<string, Set<string>>,
    entryPoints: CASEntryPoint[]
  ): void {
    if (!/async_trait/.test(content)) return;
    const lineForIndex = this.buildLineIndex(content);

    // `#[tonic::async_trait]` / `#[async_trait::async_trait]` / `#[async_trait]`
    // immediately preceding `impl <ServiceTrait> for <Struct>`.
    const implPattern = /#\[\s*(?:tonic::)?async_trait(?:::async_trait)?\s*\]\s*(?:#\[[^\]]*\]\s*)*impl(?:<[^>]*>)?\s+([A-Za-z_]\w*)\s+for\s+([A-Za-z_]\w*)/g;
    let m: RegExpExecArray | null;
    while ((m = implPattern.exec(content)) !== null) {
      const serviceTraitName = m[1];
      const structName = m[2];
      // Tonic's generated server trait is named `<Service>Server` (the trait the
      // generated `<Service>Server<T>` tonic wrapper requires); the logical service
      // name strips that suffix so it lines up with a `service <Name> { ... }` in the
      // .proto (if present) and reads naturally (`UserService` not `UserServiceServer`).
      const serviceName = serviceTraitName.replace(/Server$/, '');

      const braceOpen = content.indexOf('{', m.index + m[0].length);
      if (braceOpen === -1) continue;
      const braceEnd = this.matchBrace(content, braceOpen);
      if (braceEnd === -1) continue;
      const implBody = content.slice(braceOpen + 1, braceEnd);
      const implBodyOffset = braceOpen + 1;

      const knownRpcs = protoRpcsByService.get(serviceName);

      // Every `async fn <name>(&self, ...) -> Result<Response<...>, Status>` (or
      // the streaming `Result<Response<Self::XStream>, Status>` form) directly in
      // the impl body is a generated RPC handler — tonic-build never emits any other
      // method shape on the service trait.
      const methodPattern = /async\s+fn\s+([A-Za-z_]\w*)\s*\(\s*&self[^)]*\)\s*->\s*(?:std::result::)?Result\s*<\s*(?:tonic::)?Response\s*</g;
      let mm: RegExpExecArray | null;
      while ((mm = methodPattern.exec(implBody)) !== null) {
        const rpcName = mm[1];
        // If we have real proto RPC names for this service, only report methods that
        // are actually declared RPCs (filters out any plain helper `async fn` on the
        // same impl block that happens to return a Response<T> incidentally). Compare
        // via a normalized (lowercase, underscores stripped) key because tonic-build
        // renames PascalCase proto RPC names (`GetUser`) to snake_case trait methods
        // (`get_user`) — the two names never match by exact string equality.
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

  /** Best-effort: parse any `.proto` file's `service <Name> { rpc <Method>(...) ...
   *  }` blocks so tonic impl methods can be cross-checked against real RPC names.
   *  Absence of a .proto is expected (vendored/generated-only repos) — callers must
   *  treat a missing entry as "unknown", not "no RPCs", which is why this returns a
   *  Map that's simply empty rather than gating analysis on finding a .proto. */
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
      // Best effort only — proto cross-check is an enhancement, not a requirement.
    }
    return result;
  }

  /** Normalize an RPC name (either a PascalCase proto RPC name or a snake_case tonic
   *  trait method name) to a lowercase, separator-free key so the two naming schemes
   *  compare equal (`GetUser` and `get_user` both normalize to `getuser`). */
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
