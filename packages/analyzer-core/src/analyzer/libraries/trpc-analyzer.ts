import { BaseAnalyzer, AnalysisContext, FileAnalysisContext } from '../core/base-analyzer';
import { CASNode, CASEdge, CASContribution, CASEntryPoint, CASExitPoint, FileAnalysisResult } from '../../types/cas.types';
import * as path from 'path';
import * as fs from 'fs-extra';
import { cachedGlob as glob } from '../core/glob-cache';

type ProcedureKind = 'query' | 'mutation' | 'subscription';

interface TRPCProcedure {
  name: string;
  kind: ProcedureKind;
  routerName: string;
  filePath: string;
  authGated: boolean;
  procedureBase: string;
  inputSchema?: string;
}

interface TRPCRouter {
  name: string;
  filePath: string;
  isAppRouter: boolean;
  childRouters: string[];
  procedures: TRPCProcedure[];
}









export class TRPCAnalyzer extends BaseAnalyzer {
  constructor() {
    super('trpc', 'tRPC API Contract Analyzer', '1.0.0', 'library');
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    try {
      const packageJsonPath = path.join(projectPath, 'package.json');
      if (await fs.pathExists(packageJsonPath)) {
        const packageJson = await fs.readJson(packageJsonPath);
        const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };
        if (Object.keys(deps).some(d => d === '@trpc/server' || d === '@trpc/client' || d.startsWith('@trpc/'))) {
          return true;
        }
      }

      const files = await glob(['**/*.{ts,tsx}'], {
        cwd: projectPath,
        ignore: [...this.getIgnorePatterns({ projectPath }), '**/*.test.*', '**/*.spec.*'],
        nodir: true
      });

      for (const file of files) {
        const content = await fs.readFile(path.join(projectPath, file), 'utf-8');
        if (/\binitTRPC\b/.test(content) || /\bcreateTRPCRouter\b/.test(content) ||
            /\bpublicProcedure\b/.test(content) || /\bprotectedProcedure\b/.test(content)) {
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

    const files = await glob(['**/*.{ts,tsx}'], {
      cwd: context.projectPath,
      ignore: [...this.getIgnorePatterns(context), '**/*.test.*', '**/*.spec.*'],
      nodir: true
    });

    const routers: TRPCRouter[] = [];

    for (const file of files) {
      const fullPath = path.join(context.projectPath, file);
      const content = await fs.readFile(fullPath, 'utf-8');
      if (!/createTRPCRouter|t\.router|router\s*\(|publicProcedure|protectedProcedure|t\.procedure/.test(content)) {
        continue;
      }
      routers.push(...this.parseRouters(content, file));
    }

    this.emitRouterGraph(routers, nodes, edges, entryPoints);

    return this.createContribution(nodes, edges, entryPoints, [], {
      api: 'tRPC',
      routersFound: routers.length,
      proceduresFound: entryPoints.length,
      appRouterFound: routers.some(r => r.isAppRouter)
    });
  }

  supportsIncrementalAnalysis(): boolean {
    return true;
  }

  async getRelevantFiles(projectPath: string): Promise<string[]> {
    let files: string[] = [];
    try {
      files = await glob(['**/*.{ts,tsx}'], {
        cwd: projectPath,
        ignore: [...this.getIgnorePatterns({ projectPath }), '**/*.test.*', '**/*.spec.*'],
        nodir: true
      });
    } catch {
      return [];
    }

    const relevant: string[] = [];
    for (const file of files) {
      let content: string;
      try {
        content = await fs.readFile(path.join(projectPath, file), 'utf-8');
      } catch {
        continue;
      }
      if (/createTRPCRouter|t\.router|router\s*\(|publicProcedure|protectedProcedure|t\.procedure/.test(content)) {
        relevant.push(file);
      }
    }
    return relevant.sort();
  }

  async analyzeFileSingle(context: FileAnalysisContext): Promise<FileAnalysisResult> {
    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const entryPoints: CASEntryPoint[] = [];
    const exitPoints: CASExitPoint[] = [];
    const content = await fs.readFile(context.filePath, 'utf-8');
    const stat = await fs.stat(context.filePath);

    let routers: TRPCRouter[] = [];
    if (/createTRPCRouter|t\.router|router\s*\(|publicProcedure|protectedProcedure|t\.procedure/.test(content)) {
      routers = this.parseRouters(content, context.relativePath);
    }



    this.emitRouterGraph(routers, nodes, edges, entryPoints);

    const exports = routers.map(r => r.name);

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

  private emitRouterGraph(
    routers: TRPCRouter[],
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: CASEntryPoint[]
  ): void {
    const routerIndex = new Map<string, TRPCRouter>();
    for (const r of routers) {
      if (!routerIndex.has(r.name)) routerIndex.set(r.name, r);
    }

    for (const router of routers) {
      const routerId = `trpc_router_${this.sanitizeId(router.name)}`;
      const isContractSurface = router.isAppRouter;

      nodes.push(this.createNode(
        routerId,
        router.name,
        'router',
        2,
        router.filePath,
        undefined,
        undefined,
        {
          api: 'tRPC',
          source: 'trpc_router',
          isAppRouter: router.isAppRouter,
          contractSurface: isContractSurface,
          procedures: router.procedures.length,
          subcategories: isContractSurface
            ? ['router', 'trpc', 'api-contract', 'cross-repo-contract']
            : ['router', 'trpc'],
          tags: isContractSurface ? ['trpc:app-router', 'api-contract'] : ['trpc:router']
        }
      ));


      for (const child of router.childRouters) {
        const childRef = routerIndex.get(child);
        const childId = `trpc_router_${this.sanitizeId(child)}`;
        if (childRef) {
          edges.push(this.createEdge(
            `trpc_compose_${this.sanitizeId(router.name)}_${this.sanitizeId(child)}`,
            routerId,
            childId,
            'composes',
            'api',
            { attributes: { kind: 'router-merge', parent: router.name, child } }
          ));
        }
      }

      for (const proc of router.procedures) {
        const procId = `trpc_procedure_${this.sanitizeId(router.name)}_${this.sanitizeId(proc.name)}`;

        nodes.push(this.createNode(
          procId,
          proc.name,
          'PROCEDURE',
          3,
          proc.filePath,
          undefined,
          undefined,
          {
            api: 'tRPC',
            source: 'trpc_procedure',
            kind: proc.kind,
            router: router.name,
            authGated: proc.authGated,
            procedureBase: proc.procedureBase,
            inputSchema: proc.inputSchema,
            inputContract: proc.inputSchema ? { schema: proc.inputSchema, validation: 'zod' } : undefined,
            subcategories: ['procedure', 'trpc', 'api-contract', 'endpoint'],
            tags: ['trpc:procedure', `trpc:${proc.kind}`, ...(proc.authGated ? ['auth-gated'] : [])]
          }
        ));

        edges.push(this.createEdge(
          `trpc_exposes_${this.sanitizeId(router.name)}_${this.sanitizeId(proc.name)}`,
          routerId,
          procId,
          'exposes',
          'api'
        ));


        entryPoints.push(this.createEntryPoint(
          `entry_${procId}`,
          procId,
          'route',
          proc.name,
          `tRPC ${proc.kind}: ${router.name}.${proc.name}`,
          { pattern: `${router.name}.${proc.name}`, method: proc.kind },
          {
            authenticated: proc.authGated,
            guards: proc.authGated ? [proc.procedureBase] : [],
            authorized_roles: []
          },
          {
            api: 'tRPC',
            kind: proc.kind,
            router: router.name,
            procedure: proc.name,
            inputSchema: proc.inputSchema,
            authGated: proc.authGated
          },
          { node_id: procId, method_name: proc.name, file: proc.filePath }
        ));


        if (proc.inputSchema) {
          const ep = entryPoints[entryPoints.length - 1];
          ep.input = { type: 'zod', schema: proc.inputSchema, validation: ['zod'] };
        }
      }
    }
  }






  private parseRouters(content: string, filePath: string): TRPCRouter[] {
    const routers: TRPCRouter[] = [];
    const declRegex = /(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(createTRPCRouter|t\.router|router)\s*\(\s*\{/g;

    let match: RegExpExecArray | null;
    while ((match = declRegex.exec(content)) !== null) {
      const routerName = match[1];
      const bodyStart = match.index + match[0].length - 1;
      const body = this.extractBraceBlock(content, bodyStart);
      if (body === null) continue;

      const isAppRouter = routerName === 'appRouter' ||
        /export\s+type\s+AppRouter\s*=\s*typeof\s+appRouter/.test(content) && routerName === 'appRouter';

      const childRouters = this.extractChildRouters(body);
      const procedures = this.extractProcedures(body, routerName, filePath);

      routers.push({ name: routerName, filePath, isAppRouter, childRouters, procedures });
    }

    return routers;
  }


  private extractChildRouters(body: string): string[] {
    const children: string[] = [];
    const childRegex = /(\w+)\s*:\s*(\w+)\s*(?:,|\n|$)/g;
    let m: RegExpExecArray | null;
    while ((m = childRegex.exec(body)) !== null) {
      const value = m[2];

      if (/router/i.test(value) || /Router$/.test(value)) {
        children.push(value);
      }
    }
    return children;
  }

  private extractProcedures(body: string, routerName: string, filePath: string): TRPCProcedure[] {
    const procedures: TRPCProcedure[] = [];

    const procRegex = /(\w+)\s*:\s*(publicProcedure|protectedProcedure|t\.procedure|\w*[pP]rocedure)\b/g;

    let m: RegExpExecArray | null;
    while ((m = procRegex.exec(body)) !== null) {
      const name = m[1];
      const procedureBase = m[2];

      const chain = this.sliceProcedureChain(body, m.index + m[0].length);
      const kindMatch = chain.match(/\.(query|mutation|subscription)\s*\(/);
      if (!kindMatch) continue;
      const kind = kindMatch[1] as ProcedureKind;

      const authGated = /protected/i.test(procedureBase) ||
        /\.use\s*\(/.test(chain) && /protected|auth/i.test(procedureBase);

      const inputSchema = this.extractInputSchema(chain);

      procedures.push({ name, kind, routerName, filePath, authGated, procedureBase, inputSchema });
    }

    return procedures;
  }


  private extractInputSchema(chain: string): string | undefined {
    const idx = chain.search(/\.input\s*\(/);
    if (idx === -1) return undefined;
    const parenStart = chain.indexOf('(', idx);
    const arg = this.extractParenBlock(chain, parenStart);
    if (arg === null) return undefined;
    return arg.trim().replace(/\s+/g, ' ').slice(0, 400);
  }


  private sliceProcedureChain(body: string, from: number): string {

    let depth = 0;
    let i = from;
    for (; i < body.length; i++) {
      const ch = body[i];
      if (ch === '(' || ch === '{' || ch === '[') depth++;
      else if (ch === ')' || ch === '}' || ch === ']') depth--;
      else if (ch === ',' && depth === 0) break;
      if (depth < 0) break;
    }
    return body.slice(from, i);
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

  private extractParenBlock(content: string, openIndex: number): string | null {
    if (content[openIndex] !== '(') return null;
    let depth = 0;
    for (let i = openIndex; i < content.length; i++) {
      const ch = content[i];
      if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth === 0) return content.slice(openIndex + 1, i);
      }
    }
    return null;
  }

  protected getCapabilities(): string[] {
    return ['trpc-routers', 'trpc-procedures', 'trpc-input-contracts', 'trpc-auth'];
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
