import { CASNode, CASEdge, CASEntryPoint, CASExitPoint, CASCallChain } from '../../types/cas.types';

export interface TracedPath {
  entryPointId: string;
  entryNodeId: string;
  steps: PathStep[];
  exitPoint?: CASExitPoint;
  exitNodeId?: string;
  maxDepth: number;
  hasExternalCalls: boolean;
  hasDatabaseCalls: boolean;
  hasAsyncCalls: boolean;
  isCircular: boolean;
  isRecursive: boolean;
  recursiveNodes: string[];
  complexity: number;
}

export interface PathStep {
  nodeId: string;
  nodeName: string;
  methodName: string;
  depth: number;
  edgeType: string;
  isAsync: boolean;
  isExternal: boolean;
  isDatabase: boolean;
  isExit: boolean;
}

export interface CycleInfo {
  nodeIds: string[];
  entryNode: string;
  cycleLength: number;
}

export interface SharedDependency {
  nodeId: string;
  nodeName: string;
  usedByNodes: string[];
  usageCount: number;
  criticality: 'critical' | 'high' | 'medium' | 'low';
}

export class CallGraphBuilder {
  private callerIndex: Map<string, Set<string>> = new Map();
  private calleeIndex: Map<string, Set<string>> = new Map();
  private nodeIndex: Map<string, CASNode> = new Map();
  private edgeIndex: Map<string, CASEdge[]> = new Map();
  private exitPointNodes: Set<string> = new Set();
  private exitPointIndex: Map<string, CASExitPoint> = new Map();

  constructor(
    nodes: CASNode[],
    edges: CASEdge[],
    exitPoints: CASExitPoint[] = []
  ) {
    for (const node of nodes) {
      this.nodeIndex.set(node.id, node);
    }

    for (const exitPoint of exitPoints) {
      this.exitPointNodes.add(exitPoint.source_node);
      this.exitPointIndex.set(exitPoint.source_node, exitPoint);
    }

    for (const edge of edges) {
      if (this.isCallEdge(edge)) {
        if (!this.callerIndex.has(edge.target)) {
          this.callerIndex.set(edge.target, new Set());
        }
        this.callerIndex.get(edge.target)!.add(edge.source);

        if (!this.calleeIndex.has(edge.source)) {
          this.calleeIndex.set(edge.source, new Set());
        }
        this.calleeIndex.get(edge.source)!.add(edge.target);
      }

      if (!this.edgeIndex.has(edge.source)) {
        this.edgeIndex.set(edge.source, []);
      }
      this.edgeIndex.get(edge.source)!.push(edge);
    }
  }

  private isCallEdge(edge: CASEdge): boolean {
    return edge.type === 'calls' ||
           edge.type === 'uses' ||
           edge.type === 'depends_on' ||
           edge.type === 'invokes' ||
           edge.type === 'delegates_to' ||
           edge.type === 'maps_to' ||
           edge.type === 'queries' ||
           edge.type === 'wraps';
  }

  getDirectCallers(nodeId: string): string[] {
    return Array.from(this.callerIndex.get(nodeId) || []);
  }

  getDirectCallees(nodeId: string): string[] {
    return Array.from(this.calleeIndex.get(nodeId) || []);
  }

  getTransitiveCallers(nodeId: string, maxDepth: number = 20): string[] {
    const visited = new Set<string>();
    const queue: Array<{ id: string; depth: number }> = [{ id: nodeId, depth: 0 }];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current.depth >= maxDepth) continue;

      const callers = this.callerIndex.get(current.id);
      if (!callers) continue;

      for (const callerId of callers) {
        if (!visited.has(callerId)) {
          visited.add(callerId);
          queue.push({ id: callerId, depth: current.depth + 1 });
        }
      }
    }

    return Array.from(visited);
  }

  getTransitiveCallees(nodeId: string, maxDepth: number = 20): string[] {
    const visited = new Set<string>();
    const queue: Array<{ id: string; depth: number }> = [{ id: nodeId, depth: 0 }];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current.depth >= maxDepth) continue;

      const callees = this.calleeIndex.get(current.id);
      if (!callees) continue;

      for (const calleeId of callees) {
        if (!visited.has(calleeId)) {
          visited.add(calleeId);
          queue.push({ id: calleeId, depth: current.depth + 1 });
        }
      }
    }

    return Array.from(visited);
  }

  tracePathsFromEntry(
    entryNodeId: string,
    entryPointId: string,
    maxDepth: number = 50,
    maxPaths: number = 100
  ): TracedPath[] {
    const paths: TracedPath[] = [];
    const visited = new Set<string>();
    const recursionStack = new Set<string>();
    const recursiveNodes: string[] = [];

    const buildPath = (
      nodeId: string,
      depth: number,
      currentPath: PathStep[]
    ): void => {
      if (depth > maxDepth) return;
      if (paths.length >= maxPaths) return;

      const node = this.nodeIndex.get(nodeId);
      if (!node) return;

      if (recursionStack.has(nodeId)) {
        recursiveNodes.push(nodeId);
        return;
      }

      recursionStack.add(nodeId);

      const isExit = this.exitPointNodes.has(nodeId);
      const isExternal = this.isExternalCall(node);
      const isDatabase = this.isDatabaseCall(node);
      const isAsync = node.metadata?.is_async || false;

      const step: PathStep = {
        nodeId,
        nodeName: node.name,
        methodName: node.name,
        depth,
        edgeType: currentPath.length > 0 ? 'calls' : 'entry',
        isAsync,
        isExternal,
        isDatabase,
        isExit
      };

      const newPath = [...currentPath, step];

      if (isExit || isExternal || isDatabase) {
        const tracedPath = this.createTracedPath(
          entryPointId,
          entryNodeId,
          newPath,
          recursiveNodes
        );
        paths.push(tracedPath);
      }

      if (!visited.has(nodeId)) {
        visited.add(nodeId);

        const callees = this.calleeIndex.get(nodeId);
        if (callees && callees.size > 0) {
          for (const calleeId of callees) {
            buildPath(calleeId, depth + 1, newPath);
          }
        } else if (!isExit && !isExternal && !isDatabase) {
          const tracedPath = this.createTracedPath(
            entryPointId,
            entryNodeId,
            newPath,
            recursiveNodes
          );
          paths.push(tracedPath);
        }

        visited.delete(nodeId);
      }

      recursionStack.delete(nodeId);
    };

    buildPath(entryNodeId, 0, []);

    if (paths.length === 0) {
      const node = this.nodeIndex.get(entryNodeId);
      if (node) {
        paths.push(this.createTracedPath(
          entryPointId,
          entryNodeId,
          [{
            nodeId: entryNodeId,
            nodeName: node.name,
            methodName: node.name,
            depth: 0,
            edgeType: 'entry',
            isAsync: node.metadata?.is_async || false,
            isExternal: false,
            isDatabase: false,
            isExit: false
          }],
          []
        ));
      }
    }

    return paths;
  }

  private createTracedPath(
    entryPointId: string,
    entryNodeId: string,
    steps: PathStep[],
    recursiveNodes: string[]
  ): TracedPath {
    const hasExternalCalls = steps.some(s => s.isExternal);
    const hasDatabaseCalls = steps.some(s => s.isDatabase);
    const hasAsyncCalls = steps.some(s => s.isAsync);
    const maxDepth = Math.max(...steps.map(s => s.depth), 0);
    const lastStep = steps[steps.length - 1];
    const exitPoint = lastStep?.isExit
      ? this.exitPointIndex.get(lastStep.nodeId)
      : undefined;

    const isCircular = new Set(steps.map(s => s.nodeId)).size < steps.length;
    const isRecursive = recursiveNodes.length > 0;

    const complexity = this.calculatePathComplexity(steps, {
      hasExternalCalls,
      hasDatabaseCalls,
      hasAsyncCalls,
      isCircular,
      isRecursive
    });

    return {
      entryPointId,
      entryNodeId,
      steps,
      exitPoint,
      exitNodeId: lastStep?.isExit ? lastStep.nodeId : undefined,
      maxDepth,
      hasExternalCalls,
      hasDatabaseCalls,
      hasAsyncCalls,
      isCircular,
      isRecursive,
      recursiveNodes,
      complexity
    };
  }

  private calculatePathComplexity(
    steps: PathStep[],
    characteristics: {
      hasExternalCalls: boolean;
      hasDatabaseCalls: boolean;
      hasAsyncCalls: boolean;
      isCircular: boolean;
      isRecursive: boolean;
    }
  ): number {
    let complexity = steps.length;

    if (characteristics.hasExternalCalls) complexity += 5;
    if (characteristics.hasDatabaseCalls) complexity += 3;
    if (characteristics.hasAsyncCalls) complexity += 2;
    if (characteristics.isCircular) complexity += 10;
    if (characteristics.isRecursive) complexity += 8;

    const uniqueNodes = new Set(steps.map(s => s.nodeId)).size;
    const branchingFactor = steps.length / Math.max(uniqueNodes, 1);
    complexity *= branchingFactor;

    return Math.round(complexity);
  }

  private isExternalCall(node: CASNode): boolean {
    const externalPatterns = [
      'http', 'fetch', 'axios', 'request',
      'external', 'api', 'client',
      'HttpService', 'RestClient', 'GraphQLClient'
    ];

    const name = node.name.toLowerCase();
    const qualifiedName = (node.qualified_name || '').toLowerCase();

    return externalPatterns.some(p =>
      name.includes(p) || qualifiedName.includes(p)
    ) || node.subcategories?.includes('external') === true;
  }

  private isDatabaseCall(node: CASNode): boolean {
    const dbPatterns = [
      'repository', 'repo', 'database', 'db',
      'query', 'find', 'save', 'delete', 'update', 'insert',
      'entity', 'orm', 'prisma', 'mikro', 'typeorm', 'sequelize',
      'mongoose', 'knex', 'sql'
    ];

    const name = node.name.toLowerCase();
    const qualifiedName = (node.qualified_name || '').toLowerCase();

    return dbPatterns.some(p =>
      name.includes(p) || qualifiedName.includes(p)
    ) ||
    node.type === 'repository' ||
    node.subcategories?.includes('database') === true ||
    node.subcategories?.includes('repository') === true;
  }

  detectCycles(): CycleInfo[] {
    const cycles: CycleInfo[] = [];
    const visited = new Set<string>();
    const recursionStack = new Set<string>();
    const path: string[] = [];

    const dfs = (nodeId: string): void => {
      visited.add(nodeId);
      recursionStack.add(nodeId);
      path.push(nodeId);

      const callees = this.calleeIndex.get(nodeId);
      if (callees) {
        for (const calleeId of callees) {
          if (!visited.has(calleeId)) {
            dfs(calleeId);
          } else if (recursionStack.has(calleeId)) {
            const cycleStart = path.indexOf(calleeId);
            const cycleNodes = path.slice(cycleStart);
            cycles.push({
              nodeIds: cycleNodes,
              entryNode: calleeId,
              cycleLength: cycleNodes.length
            });
          }
        }
      }

      path.pop();
      recursionStack.delete(nodeId);
    };

    for (const nodeId of this.nodeIndex.keys()) {
      if (!visited.has(nodeId)) {
        dfs(nodeId);
      }
    }

    return cycles;
  }

  computeNodeCentrality(): Map<string, number> {
    const centrality = new Map<string, number>();

    for (const nodeId of this.nodeIndex.keys()) {
      const inDegree = this.callerIndex.get(nodeId)?.size || 0;
      const outDegree = this.calleeIndex.get(nodeId)?.size || 0;
      const transitiveCallers = this.getTransitiveCallers(nodeId, 5).length;

      const score = (inDegree * 2) + outDegree + (transitiveCallers * 0.5);
      centrality.set(nodeId, score);
    }

    return centrality;
  }

  findSharedDependencies(nodeIds: string[]): SharedDependency[] {
    const dependencyUsage = new Map<string, Set<string>>();

    for (const nodeId of nodeIds) {
      const callees = this.getTransitiveCallees(nodeId, 10);

      for (const calleeId of callees) {
        if (!dependencyUsage.has(calleeId)) {
          dependencyUsage.set(calleeId, new Set());
        }
        dependencyUsage.get(calleeId)!.add(nodeId);
      }
    }

    const sharedDeps: SharedDependency[] = [];

    for (const [depId, users] of dependencyUsage) {
      if (users.size >= 2) {
        const node = this.nodeIndex.get(depId);
        const criticality = this.computeDependencyCriticality(depId, users.size);

        sharedDeps.push({
          nodeId: depId,
          nodeName: node?.name || depId,
          usedByNodes: Array.from(users),
          usageCount: users.size,
          criticality
        });
      }
    }

    return sharedDeps.sort((a, b) => b.usageCount - a.usageCount);
  }

  private computeDependencyCriticality(
    nodeId: string,
    usageCount: number
  ): 'critical' | 'high' | 'medium' | 'low' {
    const node = this.nodeIndex.get(nodeId);

    const hasSecurityContext = node?.security?.authentication_required ||
      node?.security?.authorization_roles?.length;

    if (usageCount >= 5 || hasSecurityContext) return 'critical';
    if (usageCount >= 3) return 'high';
    if (usageCount >= 2) return 'medium';
    return 'low';
  }

  getEntryPointsReachingNode(
    nodeId: string,
    entryPoints: CASEntryPoint[]
  ): CASEntryPoint[] {
    const transitiveCallers = new Set(this.getTransitiveCallers(nodeId, 30));
    transitiveCallers.add(nodeId);

    return entryPoints.filter(ep =>
      transitiveCallers.has(ep.source_node)
    );
  }

  getAffectedCallChains(
    nodeId: string,
    callChains: CASCallChain[]
  ): string[] {
    return callChains
      .filter(chain =>
        chain.call_path.some(step => step.node_id === nodeId)
      )
      .map(chain => chain.id);
  }

  getNode(nodeId: string): CASNode | undefined {
    return this.nodeIndex.get(nodeId);
  }

  getEdgesFrom(nodeId: string): CASEdge[] {
    return this.edgeIndex.get(nodeId) || [];
  }
}
