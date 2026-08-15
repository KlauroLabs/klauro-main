import { BaseAnalyzer, AnalysisContext, FileAnalysisContext } from '../../core/base-analyzer';
import { CASNode, CASEdge, CASContribution, CASEntryPoint, CASExitPoint, FileAnalysisResult } from '../../../types/cas.types';
import * as path from 'path';
import * as fs from 'fs-extra';
import { cachedGlob as glob } from '../../core/glob-cache';

type StreamingMode = 'unary' | 'client' | 'server' | 'bidirectional';

interface GrpcMethod {
  name: string;
  streaming: StreamingMode;
  requestType?: string;
  responseType?: string;

  origin: 'grpc-js' | 'nestjs' | 'grpcio-registration' | 'grpcio-servicer';
  filePath: string;
}

interface GrpcService {
  name: string;
  packageName?: string;
  filePath: string;
  origin: GrpcMethod['origin'];
  methods: GrpcMethod[];
}



const GRPCIO_HANDLER_STREAM: Record<string, StreamingMode> = {
  unary_unary: 'unary',
  unary_stream: 'server',
  stream_unary: 'client',
  stream_stream: 'bidirectional',
};












export class GrpcHandlerAnalyzer extends BaseAnalyzer {
  constructor() {
    super('grpc-handler', 'gRPC Handler Analyzer', '1.0.0', 'library');
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    try {
      const packageJsonPath = path.join(projectPath, 'package.json');
      if (await fs.pathExists(packageJsonPath)) {
        const packageJson = await fs.readJson(packageJsonPath);
        const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };
        if (Object.keys(deps).some(d => d === '@grpc/grpc-js' || d === 'grpc' || d === 'nice-grpc' || d === '@nestjs/microservices')) {
          return true;
        }
      }



      for (const manifest of ['requirements.txt', 'pyproject.toml', 'Pipfile']) {
        const mp = path.join(projectPath, manifest);
        if (await fs.pathExists(mp) && /\bgrpcio\b/.test(await fs.readFile(mp, 'utf-8'))) return true;
      }
      const stubs = await glob(['**/*_pb2_grpc.py'], {
        cwd: projectPath,
        ignore: this.getIgnorePatterns({ projectPath }),
        nodir: true
      });
      if (stubs.length > 0) return true;


      const codeFiles = await glob(['**/*.{ts,js}'], {
        cwd: projectPath,
        ignore: [...this.getIgnorePatterns({ projectPath }), '**/*.test.*', '**/*.spec.*'],
        nodir: true
      });
      for (const file of codeFiles) {
        const content = await fs.readFile(path.join(projectPath, file), 'utf-8');
        if (/@grpc\/grpc-js/.test(content) || /\.addService\s*\(/.test(content) || /@GrpcMethod\b/.test(content)) return true;
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

    const services: GrpcService[] = [];


    const codeFiles = await glob(['**/*.{ts,tsx,js,jsx}'], {
      cwd: context.projectPath,
      ignore: [...this.getIgnorePatterns(context), '**/*.test.*', '**/*.spec.*'],
      nodir: true
    });
    for (const file of codeFiles) {
      const content = await fs.readFile(path.join(context.projectPath, file), 'utf-8');
      this.collectFromNode(file, content, services);
    }


    const pyFiles = await glob(['**/*.py'], {
      cwd: context.projectPath,
      ignore: [...this.getIgnorePatterns(context), '**/*_test.py', '**/test_*.py'],
      nodir: true
    });
    for (const file of pyFiles) {
      const content = await fs.readFile(path.join(context.projectPath, file), 'utf-8');
      this.collectFromPython(file, content, services);
    }

    this.emitServiceGraph(services, nodes, edges, entryPoints);

    return this.createContribution(nodes, edges, entryPoints, [], {
      api: 'gRPC',
      servicesFound: services.length,
      handlersFound: entryPoints.length
    });
  }

  supportsIncrementalAnalysis(): boolean {
    return true;
  }

  async getRelevantFiles(projectPath: string): Promise<string[]> {
    const relevant = new Set<string>();
    try {
      const stubs = await glob(['**/*_pb2_grpc.py'], {
        cwd: projectPath,
        ignore: this.getIgnorePatterns({ projectPath }),
        nodir: true
      });
      for (const f of stubs) relevant.add(f);

      const pyFiles = await glob(['**/*.py'], {
        cwd: projectPath,
        ignore: [...this.getIgnorePatterns({ projectPath }), '**/*_test.py', '**/test_*.py'],
        nodir: true
      });
      for (const file of pyFiles) {
        let content: string;
        try {
          content = await fs.readFile(path.join(projectPath, file), 'utf-8');
        } catch {
          continue;
        }
        if (/\bimport\s+grpc\b/.test(content) && /Servicer\b|_rpc_method_handler\b/.test(content)) {
          relevant.add(file);
        }
      }

      const codeFiles = await glob(['**/*.{ts,tsx,js,jsx}'], {
        cwd: projectPath,
        ignore: [...this.getIgnorePatterns({ projectPath }), '**/*.test.*', '**/*.spec.*'],
        nodir: true
      });
      for (const file of codeFiles) {
        let content: string;
        try {
          content = await fs.readFile(path.join(projectPath, file), 'utf-8');
        } catch {
          continue;
        }
        if (/\.addService\s*\(/.test(content) || /@GrpcMethod\b/.test(content) || /@GrpcStreamMethod\b/.test(content)) {
          relevant.add(file);
        }
      }
    } catch {
      return [];
    }
    return [...relevant].sort();
  }

  async analyzeFileSingle(context: FileAnalysisContext): Promise<FileAnalysisResult> {
    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const entryPoints: CASEntryPoint[] = [];
    const exitPoints: CASExitPoint[] = [];
    const content = await fs.readFile(context.filePath, 'utf-8');
    const stat = await fs.stat(context.filePath);

    const services: GrpcService[] = [];
    const ext = path.extname(context.relativePath).toLowerCase();
    if (ext === '.py') {
      this.collectFromPython(context.relativePath, content, services);
    } else {
      this.collectFromNode(context.relativePath, content, services);
    }



    this.emitServiceGraph(services, nodes, edges, entryPoints);

    const exports = services.map(s => s.name);

    return this.createFileAnalysisResult(
      context.filePath,
      context.relativePath,
      context.contentHash || this.computeContentHash(content),
      stat.mtimeMs,
      nodes,
      edges,
      entryPoints,
      exitPoints,
      [],
      exports
    );
  }


  private collectFromNode(file: string, content: string, services: GrpcService[]): void {
    this.parseGrpcJsAddService(content, file, services);
    this.parseNestGrpcMethods(content, file, services);
  }


  private collectFromPython(file: string, content: string, services: GrpcService[]): void {
    if (!/\bgrpc\b/.test(content)) return;
    this.parseGrpcioRegistration(content, file, services);
    this.parseGrpcioServicerSubclass(content, file, services);
  }






  private parseGrpcJsAddService(content: string, filePath: string, services: GrpcService[]): void {
    const re = /\.addService\s*\(\s*([\w.]+)\s*,\s*\{/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      const serviceRef = m[1];

      const cleaned = serviceRef.replace(/\.[Ss]ervice$/, '');
      const serviceName = cleaned.split('.').pop() || cleaned;
      const block = this.extractBraceBlock(content, content.indexOf('{', m.index));
      if (block === null) continue;




      const methods: GrpcMethod[] = [];
      for (const name of this.topLevelObjectKeys(block)) {
        if (methods.some(mm => mm.name === name)) continue;
        methods.push({ name, streaming: 'unary', origin: 'grpc-js', filePath });
      }
      if (methods.length === 0) continue;
      this.mergeService(services, { name: serviceName, filePath, origin: 'grpc-js', methods });
    }
  }







  private parseNestGrpcMethods(content: string, filePath: string, services: GrpcService[]): void {
    const re = /@(GrpcMethod|GrpcStreamMethod)\s*\(([^)]*)\)\s*(?:public\s+|private\s+|protected\s+|async\s+)*(\w+)\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      const streaming: StreamingMode = m[1] === 'GrpcStreamMethod' ? 'server' : 'unary';
      const args = m[2];
      const methodDecl = m[3];
      const argStrings = [...args.matchAll(/['"]([^'"]+)['"]/g)].map(a => a[1]);
      const serviceName = argStrings[0] || 'GrpcService';
      const rpcName = argStrings[1] || this.pascalCase(methodDecl);
      this.mergeService(services, {
        name: serviceName,
        filePath,
        origin: 'nestjs',
        methods: [{ name: rpcName, streaming, origin: 'nestjs', filePath }]
      });
    }
  }











  private parseGrpcioRegistration(content: string, filePath: string, services: GrpcService[]): void {
    const fnRe = /def\s+add_(\w+?)Servicer_to_server\s*\(/g;
    let f: RegExpExecArray | null;
    while ((f = fnRe.exec(content)) !== null) {
      const serviceName = f[1];


      const packageName = this.extractGrpcioServiceFullName(content, f.index, serviceName);
      const bodySlice = content.slice(f.index, this.nextTopLevelDef(content, f.index));

      const methods: GrpcMethod[] = [];
      const handlerRe = /['"](\w+)['"]\s*:\s*grpc\.(unary_unary|unary_stream|stream_unary|stream_stream)_rpc_method_handler\s*\(([\s\S]*?)\)/g;
      let h: RegExpExecArray | null;
      while ((h = handlerRe.exec(bodySlice)) !== null) {
        const name = h[1];
        const streaming = GRPCIO_HANDLER_STREAM[h[2]];
        const inner = h[3];
        const reqMatch = inner.match(/request_deserializer\s*=\s*([\w.]+?)\.FromString/);
        const respMatch = inner.match(/response_serializer\s*=\s*([\w.]+?)\.SerializeToString/);
        if (methods.some(mm => mm.name === name)) continue;
        methods.push({
          name,
          streaming,
          requestType: reqMatch ? this.baseTypeName(reqMatch[1]) : undefined,
          responseType: respMatch ? this.baseTypeName(respMatch[1]) : undefined,
          origin: 'grpcio-registration',
          filePath
        });
      }
      if (methods.length === 0) continue;
      this.mergeService(services, { name: serviceName, packageName, filePath, origin: 'grpcio-registration', methods });
    }
  }







  private parseGrpcioServicerSubclass(content: string, filePath: string, services: GrpcService[]): void {
    const classRe = /class\s+(\w+)\s*\(\s*([\w.]*Servicer)\s*\)\s*:/g;
    let c: RegExpExecArray | null;
    while ((c = classRe.exec(content)) !== null) {
      const baseName = c[2].split('.').pop()!;


      const serviceName = baseName.replace(/Servicer$/, '');
      if (!serviceName) continue;
      const bodySlice = content.slice(c.index, this.nextTopLevelClass(content, c.index));

      const methods: GrpcMethod[] = [];
      const methodRe = /\n\s+def\s+(\w+)\s*\(\s*self\s*,\s*request(?:_iterator)?\s*,\s*context\b/g;
      let mm: RegExpExecArray | null;
      while ((mm = methodRe.exec(bodySlice)) !== null) {
        const name = mm[1];
        if (name.startsWith('_')) continue;

        const streaming: StreamingMode = /request_iterator/.test(mm[0]) ? 'client' : 'unary';
        if (methods.some(x => x.name === name)) continue;
        methods.push({ name, streaming, origin: 'grpcio-servicer', filePath });
      }
      if (methods.length === 0) continue;
      this.mergeService(services, { name: serviceName, filePath, origin: 'grpcio-servicer', methods });
    }
  }


  private extractGrpcioServiceFullName(content: string, near: number, serviceName: string): string | undefined {
    const re = new RegExp(`SERVICE_NAME\\s*=\\s*['"]([\\w.]+\\.${serviceName})['"]`);
    const m = content.match(re);
    if (!m) return undefined;
    const full = m[1];
    const pkg = full.slice(0, full.length - serviceName.length - 1);
    return pkg || undefined;
  }

  private emitServiceGraph(
    services: GrpcService[],
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: CASEntryPoint[]
  ): void {



    const merged = new Map<string, GrpcService>();
    for (const svc of services) {
      const key = svc.name;
      const existing = merged.get(key);
      if (!existing) {
        merged.set(key, { ...svc, methods: [...svc.methods] });
        continue;
      }
      existing.packageName = existing.packageName ?? svc.packageName;
      for (const method of svc.methods) {
        const dup = existing.methods.find(x => x.name === method.name);


        if (!dup) {
          existing.methods.push(method);
        } else if (!dup.requestType && method.requestType) {
          Object.assign(dup, method);
        }
      }
    }

    for (const svc of merged.values()) {
      const serviceId = `grpc_service_${this.sanitizeId(svc.packageName ? `${svc.packageName}.${svc.name}` : svc.name)}`;
      nodes.push(this.createNode(
        serviceId,
        svc.name,
        'service',
        2,
        svc.filePath,
        undefined,
        undefined,
        {
          api: 'gRPC',
          source: 'grpc_service',
          protocol: 'grpc',
          package: svc.packageName,
          origin: svc.origin,
          methods: svc.methods.length,
          subcategories: ['service', 'grpc', 'api-contract', 'cross-repo-contract'],
          tags: ['grpc:service', 'api-contract']
        }
      ));

      for (const method of svc.methods) {
        const methodId = `grpc_method_${this.sanitizeId(svc.name)}_${this.sanitizeId(method.name)}`;
        nodes.push(this.createNode(
          methodId,
          method.name,
          'rpc',
          3,
          method.filePath,
          undefined,
          undefined,
          {
            api: 'gRPC',
            source: 'grpc_method',
            protocol: 'grpc',
            service: svc.name,
            package: svc.packageName,
            streaming: method.streaming,
            requestType: method.requestType,
            responseType: method.responseType,
            origin: method.origin,
            subcategories: ['rpc', 'grpc', 'api-contract', 'endpoint'],
            tags: ['grpc:method', `grpc:${method.streaming}`]
          }
        ));

        edges.push(this.createEdge(
          `grpc_exposes_${this.sanitizeId(svc.name)}_${this.sanitizeId(method.name)}`,
          serviceId,
          methodId,
          'exposes',
          'api',
          { attributes: { service: svc.name, method: method.name, streaming: method.streaming } }
        ));



        const fullPath = svc.packageName
          ? `/${svc.packageName}.${svc.name}/${method.name}`
          : `/${svc.name}/${method.name}`;
        entryPoints.push(this.createEntryPoint(
          `entry_${methodId}`,
          methodId,
          'rpc',
          method.name,
          `gRPC ${svc.name}.${method.name} (${method.streaming})`,
          { method: 'POST', path: fullPath, pattern: method.streaming },
          { authenticated: false, guards: [], authorized_roles: [] },
          {
            api: 'gRPC',
            protocol: 'grpc',
            service: svc.name,
            package: svc.packageName,
            method: method.name,
            streaming: method.streaming,
            requestType: method.requestType,
            responseType: method.responseType,
            origin: method.origin
          },
          { node_id: methodId, method_name: method.name, file: method.filePath }
        ));
        const ep = entryPoints[entryPoints.length - 1];
        if (method.requestType) {
          ep.input = { type: method.requestType, schema: method.requestType };
        }
        if (method.responseType) {
          ep.output = { type: method.responseType };
        }
      }
    }
  }


  private mergeService(services: GrpcService[], svc: GrpcService): void {
    const existing = services.find(s => s.name === svc.name && s.filePath === svc.filePath && s.origin === svc.origin);
    if (!existing) {
      services.push(svc);
      return;
    }
    for (const method of svc.methods) {
      if (!existing.methods.some(x => x.name === method.name)) existing.methods.push(method);
    }
  }






  private topLevelObjectKeys(block: string): string[] {
    const keys: string[] = [];
    let depth = 0;
    const re = /(\w+)\s*(:|\()|[{}()[\]]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(block)) !== null) {
      const token = m[0];
      if (m[1]) {


        if (depth === 0 && m[1] !== 'async' && m[1] !== 'function') keys.push(m[1]);

        if (m[2] === '(') depth++;
        continue;
      }
      if (token === '{' || token === '(' || token === '[') depth++;
      else if (token === '}' || token === ')' || token === ']') depth = Math.max(0, depth - 1);
    }
    return keys;
  }

  private extractBraceBlock(content: string, openIndex: number): string | null {
    if (content[openIndex] !== '{') return null;
    let depth = 0;
    for (let i = openIndex; i < content.length; i++) {
      const ch = content[i];
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) return content.slice(openIndex + 1, i);
      }
    }
    return null;
  }


  private nextTopLevelDef(content: string, from: number): number {
    const re = /\n(?:def |class |async def )/g;
    re.lastIndex = from + 1;
    const m = re.exec(content);
    return m ? m.index : content.length;
  }


  private nextTopLevelClass(content: string, from: number): number {
    const re = /\nclass /g;
    re.lastIndex = from + 1;
    const m = re.exec(content);
    return m ? m.index : content.length;
  }


  private baseTypeName(type: string): string {
    return type.split('.').pop() || type;
  }

  private pascalCase(name: string): string {
    return name.charAt(0).toUpperCase() + name.slice(1);
  }

  protected getCapabilities(): string[] {
    return ['grpc-services', 'grpc-handlers', 'grpc-streaming', 'grpc-contracts'];
  }

  protected getLevelName(level: number): string {
    switch (level) {
      case 1: return 'system';
      case 2: return 'architectural';
      case 3: return 'code';
      case 4: return 'member';
      case 5: return 'implementation';
      default: return 'unknown';
    }
  }
}
