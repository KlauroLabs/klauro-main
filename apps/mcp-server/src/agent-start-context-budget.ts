export function adaptAgentStartContext<T extends Record<string, any>>(context: T, responseProfile?: string): T {
  if (!responseProfile || responseProfile === 'standard') return context;

  const start = context.starting_points || {};
  const readinessGaps = Array.isArray(context.readiness?.gaps) ? context.readiness.gaps : [];
  const databaseEntities = context.scale?.database_entities;
  const compact = {
    context_profile: responseProfile,
    path: context.path,
    generated_at: context.generated_at,
    default_rule: context.default_rule,
    task: context.task,
    ...(context.analysis_freshness ? { analysis_freshness: context.analysis_freshness } : {}),
    ...(context.focus ? { focus: context.focus } : {}),
    readiness: {
      ...context.readiness,
      gaps: readinessGaps.slice(0, 5),
      omitted_gap_count: Math.max(0, readinessGaps.length - 5),
    },
    system: {
      ...context.system,
      top_capabilities: Array.isArray(context.system?.top_capabilities)
        ? context.system.top_capabilities.slice(0, 4)
        : context.system?.top_capabilities,
    },
    ...(context.product_orientation ? { product_orientation: context.product_orientation } : {}),
    scale: {
      ...context.scale,
      database_entities: Array.isArray(databaseEntities) ? databaseEntities.length : databaseEntities,
    },
    starting_points: {
      ...(start.scope ? { scope: start.scope } : {}),
      entry_points: Array.isArray(start.entry_points) ? start.entry_points.slice(0, 3) : [],
      exit_points: Array.isArray(start.exit_points) ? start.exit_points.slice(0, 3) : [],
      connected_nodes: Array.isArray(start.connected_nodes) ? start.connected_nodes.slice(0, 4) : [],
      ...(Array.isArray(start.runtime_static_links) ? { runtime_static_links: start.runtime_static_links.slice(0, 3) } : {}),
    },
    recommended_first_tools: Array.isArray(context.recommended_first_tools)
      ? context.recommended_first_tools.slice(0, 4).map((step: any) => ({
        tool: step.tool,
        purpose: truncate(String(step.purpose || step.reason || ''), 120),
      }))
      : [],
    when_to_read_files: context.when_to_read_files,
  };

  if (responseProfile !== 'capsule-only') return compact as unknown as T;
  return {
    context_profile: 'capsule-only',
    path: compact.path,
    ...(compact.focus ? { focus: compact.focus } : {}),
    readiness: compact.readiness,
    system: compact.system,
    starting_points: compact.starting_points,
    recommended_first_tools: compact.recommended_first_tools,
    rule: 'Expand start context only when these CAS-backed starting points leave a concrete gap.',
  } as unknown as T;
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}
