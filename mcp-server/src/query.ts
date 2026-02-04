import type {
  CASOutput, CASNode, CASEdge, CASEntryPoint, CASExitPoint,
  CASCallChain, CASMethodCall, CASDecorator, CASIntent,
  CASChangeRisk, CASTemporalStability, CASFlowCoverage,
} from '../../backend/src/types/cas.types';

export function buildSummary(cas: CASOutput) {
  const nodesByType: Record<string, number> = {};
  for (const n of cas.nodes) {
    nodesByType[n.type] = (nodesByType[n.type] || 0) + 1;
  }

  const edgesByType: Record<string, number> = {};
  for (const e of cas.edges) {
    edgesByType[e.type] = (edgesByType[e.type] || 0) + 1;
  }

  const entryPointsByType: Record<string, number> = {};
  for (const ep of cas.entry_points || []) {
    entryPointsByType[ep.type] = (entryPointsByType[ep.type] || 0) + 1;
  }

  const errorsBySeverity: Record<string, number> = {};
  for (const err of cas.analysis_errors || []) {
    errorsBySeverity[err.severity] = (errorsBySeverity[err.severity] || 0) + 1;
  }

  return {
    cas_version: cas.cas_version,
    analysis_timestamp: cas.analysis_timestamp,
    analysis_id: cas.analysis_id,
    system_purpose: cas.system_purpose || null,
    enhanced_system_purpose: cas.enhanced_system_purpose || null,
    architecture_summary: cas.architecture_summary || null,
    flow_graph: cas.flow_graph ? {
      capabilities_count: cas.flow_graph.capabilities.length,
      dependencies_count: cas.flow_graph.dependencies.length,
      primary_flow: cas.flow_graph.primary_flow,
      system_insights: cas.flow_graph.system_insights,
      layers: cas.flow_graph.layers?.map(l => ({
        layer_number: l.layer_number,
        layer_name: l.layer_name,
        layer_type: l.layer_type,
        capabilities_count: l.capabilities?.length || 0,
      })) || [],
      topology: {
        root_count: cas.flow_graph.topology?.root_capabilities?.length || 0,
        leaf_count: cas.flow_graph.topology?.leaf_capabilities?.length || 0,
        critical_path: cas.flow_graph.topology?.critical_path || [],
        max_depth: cas.flow_graph.topology?.max_depth || 0,
      },
      top_capabilities: [...cas.flow_graph.capabilities]
        .sort((a, b) => b.signals.total_score - a.signals.total_score)
        .slice(0, 15)
        .map(c => ({
          name: c.name,
          classification: c.classification,
          criticality: c.criticality,
          score: c.signals.total_score,
          operations: c.operations.map(o => o.name),
        })),
    } : null,
    database_entities: cas.database_schema?.entities.map(e => e.name) || [],
    entry_point_count: cas.entry_points?.length || 0,
    entry_points_by_type: entryPointsByType,
    node_counts: { total: cas.nodes.length, by_type: nodesByType },
    edge_counts: { total: cas.edges.length, by_type: edgesByType },
    analyzer_contributions: cas.analyzer_contributions.map(c => ({
      analyzer_id: c.analyzer_id,
      analyzer_name: c.analyzer_name,
      analyzer_type: c.analyzer_type || c.contribution_type,
      nodes_contributed: c.nodes_contributed || c.nodes_created || 0,
      edges_contributed: c.edges_contributed || c.edges_created || 0,
      execution_time_ms: c.execution_time_ms,
      analysis_scope: c.analysis_scope || null,
    })),
    analysis_errors: {
      total: cas.analysis_errors?.length || 0,
      by_severity: errorsBySeverity,
    },
  };
}

export function getSystemOverview(cas: CASOutput) {
  return {
    system: cas.system,
    architecture_summary: cas.architecture_summary,
    system_purpose: cas.system_purpose,
    enhanced_system_purpose: cas.enhanced_system_purpose,
    system_capabilities: cas.system_capabilities,
    progressive_levels: cas.progressive_levels,
    analyzer_contributions: cas.analyzer_contributions,
    analysis_errors: cas.analysis_errors,
    configuration: cas.configuration,
    runtime: cas.runtime,
    repository_links: cas.repository_links,
    disclosure: cas.disclosure,
    validation: cas.validation,
  };
}

function trimEdge(e: CASEdge) {
  return {
    id: e.id,
    source: e.source,
    target: e.target,
    type: e.type,
    metadata: e.metadata ? {
      weight: e.metadata.weight,
      confidence: e.metadata.confidence,
      async: e.metadata.async,
      conditional: e.metadata.conditional,
      attributes: e.metadata.attributes,
    } : undefined,
  };
}

function splitCamelCase(str: string): string[] {
  return str
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[-_./]/g, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

function matchesWordBoundary(name: string, queryWords: string[]): boolean {
  const nameWords = splitCamelCase(name);
  return queryWords.every(qw => nameWords.some(nw => nw.includes(qw)));
}

export function searchNodes(
  cas: CASOutput,
  query: string,
  opts: { type?: string; category?: string; level?: number; limit?: number } = {}
) {
  const limit = opts.limit || 25;
  const queryLower = query.toLowerCase();
  const queryWords = queryLower.split(/\s+/).filter(Boolean);
  const isMultiWord = queryWords.length > 1;

  let results = cas.nodes.filter(n => {
    const directMatch = n.name.toLowerCase().includes(queryLower) ||
      (n.qualified_name && n.qualified_name.toLowerCase().includes(queryLower)) ||
      (n.description && n.description.toLowerCase().includes(queryLower));
    const camelMatch = isMultiWord && (
      matchesWordBoundary(n.name, queryWords) ||
      (n.qualified_name && matchesWordBoundary(n.qualified_name, queryWords))
    );
    if (!directMatch && !camelMatch) return false;
    if (opts.type && n.type !== opts.type) return false;
    if (opts.category && n.category !== opts.category) return false;
    if (opts.level !== undefined && n.level !== opts.level) return false;
    return true;
  });

  const TYPE_PRIORITY: Record<string, number> = {
    class: 0, service: 0, controller: 0, module: 0, gateway: 0,
    function: 1, method: 1, custom_hook: 1, functional_component: 1, react_page: 1,
    entity: 2, repository: 2, guard: 2, middleware: 2, interceptor: 2, dto: 2,
    variable: 3, constant_util: 3, property: 3, function_util: 3,
    import: 4,
  };
  results.sort((a, b) => (TYPE_PRIORITY[a.type] ?? 3) - (TYPE_PRIORITY[b.type] ?? 3));

  return results.slice(0, limit).map(n => ({
    id: n.id,
    name: n.name,
    type: n.type,
    qualified_name: n.qualified_name,
    category: n.category,
    level: n.level,
    level_name: n.level_name,
    file: n.source?.file,
    line: n.source?.line,
    description: n.description,
    tags: n.tags,
  }));
}

export function getNode(cas: CASOutput, nodeId: string) {
  const node = cas.nodes.find(n => n.id === nodeId);
  if (!node) return null;

  const incomingEdges = cas.edges.filter(e => e.target === nodeId).map(trimEdge);
  const outgoingEdges = cas.edges.filter(e => e.source === nodeId).map(trimEdge);
  const relatedEntryPoints = (cas.entry_points || []).filter(ep =>
    ep.source_node === nodeId || ep.handler?.node_id === nodeId || ep.connected_nodes?.includes(nodeId)
  );
  const relatedExitPoints = (cas.exit_points || []).filter(ep =>
    ep.source_node === nodeId || ep.connected_nodes?.includes(nodeId)
  );
  const decorators = (cas.decorators || []).filter(d => d.target_node === nodeId);
  const intent = (cas.intents || []).find(i => i.node_id === nodeId);
  const changeRisk = (cas.change_risks || []).find(r => r.node_id === nodeId);
  const stability = (cas.temporal_stability || []).find(s => s.node_id === nodeId);

  const children = node.children
    ? cas.nodes.filter(n => node.children!.includes(n.id)).map(n => ({
        id: n.id, name: n.name, type: n.type, level: n.level,
      }))
    : [];

  return {
    ...node,
    incoming_edges: incomingEdges,
    outgoing_edges: outgoingEdges,
    entry_points: relatedEntryPoints,
    exit_points: relatedExitPoints,
    decorators,
    intent,
    change_risk: changeRisk,
    stability,
    resolved_children: children,
  };
}

export function getFileNodes(cas: CASOutput, filePath: string) {
  const normalizedPath = filePath.replace(/\\/g, '/');
  const fileNodes = cas.nodes.filter(n =>
    n.source?.file && n.source.file.replace(/\\/g, '/').endsWith(normalizedPath)
  );

  const nodeIds = new Set(fileNodes.map(n => n.id));
  const internalEdges = cas.edges.filter(e =>
    nodeIds.has(e.source) && nodeIds.has(e.target)
  ).map(trimEdge);

  return {
    nodes: fileNodes.map(n => ({
      id: n.id, name: n.name, type: n.type, category: n.category,
      level: n.level, line: n.source?.line, end_line: n.source?.end_line,
      description: n.description, parent: n.parent, children: n.children,
    })),
    edges: internalEdges,
  };
}

export function getEntryPoints(cas: CASOutput, type?: string) {
  let points = cas.entry_points || [];
  if (type) points = points.filter(ep => ep.type === type);
  return points;
}

export function getExitPoints(cas: CASOutput, type?: string) {
  let points = cas.exit_points || [];
  if (type) points = points.filter(ep => ep.type === type);
  return points;
}

export function getRouteTable(cas: CASOutput) {
  return cas.route_table || [];
}

export function getExternalServices(cas: CASOutput) {
  return cas.external_services || [];
}

export function getCallers(cas: CASOutput, nodeId: string, maxDepth: number = 2) {
  const visited = new Set<string>();
  const callers: Array<{ node_id: string; name: string; type: string; depth: number; via: string }> = [];

  function traverse(currentId: string, depth: number) {
    if (depth > maxDepth || visited.has(currentId)) return;
    visited.add(currentId);

    for (const edge of cas.edges) {
      if (edge.target === currentId && !visited.has(edge.source)) {
        const sourceNode = cas.nodes.find(n => n.id === edge.source);
        if (sourceNode) {
          callers.push({
            node_id: sourceNode.id,
            name: sourceNode.name,
            type: sourceNode.type,
            depth,
            via: `edge:${edge.type}`,
          });
          traverse(sourceNode.id, depth + 1);
        }
      }
    }

    for (const mc of cas.method_calls || []) {
      if (mc.target_node === currentId && mc.caller_node && !visited.has(mc.caller_node)) {
        const callerNode = cas.nodes.find(n => n.id === mc.caller_node);
        if (callerNode) {
          callers.push({
            node_id: callerNode.id,
            name: callerNode.name,
            type: callerNode.type,
            depth,
            via: `method_call:${mc.call_details.method_name}`,
          });
          traverse(callerNode.id, depth + 1);
        }
      }
    }
  }

  traverse(nodeId, 1);
  return callers;
}

export function getCallees(cas: CASOutput, nodeId: string, maxDepth: number = 2) {
  const visited = new Set<string>();
  const callees: Array<{ node_id: string; name: string; type: string; depth: number; via: string }> = [];

  function traverse(currentId: string, depth: number) {
    if (depth > maxDepth || visited.has(currentId)) return;
    visited.add(currentId);

    for (const edge of cas.edges) {
      if (edge.source === currentId && !visited.has(edge.target)) {
        const targetNode = cas.nodes.find(n => n.id === edge.target);
        if (targetNode) {
          callees.push({
            node_id: targetNode.id,
            name: targetNode.name,
            type: targetNode.type,
            depth,
            via: `edge:${edge.type}`,
          });
          traverse(targetNode.id, depth + 1);
        }
      }
    }

    for (const mc of cas.method_calls || []) {
      if (mc.caller_node === currentId && mc.target_node && !visited.has(mc.target_node)) {
        const targetNode = cas.nodes.find(n => n.id === mc.target_node);
        if (targetNode) {
          callees.push({
            node_id: targetNode.id,
            name: targetNode.name,
            type: targetNode.type,
            depth,
            via: `method_call:${mc.call_details.method_name}`,
          });
          traverse(targetNode.id, depth + 1);
        }
      }
    }
  }

  traverse(nodeId, 1);
  return callees;
}

export function getCallChain(cas: CASOutput, opts: { chainId?: string; entryPointId?: string }) {
  const chains = cas.call_chains || [];
  if (opts.chainId) return chains.find(c => c.id === opts.chainId) || null;
  if (opts.entryPointId) return chains.filter(c => c.entry_point.entry_point_id === opts.entryPointId);
  return chains;
}

export function getMethodCalls(cas: CASOutput, nodeId: string) {
  const calls = cas.method_calls || [];
  return {
    made_by: calls.filter(mc => mc.caller_node === nodeId),
    received_by: calls.filter(mc => mc.target_node === nodeId),
  };
}

export function getIntent(cas: CASOutput, nodeId: string) {
  return (cas.intents || []).find(i => i.node_id === nodeId) || null;
}

export function getDataEntities(cas: CASOutput, entityName?: string) {
  const entities = cas.data_entities || [];
  if (entityName) {
    const filtered = entities.filter(e =>
      e.name.toLowerCase().includes(entityName.toLowerCase())
    );
    return { entities: filtered, data_summary: cas.data_summary };
  }
  return { entities, data_summary: cas.data_summary };
}

export function getSecurityOverview(cas: CASOutput) {
  return {
    security_boundaries: cas.security_boundaries || [],
    security_summary: cas.security_summary || null,
    security_contexts: cas.security_contexts || [],
  };
}

export function getStability(cas: CASOutput, nodeId?: string) {
  if (nodeId) {
    return (cas.temporal_stability || []).find(s => s.node_id === nodeId) || null;
  }
  return {
    stability_summary: cas.stability_summary || null,
    temporal_stability: cas.temporal_stability || [],
  };
}

export function assessChangeRisk(cas: CASOutput, nodeId: string) {
  const risk = (cas.change_risks || []).find(r => r.node_id === nodeId);
  return {
    risk: risk || null,
    change_risk_summary: cas.change_risk_summary || null,
  };
}

export function getFlowCoverage(cas: CASOutput, chainId?: string) {
  const coverage = cas.flow_coverage || [];
  if (chainId) {
    return {
      coverage: coverage.find(fc => fc.call_chain_id === chainId) || null,
      test_gaps: (cas.test_gaps || []).filter(g => g.location.call_chain_id === chainId),
    };
  }
  return {
    flow_summary: cas.flow_summary || null,
    coverage,
    test_gaps: cas.test_gaps || [],
  };
}

export function getWorkflows(cas: CASOutput, workflowId?: string) {
  if (workflowId) {
    const workflow = (cas.workflows || []).find(w => w.id === workflowId);
    return { workflow: workflow || null };
  }
  return {
    workflows: cas.workflows || [],
    workflow_graph: cas.workflow_graph || null,
  };
}

export function getFlowGraph(cas: CASOutput) {
  return cas.flow_graph || null;
}

export function getDomainConcepts(cas: CASOutput) {
  return cas.domain_concepts || [];
}

export function getPatterns(cas: CASOutput) {
  return {
    patterns: cas.patterns || [],
    categories: cas.categories || {},
    behaviors: cas.behaviors || [],
  };
}

export function getPerspectives(cas: CASOutput) {
  return cas.perspectives || [];
}

export function findTests(cas: CASOutput, opts: { nodeId?: string; filePath?: string }) {
  const suites = cas.test_suites || [];
  const mocks = cas.mocks || [];
  const fixtures = cas.fixtures || [];

  if (opts.nodeId) {
    const relevantSuites = suites.filter(s =>
      s.coverage?.nodes_tested?.includes(opts.nodeId!) ||
      s.tests.some(t => t.targets?.includes(opts.nodeId!))
    );
    const relevantMocks = mocks.filter(m =>
      m.target_node === opts.nodeId || m.used_by?.includes(opts.nodeId!)
    );
    return { suites: relevantSuites, mocks: relevantMocks, fixtures };
  }

  if (opts.filePath) {
    const normalized = opts.filePath.replace(/\\/g, '/');
    const relevantSuites = suites.filter(s =>
      s.file_path.replace(/\\/g, '/').includes(normalized)
    );
    return { suites: relevantSuites, mocks, fixtures };
  }

  return { suites, mocks, fixtures };
}

export function getTestSummary(cas: CASOutput) {
  return {
    test_summary: cas.test_summary || null,
    test_gaps: cas.test_gaps || [],
    test_coverage: cas.test_coverage || null,
  };
}

export function getDatabaseSchema(cas: CASOutput) {
  return cas.database_schema || null;
}

export function getImplementationHealth(cas: CASOutput) {
  return cas.implementation_health || null;
}

export function getDocumentationCoverage(cas: CASOutput) {
  return cas.documentation_summary || null;
}

export function getTodos(cas: CASOutput) {
  return cas.todos_summary || null;
}

export function getDependencies(cas: CASOutput) {
  return cas.dependencies || null;
}

export function getLibraries(cas: CASOutput) {
  return cas.libraries || [];
}

export function getLevel(cas: CASOutput, level: number) {
  const levelDef = cas.progressive_levels?.level_definitions?.find(
    d => d.level === level
  ) || null;

  const nodes = cas.nodes.filter(n => n.level === level);
  const nodeIds = new Set(nodes.map(n => n.id));

  const edges = cas.edges.filter(
    e => nodeIds.has(e.source) || nodeIds.has(e.target)
  );

  const crossLevelEdges = edges.filter(
    e => !nodeIds.has(e.source) || !nodeIds.has(e.target)
  ).map(e => {
    const externalId = nodeIds.has(e.source) ? e.target : e.source;
    const externalNode = cas.nodes.find(n => n.id === externalId);
    return {
      ...trimEdge(e),
      external_node: externalNode ? {
        id: externalNode.id,
        name: externalNode.name,
        type: externalNode.type,
        level: externalNode.level,
        level_name: externalNode.level_name,
      } : null,
    };
  });

  const internalEdges = edges.filter(
    e => nodeIds.has(e.source) && nodeIds.has(e.target)
  ).map(trimEdge);

  const entryPoints = (cas.entry_points || []).filter(ep =>
    ep.source_node && nodeIds.has(ep.source_node) ||
    ep.handler?.node_id && nodeIds.has(ep.handler.node_id)
  );

  const exitPoints = (cas.exit_points || []).filter(ep =>
    ep.source_node && nodeIds.has(ep.source_node)
  );

  return {
    level,
    definition: levelDef,
    total_levels: cas.progressive_levels?.total_levels || 0,
    available_levels: cas.progressive_levels?.level_definitions?.map(d => ({
      level: d.level,
      name: d.name,
      node_count: d.node_count,
    })) || [],
    nodes: nodes.map(n => ({
      id: n.id,
      name: n.name,
      type: n.type,
      qualified_name: n.qualified_name,
      category: n.category,
      level: n.level,
      level_name: n.level_name,
      file: n.source?.file,
      line: n.source?.line,
      description: n.description,
      parent: n.parent,
      children: n.children,
      tags: n.tags,
    })),
    internal_edges: internalEdges,
    cross_level_edges: crossLevelEdges,
    entry_points: entryPoints,
    exit_points: exitPoints,
  };
}
