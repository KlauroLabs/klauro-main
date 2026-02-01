import {
  CASCallChain,
  CASNode,
  CASCapability
} from '../../types/cas.types';

export interface CapabilityComplexityProfile {
  avg_depth: number;
  max_depth: number;
  has_external_calls: boolean;
  has_database_calls: boolean;
  has_async_calls: boolean;
  branching_factor: number;
  exit_types: string[];
  operation_patterns: string[];
}

export class CallChainAnalyzer {
  analyzeCapabilityChains(
    capability: CASCapability,
    callChains: CASCallChain[],
    nodes: CASNode[]
  ): CASCapability['complexity_profile'] {
    const chains = callChains.filter(c =>
      capability.entry_points.includes(c.entry_point?.entry_point_id || '')
    );

    if (chains.length === 0) {
      return {
        avg_depth: 0,
        max_depth: 0,
        has_external_calls: false,
        has_database_calls: false,
        has_async_calls: false,
        branching_factor: 1
      };
    }

    return {
      avg_depth: this.avgDepth(chains),
      max_depth: this.maxDepth(chains),
      has_external_calls: chains.some(c => c.characteristics?.has_external_calls),
      has_database_calls: chains.some(c => c.characteristics?.has_database_calls),
      has_async_calls: chains.some(c => c.characteristics?.has_async_calls),
      branching_factor: this.computeBranchingFactor(chains)
    };
  }

  analyzeExtendedProfile(
    capability: CASCapability,
    callChains: CASCallChain[],
    nodes: CASNode[]
  ): CapabilityComplexityProfile {
    const chains = callChains.filter(c =>
      capability.entry_points.includes(c.entry_point?.entry_point_id || '')
    );

    return {
      avg_depth: this.avgDepth(chains),
      max_depth: this.maxDepth(chains),
      has_external_calls: chains.some(c => c.characteristics?.has_external_calls),
      has_database_calls: chains.some(c => c.characteristics?.has_database_calls),
      has_async_calls: chains.some(c => c.characteristics?.has_async_calls),
      branching_factor: this.computeBranchingFactor(chains),
      exit_types: this.collectExitTypes(chains),
      operation_patterns: this.detectOperationPatterns(chains, nodes)
    };
  }

  private avgDepth(chains: CASCallChain[]): number {
    if (chains.length === 0) return 0;
    const total = chains.reduce((sum, c) => sum + (c.characteristics?.max_depth || 0), 0);
    return Math.round((total / chains.length) * 10) / 10;
  }

  private maxDepth(chains: CASCallChain[]): number {
    if (chains.length === 0) return 0;
    return Math.max(...chains.map(c => c.characteristics?.max_depth || 0));
  }

  private computeBranchingFactor(chains: CASCallChain[]): number {
    if (chains.length === 0) return 1;

    const branchingFactors = chains.map(chain => {
      const depth = chain.characteristics?.max_depth || 1;
      const calls = chain.characteristics?.total_calls || 1;
      return depth > 1 ? calls / depth : 1;
    });

    const avg = branchingFactors.reduce((sum, bf) => sum + bf, 0) / branchingFactors.length;
    return Math.round(avg * 10) / 10;
  }

  private collectExitTypes(chains: CASCallChain[]): string[] {
    const types = new Set<string>();

    for (const chain of chains) {
      if (chain.characteristics?.has_database_calls) {
        types.add('database');
      }
      if (chain.characteristics?.has_external_calls) {
        types.add('external');
      }
      if (chain.exit_point?.method_name) {
        const methodLower = chain.exit_point.method_name.toLowerCase();
        if (methodLower.includes('http') || methodLower.includes('fetch') || methodLower.includes('request')) {
          types.add('http');
        }
        if (methodLower.includes('queue') || methodLower.includes('publish') || methodLower.includes('emit')) {
          types.add('message');
        }
        if (methodLower.includes('cache') || methodLower.includes('redis')) {
          types.add('cache');
        }
        if (methodLower.includes('file') || methodLower.includes('write') || methodLower.includes('save')) {
          types.add('file');
        }
      }
    }

    return Array.from(types);
  }

  private detectOperationPatterns(chains: CASCallChain[], nodes: CASNode[]): string[] {
    const patterns = new Set<string>();

    for (const chain of chains) {
      if (chain.characteristics?.has_database_calls) {
        patterns.add('data-access');
      }

      if (this.isTransformChain(chain, nodes)) {
        patterns.add('transform');
      }

      if (this.isQueryChain(chain)) {
        patterns.add('query');
      }

      if (this.isCommandChain(chain)) {
        patterns.add('command');
      }

      if (this.isEventChain(chain)) {
        patterns.add('event');
      }

      if (this.isPipelineChain(chain)) {
        patterns.add('pipeline');
      }
    }

    return Array.from(patterns);
  }

  private isTransformChain(chain: CASCallChain, nodes: CASNode[]): boolean {
    const hasInput = chain.entry_point !== undefined;
    const hasOutput = chain.exit_point !== undefined;
    const hasProcessing = (chain.characteristics?.max_depth || 0) > 2;

    if (!hasInput || !hasOutput || !hasProcessing) {
      return false;
    }

    const transformKeywords = ['transform', 'convert', 'map', 'process', 'parse', 'format'];
    for (const step of chain.call_path || []) {
      const methodLower = step.method_name.toLowerCase();
      if (transformKeywords.some(kw => methodLower.includes(kw))) {
        return true;
      }
    }

    return false;
  }

  private isQueryChain(chain: CASCallChain): boolean {
    const queryKeywords = ['find', 'get', 'list', 'search', 'query', 'fetch', 'read', 'load'];

    const entryMethod = chain.entry_point?.method_name.toLowerCase() || '';
    if (queryKeywords.some(kw => entryMethod.includes(kw))) {
      return true;
    }

    const hasDbCall = chain.characteristics?.has_database_calls;
    const isShallowDepth = (chain.characteristics?.max_depth || 0) <= 4;

    return hasDbCall && isShallowDepth;
  }

  private isCommandChain(chain: CASCallChain): boolean {
    const commandKeywords = ['create', 'update', 'delete', 'save', 'remove', 'execute', 'run', 'process'];

    const entryMethod = chain.entry_point?.method_name.toLowerCase() || '';
    if (commandKeywords.some(kw => entryMethod.includes(kw))) {
      return true;
    }

    const hasDbCall = chain.characteristics?.has_database_calls;
    const hasAsyncCall = chain.characteristics?.has_async_calls;

    return (hasDbCall || hasAsyncCall) &&
           !this.isQueryChain(chain);
  }

  private isEventChain(chain: CASCallChain): boolean {
    const eventKeywords = ['emit', 'publish', 'broadcast', 'notify', 'trigger', 'dispatch', 'send'];

    for (const step of chain.call_path || []) {
      const methodLower = step.method_name.toLowerCase();
      if (eventKeywords.some(kw => methodLower.includes(kw))) {
        return true;
      }
    }

    return false;
  }

  private isPipelineChain(chain: CASCallChain): boolean {
    const pipelineIndicators = [
      chain.characteristics?.has_database_calls,
      chain.characteristics?.has_external_calls,
      (chain.characteristics?.max_depth || 0) > 5
    ];

    const positiveIndicators = pipelineIndicators.filter(Boolean).length;
    return positiveIndicators >= 2;
  }

  identifyHotPaths(callChains: CASCallChain[]): string[] {
    return callChains
      .filter(chain => {
        const runtimeStats = chain.runtime_stats;
        if (!runtimeStats) return false;

        return runtimeStats.traffic_volume === 'very-high' ||
               runtimeStats.traffic_volume === 'high';
      })
      .map(chain => chain.id);
  }

  identifyCriticalPaths(callChains: CASCallChain[]): string[] {
    return callChains
      .filter(chain => {
        const criticality = chain.criticality;
        return criticality === 'critical' || criticality === 'high';
      })
      .map(chain => chain.id);
  }

  identifyDeadEnds(callChains: CASCallChain[]): string[] {
    return callChains
      .filter(chain => chain.chain_type === 'dead-end')
      .map(chain => chain.id);
  }

  computeChainComplexity(chain: CASCallChain): number {
    let score = 0;

    score += Math.min((chain.characteristics?.max_depth || 0) * 5, 25);

    if (chain.characteristics?.has_external_calls) score += 15;
    if (chain.characteristics?.has_database_calls) score += 10;
    if (chain.characteristics?.has_async_calls) score += 10;
    if (chain.characteristics?.is_circular) score += 20;
    if (chain.characteristics?.is_recursive) score += 15;

    const branchingFactor = (chain.characteristics?.total_calls || 1) /
                           Math.max(chain.characteristics?.max_depth || 1, 1);
    score += Math.min(branchingFactor * 5, 25);

    return Math.min(100, score);
  }
}
