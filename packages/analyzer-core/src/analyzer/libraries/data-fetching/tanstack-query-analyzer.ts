import { BaseAnalyzer, AnalysisContext } from '../../core/base-analyzer';
import { CASNode, CASEdge, CASContribution, CASExitPoint } from '../../../types/cas.types';
import * as path from 'path';
import * as fs from 'fs-extra';
import { cachedGlob as glob } from '../../core/glob-cache';

const USE_QUERY = /(?:export\s+)?(?:const|let)\s+(\w+)\s*=\s*(?:useQuery|useSuspenseQuery)\s*(?:<[^>]*>)?\s*\(\s*\{/g;
const USE_INFINITE_QUERY = /(?:export\s+)?(?:const|let)\s+(\w+)\s*=\s*useInfiniteQuery\s*(?:<[^>]*>)?\s*\(\s*\{/g;
const USE_MUTATION = /(?:export\s+)?(?:const|let)\s+(\w+)\s*=\s*useMutation\s*(?:<[^>]*>)?\s*\(\s*\{/g;
const QUERY_KEY = /queryKey\s*:\s*\[([^\]]+)\]/;
const QUERY_FN_FETCH = /queryFn\s*:\s*(?:async\s*)?\([^)]*\)\s*=>\s*(?:\{[\s\S]*?)?(?:fetch|axios|api|http)\s*(?:\.|\.?\()\s*[`'"](\/[^`'"]*)[`'"]/;
const STALE_TIME = /staleTime\s*:\s*(\d+(?:\s*\*\s*\d+)*)/;
const GC_TIME = /(?:gcTime|cacheTime)\s*:\s*(\d+(?:\s*\*\s*\d+)*)/;
const RETRY = /retry\s*:\s*(\w+|\d+)/;
const REFETCH_ON_WINDOW = /refetchOnWindowFocus\s*:\s*(\w+)/;
const INVALIDATE_QUERIES = /invalidateQueries\s*\(\s*(?:\{[^}]*queryKey\s*:\s*\[([^\]]+)\]|(?:\[([^\]]+)\]))/g;
const MUTATION_FN_FETCH = /mutationFn\s*:\s*(?:async\s*)?\([^)]*\)\s*=>\s*(?:\{[\s\S]*?)?(?:fetch|axios|api|http)\s*(?:\.|\.?\()\s*[`'"](\/[^`'"]*)[`'"]/;
const MUTATION_FN_METHOD = /mutationFn\s*:[\s\S]*?(?:method|\.)(post|put|patch|delete)/i;

export class TanStackQueryAnalyzer extends BaseAnalyzer {
  constructor() {
    super('tanstack-query', 'TanStack Query Analyzer', '1.0.0', 'library');
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    try {
      const packageJsonPath = path.join(projectPath, 'package.json');
      if (!await fs.pathExists(packageJsonPath)) return false;

      const packageJson = await fs.readJson(packageJsonPath);
      const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };
      return '@tanstack/react-query' in deps || 'react-query' in deps ||
             '@tanstack/vue-query' in deps || '@tanstack/svelte-query' in deps;
    } catch {
      return false;
    }
  }

  async analyze(context: AnalysisContext): Promise<CASContribution> {
    const { projectPath } = context;
    const ignorePatterns = this.getIgnorePatterns(context);

    const sourceFiles = await glob('**/*.{ts,tsx,js,jsx}', {
      cwd: projectPath,
      ignore: [...ignorePatterns, '**/*.test.*', '**/*.spec.*'],
      absolute: false,
      nodir: true
    });

    const nodes: CASNode[] = [];
    const edges: CASEdge[] = [];
    const exitPoints: CASExitPoint[] = [];
    const seenNodeIds = new Set<string>();

    for (const relativePath of sourceFiles) {
      const absolutePath = path.join(projectPath, relativePath);
      const content = await fs.readFile(absolutePath, 'utf-8');

      if (!this.hasTanStackUsage(content)) continue;

      const fileNodeId = this.findFileNodeId(relativePath, context.existingAnalysis);
      const sanitizedPath = relativePath.replace(/[^a-zA-Z0-9]/g, '_');

      this.extractQueries(content, relativePath, sanitizedPath, fileNodeId, nodes, edges, exitPoints, seenNodeIds);
      this.extractInfiniteQueries(content, relativePath, sanitizedPath, fileNodeId, nodes, edges, exitPoints, seenNodeIds);
      this.extractMutations(content, relativePath, sanitizedPath, fileNodeId, nodes, edges, exitPoints, seenNodeIds);
      this.extractInvalidations(content, sanitizedPath, edges, nodes);
    }

    return this.createContribution(nodes, edges, [], exitPoints, {
      library: 'tanstack-query',
      queriesFound: nodes.filter(n => n.type === 'tanstack_query').length,
      mutationsFound: nodes.filter(n => n.type === 'tanstack_mutation').length,
      infiniteQueriesFound: nodes.filter(n => n.type === 'tanstack_infinite_query').length
    });
  }

  private hasTanStackUsage(content: string): boolean {
    return content.includes('useQuery') || content.includes('useMutation') ||
           content.includes('useInfiniteQuery') || content.includes('useSuspenseQuery') ||
           content.includes('prefetchQuery') || content.includes('invalidateQueries');
  }

  private extractQueries(
    content: string, relativePath: string, sanitizedPath: string,
    fileNodeId: string | undefined, nodes: CASNode[], edges: CASEdge[],
    exitPoints: CASExitPoint[], seenNodeIds: Set<string>
  ): void {
    USE_QUERY.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = USE_QUERY.exec(content)) !== null) {
      const varName = match[1];
      const nodeId = `query_tanstack_${sanitizedPath}_${varName}`;
      if (seenNodeIds.has(nodeId)) continue;
      seenNodeIds.add(nodeId);

      const queryBody = content.substring(match.index, Math.min(content.length, match.index + 1500));
      const queryConfig = this.extractQueryConfig(queryBody);

      nodes.push(this.createNode(
        nodeId, varName, 'tanstack_query', 4, relativePath, undefined, undefined,
        {
          library: 'tanstack-query',
          query_key: queryConfig.queryKey,
          endpoint: queryConfig.endpoint,
          stale_time: queryConfig.staleTime,
          gc_time: queryConfig.gcTime,
          retry: queryConfig.retry,
          refetch_on_window_focus: queryConfig.refetchOnWindowFocus,
          cache_behavior: queryConfig.staleTime ? 'stale-while-revalidate' : 'default'
        }
      ));

      if (fileNodeId) {
        edges.push(this.createEdge(
          `edge_${nodeId}_${fileNodeId}`, nodeId, fileNodeId, 'defined_in', 'structural'
        ));
      }

      if (queryConfig.endpoint) {
        exitPoints.push(this.createExitPoint(
          `exit_query_${sanitizedPath}_${varName}`,
          fileNodeId || nodeId, 'api', `Query: ${varName}`,
          undefined, { endpoint: queryConfig.endpoint, service_id: 'tanstack-query' },
          { method: 'GET', async: true },
          { framework: 'tanstack-query', query_key: queryConfig.queryKey, sourceFile: relativePath }
        ));
      }
    }
  }

  private extractInfiniteQueries(
    content: string, relativePath: string, sanitizedPath: string,
    fileNodeId: string | undefined, nodes: CASNode[], edges: CASEdge[],
    exitPoints: CASExitPoint[], seenNodeIds: Set<string>
  ): void {
    USE_INFINITE_QUERY.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = USE_INFINITE_QUERY.exec(content)) !== null) {
      const varName = match[1];
      const nodeId = `query_infinite_${sanitizedPath}_${varName}`;
      if (seenNodeIds.has(nodeId)) continue;
      seenNodeIds.add(nodeId);

      const queryBody = content.substring(match.index, Math.min(content.length, match.index + 1500));
      const queryConfig = this.extractQueryConfig(queryBody);

      nodes.push(this.createNode(
        nodeId, varName, 'tanstack_infinite_query', 4, relativePath, undefined, undefined,
        {
          library: 'tanstack-query',
          query_key: queryConfig.queryKey,
          endpoint: queryConfig.endpoint,
          pagination: true,
          stale_time: queryConfig.staleTime,
          gc_time: queryConfig.gcTime,
          cache_behavior: 'infinite-scroll'
        }
      ));

      if (fileNodeId) {
        edges.push(this.createEdge(
          `edge_${nodeId}_${fileNodeId}`, nodeId, fileNodeId, 'defined_in', 'structural'
        ));
      }

      if (queryConfig.endpoint) {
        exitPoints.push(this.createExitPoint(
          `exit_infinite_${sanitizedPath}_${varName}`,
          fileNodeId || nodeId, 'api', `Infinite Query: ${varName}`,
          undefined, { endpoint: queryConfig.endpoint, service_id: 'tanstack-query' },
          { method: 'GET', async: true },
          { framework: 'tanstack-query', query_key: queryConfig.queryKey, pagination: true, sourceFile: relativePath }
        ));
      }
    }
  }

  private extractMutations(
    content: string, relativePath: string, sanitizedPath: string,
    fileNodeId: string | undefined, nodes: CASNode[], edges: CASEdge[],
    exitPoints: CASExitPoint[], seenNodeIds: Set<string>
  ): void {
    USE_MUTATION.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = USE_MUTATION.exec(content)) !== null) {
      const varName = match[1];
      const nodeId = `mutation_tanstack_${sanitizedPath}_${varName}`;
      if (seenNodeIds.has(nodeId)) continue;
      seenNodeIds.add(nodeId);

      const mutationBody = content.substring(match.index, Math.min(content.length, match.index + 1500));

      const endpointMatch = MUTATION_FN_FETCH.exec(mutationBody);
      const methodMatch = MUTATION_FN_METHOD.exec(mutationBody);
      const method = methodMatch ? methodMatch[1].toUpperCase() : 'POST';

      const invalidationKeys: string[] = [];
      INVALIDATE_QUERIES.lastIndex = 0;
      let invMatch;
      while ((invMatch = INVALIDATE_QUERIES.exec(mutationBody)) !== null) {
        const keyContent = invMatch[1] || invMatch[2];
        if (keyContent) {
          invalidationKeys.push(keyContent.replace(/['"]/g, '').trim());
        }
      }

      nodes.push(this.createNode(
        nodeId, varName, 'tanstack_mutation', 4, relativePath, undefined, undefined,
        {
          library: 'tanstack-query',
          endpoint: endpointMatch?.[1],
          method,
          invalidates: invalidationKeys.length > 0 ? invalidationKeys : undefined
        }
      ));

      if (fileNodeId) {
        edges.push(this.createEdge(
          `edge_${nodeId}_${fileNodeId}`, nodeId, fileNodeId, 'defined_in', 'structural'
        ));
      }

      exitPoints.push(this.createExitPoint(
        `exit_mutation_${sanitizedPath}_${varName}`,
        fileNodeId || nodeId, 'api', `Mutation: ${varName}`,
        undefined, { endpoint: endpointMatch?.[1] || 'unknown', service_id: 'tanstack-query' },
        { method, async: true },
        { framework: 'tanstack-query', sourceFile: relativePath }
      ));
    }
  }

  private extractInvalidations(
    content: string, sanitizedPath: string, edges: CASEdge[], nodes: CASNode[]
  ): void {
    const mutationNodes = nodes.filter(n => n.type === 'tanstack_mutation');
    const queryNodes = nodes.filter(n =>
      n.type === 'tanstack_query' || n.type === 'tanstack_infinite_query'
    );

    for (const mutation of mutationNodes) {
      const meta = mutation.metadata as Record<string, any> | undefined;
      const invalidationKeys = meta?.invalidates as string[] | undefined;
      if (!invalidationKeys) continue;

      for (const invKey of invalidationKeys) {
        for (const query of queryNodes) {
          const qMeta = query.metadata as Record<string, any> | undefined;
          const queryKey = qMeta?.query_key as string | undefined;
          if (queryKey && invKey.includes(queryKey.split(',')[0]?.trim().replace(/['"]/g, ''))) {
            edges.push(this.createEdge(
              `edge_invalidation_${mutation.id}_${query.id}`,
              mutation.id, query.id, 'invalidates', 'behavioral',
              { invalidation_key: invKey }
            ));
          }
        }
      }
    }
  }

  private extractQueryConfig(body: string): {
    queryKey?: string;
    endpoint?: string;
    staleTime?: string;
    gcTime?: string;
    retry?: string;
    refetchOnWindowFocus?: string;
  } {
    const config: Record<string, string | undefined> = {};

    const keyMatch = QUERY_KEY.exec(body);
    if (keyMatch) {
      config.queryKey = keyMatch[1].replace(/['"]/g, '').trim();
    }

    const fetchMatch = QUERY_FN_FETCH.exec(body);
    if (fetchMatch) {
      config.endpoint = fetchMatch[1];
    }

    const staleMatch = STALE_TIME.exec(body);
    if (staleMatch) {
      config.staleTime = staleMatch[1];
    }

    const gcMatch = GC_TIME.exec(body);
    if (gcMatch) {
      config.gcTime = gcMatch[1];
    }

    const retryMatch = RETRY.exec(body);
    if (retryMatch) {
      config.retry = retryMatch[1];
    }

    const refetchMatch = REFETCH_ON_WINDOW.exec(body);
    if (refetchMatch) {
      config.refetchOnWindowFocus = refetchMatch[1];
    }

    return config;
  }

  private findFileNodeId(relativePath: string, existingAnalysis?: CASContribution[]): string | undefined {
    const fileId = `file_${relativePath.replace(/[^a-zA-Z0-9]/g, '_')}`;
    if (!existingAnalysis) return undefined;
    for (const contribution of existingAnalysis) {
      const found = contribution.nodes?.find(n => n.id === fileId);
      if (found) return found.id;
    }
    return undefined;
  }

  protected getCapabilities(): string[] {
    return ['query-detection', 'mutation-detection', 'cache-analysis', 'invalidation-mapping', 'infinite-query-detection'];
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
