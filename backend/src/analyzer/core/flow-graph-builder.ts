import {
  CASCapability,
  CASCapabilityDependency,
  CASFlowGraph,
  CASFlowLayer,
  SystemPurpose
} from '../../types/cas.types';

export class FlowGraphBuilder {
  buildFlowGraph(
    capabilities: CASCapability[],
    dependencies: CASCapabilityDependency[],
    systemPurpose?: SystemPurpose
  ): CASFlowGraph {
    if (capabilities.length === 0) {
      return this.buildEmptyFlowGraph();
    }

    const coreCapability = this.findCoreCapability(capabilities);

    const valueChain = this.traceValueChain(coreCapability, capabilities, dependencies);

    const topology = this.computeTopology(capabilities, dependencies);

    const layers = this.buildLayers(capabilities, dependencies);

    const systemInsights = this.detectSystemPatterns(capabilities);

    return {
      capabilities,
      dependencies,
      topology,
      primary_flow: {
        core_capability_id: coreCapability.id,
        value_chain: valueChain,
        supporting_capabilities: capabilities
          .filter(c => c.classification === 'supporting')
          .map(c => c.id),
        infrastructure_capabilities: capabilities
          .filter(c => c.classification === 'infrastructure')
          .map(c => c.id)
      },
      layers,
      system_insights: systemInsights
    };
  }

  private buildEmptyFlowGraph(): CASFlowGraph {
    return {
      capabilities: [],
      dependencies: [],
      topology: {
        root_capabilities: [],
        leaf_capabilities: [],
        critical_path: [],
        max_depth: 0
      },
      primary_flow: {
        core_capability_id: '',
        value_chain: [],
        supporting_capabilities: [],
        infrastructure_capabilities: []
      },
      layers: [],
      system_insights: {
        detected_patterns: [],
        primary_entry_type: 'unknown',
        data_flow_type: 'unknown'
      }
    };
  }

  private findCoreCapability(capabilities: CASCapability[]): CASCapability {
    const primaryCaps = capabilities.filter(c => c.classification === 'primary');

    if (primaryCaps.length === 0) {
      return capabilities.reduce((best, curr) =>
        curr.signals.total_score > best.signals.total_score ? curr : best
      );
    }

    return primaryCaps.reduce((best, curr) =>
      curr.signals.total_score > best.signals.total_score ? curr : best
    );
  }

  private traceValueChain(
    coreCapability: CASCapability,
    capabilities: CASCapability[],
    dependencies: CASCapabilityDependency[]
  ): string[] {
    const chain: string[] = [];
    const visited = new Set<string>();

    const incomingDeps = dependencies.filter(d =>
      d.to_capability === coreCapability.id &&
      (d.dependency_type === 'requires' || d.strength === 'required')
    );

    const traceBack = (capId: string, depth: number = 0): void => {
      if (visited.has(capId) || depth > 10) return;
      visited.add(capId);

      const incoming = dependencies.filter(d =>
        d.to_capability === capId &&
        (d.dependency_type === 'requires' || d.strength === 'required')
      );

      for (const dep of incoming) {
        traceBack(dep.from_capability, depth + 1);
      }

      chain.push(capId);
    };

    for (const dep of incomingDeps) {
      traceBack(dep.from_capability);
    }

    chain.push(coreCapability.id);

    return chain;
  }

  private computeTopology(
    capabilities: CASCapability[],
    dependencies: CASCapabilityDependency[]
  ): CASFlowGraph['topology'] {
    const hasIncoming = new Set<string>();
    const hasOutgoing = new Set<string>();

    for (const dep of dependencies) {
      hasIncoming.add(dep.to_capability);
      hasOutgoing.add(dep.from_capability);
    }

    const rootCapabilities = capabilities
      .filter(c => !hasIncoming.has(c.id) || c.classification === 'primary')
      .map(c => c.id);

    const leafCapabilities = capabilities
      .filter(c => !hasOutgoing.has(c.id))
      .map(c => c.id);

    const criticalPath = this.findCriticalPath(capabilities, dependencies);

    const maxDepth = this.computeMaxDepth(capabilities, dependencies);

    return {
      root_capabilities: rootCapabilities,
      leaf_capabilities: leafCapabilities,
      critical_path: criticalPath,
      max_depth: maxDepth
    };
  }

  private findCriticalPath(
    capabilities: CASCapability[],
    dependencies: CASCapabilityDependency[]
  ): string[] {
    const primaryCaps = capabilities.filter(c => c.classification === 'primary');
    if (primaryCaps.length === 0) return [];

    const criticalCap = primaryCaps.reduce((best, curr) =>
      curr.signals.total_score > best.signals.total_score ? curr : best
    );

    const path = [criticalCap.id];
    const visited = new Set<string>([criticalCap.id]);

    let currentId = criticalCap.id;
    while (true) {
      const outgoing = dependencies.filter(d =>
        d.from_capability === currentId && !visited.has(d.to_capability)
      );

      if (outgoing.length === 0) break;

      const requiredDep = outgoing.find(d =>
        d.strength === 'required' || d.dependency_type === 'requires'
      );

      const nextDep = requiredDep || outgoing[0];
      const nextCap = capabilities.find(c => c.id === nextDep.to_capability);

      if (!nextCap) break;

      path.push(nextCap.id);
      visited.add(nextCap.id);
      currentId = nextCap.id;
    }

    return path;
  }

  private computeMaxDepth(
    capabilities: CASCapability[],
    dependencies: CASCapabilityDependency[]
  ): number {
    const depths = new Map<string, number>();

    const hasIncoming = new Set<string>();
    for (const dep of dependencies) {
      hasIncoming.add(dep.to_capability);
    }

    const roots = capabilities.filter(c => !hasIncoming.has(c.id));
    for (const root of roots) {
      depths.set(root.id, 0);
    }

    let changed = true;
    let iterations = 0;
    const maxIterations = capabilities.length * 2;

    while (changed && iterations < maxIterations) {
      changed = false;
      iterations++;

      for (const dep of dependencies) {
        const fromDepth = depths.get(dep.from_capability);
        if (fromDepth === undefined) continue;

        const currentToDepth = depths.get(dep.to_capability) ?? -1;
        const newToDepth = fromDepth + 1;

        if (newToDepth > currentToDepth) {
          depths.set(dep.to_capability, newToDepth);
          changed = true;
        }
      }
    }

    if (depths.size === 0) return 0;
    return Math.max(...Array.from(depths.values()));
  }

  private buildLayers(
    capabilities: CASCapability[],
    dependencies: CASCapabilityDependency[]
  ): CASFlowLayer[] {
    const layers: CASFlowLayer[] = [];

    const entryLayer = capabilities.filter(cap =>
      cap.entry_point_summary.types.some(t =>
        ['http', 'cli', 'route', 'page', 'websocket', 'event', 'schedule'].includes(t)
      ) && cap.operations.length > 0
    );

    if (entryLayer.length > 0) {
      layers.push({
        layer_number: 0,
        layer_name: 'Entry',
        capabilities: entryLayer.map(c => c.id),
        layer_type: 'entry'
      });
    }

    const businessLayer = capabilities.filter(cap =>
      cap.classification === 'primary' ||
      (cap.classification === 'supporting' && cap.operation_patterns.some(p =>
        ['command', 'transform', 'pipeline'].includes(p)
      ))
    );

    if (businessLayer.length > 0) {
      layers.push({
        layer_number: 1,
        layer_name: 'Business Logic',
        capabilities: businessLayer.map(c => c.id),
        layer_type: 'business'
      });
    }

    const dataLayer = capabilities.filter(cap =>
      cap.complexity_profile.has_database_calls ||
      cap.operation_patterns.includes('crud') ||
      cap.operation_patterns.includes('query')
    );

    if (dataLayer.length > 0) {
      layers.push({
        layer_number: 2,
        layer_name: 'Data Access',
        capabilities: dataLayer.map(c => c.id),
        layer_type: 'data'
      });
    }

    const infraLayer = capabilities.filter(cap =>
      cap.classification === 'infrastructure'
    );

    if (infraLayer.length > 0) {
      layers.push({
        layer_number: 3,
        layer_name: 'Infrastructure',
        capabilities: infraLayer.map(c => c.id),
        layer_type: 'infrastructure'
      });
    }

    return layers;
  }

  private detectSystemPatterns(capabilities: CASCapability[]): CASFlowGraph['system_insights'] {
    const entryTypes = new Set<string>();
    let hasCrud = false;
    let hasEvents = false;
    let hasPipeline = false;
    let hasTransform = false;
    let hasQuery = false;

    for (const cap of capabilities) {
      cap.entry_point_summary.types.forEach(t => entryTypes.add(t));

      const patterns = cap.operation_patterns || [];
      if (patterns.includes('crud')) hasCrud = true;
      if (patterns.includes('event')) hasEvents = true;
      if (patterns.includes('pipeline')) hasPipeline = true;
      if (patterns.includes('transform')) hasTransform = true;
      if (patterns.includes('query')) hasQuery = true;
    }

    const detectedPatterns: string[] = [];

    if (hasCrud && entryTypes.has('http')) {
      detectedPatterns.push('crud-api');
    }
    if (entryTypes.has('cli')) {
      detectedPatterns.push('cli-tool');
    }
    if (entryTypes.has('route') || entryTypes.has('page')) {
      detectedPatterns.push('spa');
    }
    if (hasEvents) {
      detectedPatterns.push('event-driven');
    }
    if (hasPipeline || hasTransform) {
      detectedPatterns.push('data-pipeline');
    }
    if (hasQuery && !hasCrud) {
      detectedPatterns.push('read-only-api');
    }
    if (entryTypes.has('websocket')) {
      detectedPatterns.push('realtime');
    }
    if (entryTypes.has('schedule')) {
      detectedPatterns.push('scheduled-jobs');
    }
    if (entryTypes.has('message') || entryTypes.has('event')) {
      detectedPatterns.push('message-consumer');
    }

    const typePriority = ['http', 'cli', 'route', 'page', 'websocket', 'event', 'schedule', 'message'];
    let primaryEntryType = 'unknown';
    for (const t of typePriority) {
      if (entryTypes.has(t)) {
        primaryEntryType = t;
        break;
      }
    }

    let dataFlowType = 'stateless';
    if (hasCrud) {
      dataFlowType = 'entity-centric';
    } else if (hasEvents) {
      dataFlowType = 'event-driven';
    } else if (hasPipeline) {
      dataFlowType = 'pipeline';
    } else if (hasTransform) {
      dataFlowType = 'transform';
    }

    return {
      detected_patterns: detectedPatterns,
      primary_entry_type: primaryEntryType,
      data_flow_type: dataFlowType
    };
  }

  getPrimaryFlowSummary(flowGraph: CASFlowGraph): string {
    const coreCapId = flowGraph.primary_flow.core_capability_id;
    const coreCap = flowGraph.capabilities.find(c => c.id === coreCapId);

    if (!coreCap) {
      return 'No primary flow detected';
    }

    const valueChainNames = flowGraph.primary_flow.value_chain
      .map(id => flowGraph.capabilities.find(c => c.id === id)?.name || id)
      .join(' -> ');

    return `Core: ${coreCap.name} | Value Chain: ${valueChainNames}`;
  }
}
