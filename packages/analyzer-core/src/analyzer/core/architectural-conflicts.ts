import {
  CASNode,
  CASEdge,
  CASExitPoint,
  CASParadigmConformance,
  CASPattern,
  CASArchitecturalConflict,
  CASPrincipleViolation,
} from '../../types/cas.types';
















export interface ArchitecturalConflictsInput {
  nodes: CASNode[];
  edges: CASEdge[];
  paradigmConformance: CASParadigmConformance[];
  patterns: CASPattern[];



  exitPoints?: CASExitPoint[];
}

const CONCERN_BY_PARADIGM: Record<string, string> = {
  'service-mediated-data-access': 'data access from entry-layer handlers',
  'entry-service-repository-layering': 'entry-to-repository call path',
  'guarded-http-entry-points': 'HTTP entry point authorization',
  'single-owner-entity-writes': 'entity write ownership',
};

const DEVIATION_KIND_LABEL: Record<string, string> = {
  'direct-data-access': 'direct data access (bypassing the service layer)',
  'layer-skipping-call': 'direct repository call (skipping the service layer)',
  'unguarded-entry-point': 'unguarded entry point',
  'parallel-implementation': 'writer outside the entity owner module',
};

function nodeFile(node: CASNode | undefined): string | undefined {
  return node?.source?.file;
}

















const ENTRY_LAYER_TYPE = /(^|[_\s])(controller|gateway|resolver|handler|api_route|endpoint)([_\s]|$)/;
const SERVICE_LAYER_TYPE = /(^|[_\s])(service|use_case|usecase|interactor|application_service|workflow)([_\s]|$)/;
const REPOSITORY_LAYER_TYPE = /(^|[_\s])(repository|repo|dao|data_mapper)([_\s]|$)/;
const ENTRY_LAYER_NAME = /(Controller|Resolver|Gateway|Handler)$/;
const SERVICE_LAYER_NAME = /(Service|UseCase|Interactor)$/;
const REPOSITORY_LAYER_NAME = /(Repository|Repo|DAO|Dao)$/;
const CALL_EDGE_TYPES = new Set(['calls', 'invokes', 'executes', 'uses', 'depends_on', 'injects']);
const CONTAINMENT_EDGE_TYPES = new Set(['contains', 'has_method', 'declares']);

const SCOPE_NORM_THRESHOLD = 0.7;
const SCOPE_MIN_COMPARABLE = 3;

function isEntryLayer(node: CASNode): boolean {
  return ENTRY_LAYER_TYPE.test(node.type) || ENTRY_LAYER_NAME.test(node.name);
}
function isServiceLayer(node: CASNode): boolean {
  if (isEntryLayer(node)) return false;
  return SERVICE_LAYER_TYPE.test(node.type) || SERVICE_LAYER_NAME.test(node.name);
}
function isRepositoryLayer(node: CASNode): boolean {
  return REPOSITORY_LAYER_TYPE.test(node.type) || REPOSITORY_LAYER_NAME.test(node.name);
}




function deployableScopeOf(file: string): string {
  const segments = file.split('/').filter(Boolean);
  if (segments.length === 0) return '';
  if ((segments[0] === 'apps' || segments[0] === 'packages' || segments[0] === 'services') && segments.length > 1) {
    return `${segments[0]}/${segments[1]}`;
  }
  return segments[0];
}

interface ScopeEntryProfile {
  node: CASNode;
  scope: string;
  callsServiceLayer: boolean;
  callsRepositoryDirectly: boolean;
  repoTargetFiles: string[];
}

function profileEntryNodesByScope(
  nodes: CASNode[],
  edges: CASEdge[],
  exitPoints: CASExitPoint[]
): ScopeEntryProfile[] {
  const nodesById = new Map(nodes.map(n => [n.id, n]));






  const dbExitSourcesByMethod = new Set(exitPoints.filter(e => e.type === 'database').map(e => e.source_node));








  const callTargetsBySource = new Map<string, string[]>();
  const containedBySource = new Map<string, string[]>();
  const ownerByChild = new Map<string, string>();
  for (const edge of edges) {
    if (CALL_EDGE_TYPES.has(edge.type)) {
      const list = callTargetsBySource.get(edge.source) || [];
      list.push(edge.target);
      callTargetsBySource.set(edge.source, list);
    }
    if (CONTAINMENT_EDGE_TYPES.has(edge.type)) {
      const list = containedBySource.get(edge.source) || [];
      list.push(edge.target);
      containedBySource.set(edge.source, list);
      if (!ownerByChild.has(edge.target)) ownerByChild.set(edge.target, edge.source);
    }
  }

  function memberScope(nodeId: string): string[] {
    const scope = [nodeId];
    for (const childId of containedBySource.get(nodeId) || []) scope.push(childId);
    return scope;
  }

  function layerOf(nodeId: string): CASNode | undefined {
    const node = nodesById.get(nodeId);
    if (!node) return undefined;
    if (isServiceLayer(node) || isRepositoryLayer(node)) return node;
    const ownerId = ownerByChild.get(nodeId);
    const owner = ownerId ? nodesById.get(ownerId) : undefined;
    return owner && (isServiceLayer(owner) || isRepositoryLayer(owner)) ? owner : node;
  }

  const profiles: ScopeEntryProfile[] = [];
  for (const node of nodes) {
    if (!isEntryLayer(node)) continue;
    const file = nodeFile(node);
    if (!file) continue;
    const scope = deployableScopeOf(file);

    let callsServiceLayer = false;
    let callsRepositoryDirectly = false;
    const repoTargetFiles: string[] = [];
    for (const memberId of memberScope(node.id)) {
      if (dbExitSourcesByMethod.has(memberId)) callsRepositoryDirectly = true;
      for (const targetId of callTargetsBySource.get(memberId) || []) {
        const target = layerOf(targetId);
        if (!target) continue;
        if (isServiceLayer(target)) callsServiceLayer = true;
        if (isRepositoryLayer(target)) {
          callsRepositoryDirectly = true;
          const targetFile = nodeFile(target);
          if (targetFile) repoTargetFiles.push(targetFile);
        }
      }
    }



    if (!callsServiceLayer && !callsRepositoryDirectly) continue;

    profiles.push({ node, scope, callsServiceLayer, callsRepositoryDirectly, repoTargetFiles });
  }
  return profiles;
}

function conflictsFromPerScopeLayering(
  nodes: CASNode[],
  edges: CASEdge[],
  exitPoints: CASExitPoint[]
): CASArchitecturalConflict[] {
  const profiles = profileEntryNodesByScope(nodes, edges, exitPoints);
  if (profiles.length === 0) return [];

  const byScope = new Map<string, ScopeEntryProfile[]>();
  for (const profile of profiles) {
    const list = byScope.get(profile.scope) || [];
    list.push(profile);
    byScope.set(profile.scope, list);
  }

  const conflicts: CASArchitecturalConflict[] = [];
  for (const [scope, scopeProfiles] of byScope) {
    if (scopeProfiles.length < SCOPE_MIN_COMPARABLE) continue;

    const layeredCount = scopeProfiles.filter(p => p.callsServiceLayer && !p.callsRepositoryDirectly).length;
    const directCount = scopeProfiles.filter(p => p.callsRepositoryDirectly && !p.callsServiceLayer).length;
    const total = scopeProfiles.length;






    const layeredShare = layeredCount / total;
    const directShare = directCount / total;
    const dominantIsLayered = layeredShare >= SCOPE_NORM_THRESHOLD;
    const dominantIsDirect = directShare >= SCOPE_NORM_THRESHOLD;
    if (!dominantIsLayered && !dominantIsDirect) continue;

    const deviants = dominantIsLayered
      ? scopeProfiles.filter(p => p.callsRepositoryDirectly)
      : scopeProfiles.filter(p => p.callsServiceLayer && !p.callsRepositoryDirectly);
    if (deviants.length === 0) continue;

    const normLabel = dominantIsLayered
      ? 'entry-layer handlers call the service layer, which then reaches the repository'
      : 'entry-layer handlers call repositories directly (no service layer in this scope)';
    const deviationLabel = dominantIsLayered
      ? 'direct repository call from an entry-layer handler (skipping the service layer)'
      : 'entry-layer handler routed through a service layer, inconsistent with this scope\'s direct-repository convention';

    const normFiles = [...new Set(
      scopeProfiles.filter(p => (dominantIsLayered ? p.callsServiceLayer && !p.callsRepositoryDirectly : p.callsRepositoryDirectly && !p.callsServiceLayer))
        .map(p => nodeFile(p.node)).filter((f): f is string => Boolean(f))
    )].slice(0, 5);
    const deviantFiles = [...new Set(deviants.map(p => nodeFile(p.node)).filter((f): f is string => Boolean(f)))];

    conflicts.push({
      id: `per-scope-layering:${scope}`,
      kind: 'pattern-conflict',
      concern: `entry-to-repository call path within ${scope}`,
      competing: [
        { label: normLabel, files: normFiles, share: Number(Math.max(layeredShare, directShare).toFixed(2)) },
        { label: deviationLabel, files: deviantFiles.slice(0, 5), share: Number((deviants.length / total).toFixed(2)) },
      ],
      severity: deviants.length >= 3 ? 'high' : deviants.length === 2 ? 'medium' : 'low',
      evidence: deviants.slice(0, 5).map(p => {
        const f = nodeFile(p.node) || 'unknown file';
        return dominantIsLayered
          ? `${f}: ${p.node.name} calls the repository directly, skipping the service layer used elsewhere in ${scope}`
          : `${f}: ${p.node.name} routes through a service layer, unlike other entry points in ${scope}`;
      }),
      suggested_alignment: `Within ${scope}, ${total - deviants.length}/${total} comparable entry points follow "${normLabel}". Align the ${deviants.length} deviating site(s) on that local convention, or document why this scope's layering is deliberately split.`,
    });
  }

  return conflicts;
}











function conflictsFromParadigmDeviations(
  paradigmConformance: CASParadigmConformance[]
): CASArchitecturalConflict[] {
  const conflicts: CASArchitecturalConflict[] = [];

  for (const paradigm of paradigmConformance) {
    if (paradigm.deviations.length === 0) continue;
    const concern = CONCERN_BY_PARADIGM[paradigm.paradigm] || paradigm.description;

    const deviantFiles = [...new Set(paradigm.deviations.map(d => d.file).filter(Boolean))];
    const deviationKinds = [...new Set(paradigm.deviations.map(d => d.kind))];
    const kindLabel = deviationKinds.map(k => DEVIATION_KIND_LABEL[k] || k).join('; ');

    const errorCount = paradigm.deviations.filter(d => d.severity === 'error').length;
    const warningCount = paradigm.deviations.filter(d => d.severity === 'warning').length;
    const severity: CASArchitecturalConflict['severity'] =
      errorCount > 0 ? 'high' : warningCount >= 3 ? 'medium' : 'low';

    conflicts.push({
      id: `paradigm-conflict:${paradigm.paradigm}`,
      kind: 'pattern-conflict',
      concern,
      competing: [
        {
          label: paradigm.description,
          files: paradigm.adoption.evidence_files,
          share: paradigm.adoption.adoption_rate,
        },
        {
          label: kindLabel || 'competing shape',
          files: deviantFiles.slice(0, 5),
          share: Number((1 - paradigm.adoption.adoption_rate).toFixed(2)),
        },
      ],
      severity,
      evidence: paradigm.deviations.slice(0, 5).map(d => `${d.file}: ${d.detail}`),
      suggested_alignment: `Align the ${deviantFiles.length} deviating site(s) on "${paradigm.description}" (already followed by ${paradigm.adoption.following_count}/${paradigm.adoption.comparable_count} comparable sites), or, if the deviation is intentional, document why this concern is exempt.`,
    });
  }

  return conflicts;
}









function conflictsFromPatternVariations(
  patterns: CASPattern[],
  nodesById: Map<string, CASNode>
): CASArchitecturalConflict[] {
  const conflicts: CASArchitecturalConflict[] = [];
  const MIN_MINORITY_SHARE = 0.2;
  const MIN_MINORITY_INSTANCES = 2;

  for (const pattern of patterns) {
    const variations = (pattern.variations || []).filter(v => v.instances.length >= MIN_MINORITY_INSTANCES);
    if (variations.length < 2) continue;

    const sorted = [...variations].sort((a, b) => b.percentage - a.percentage);
    const minority = sorted.slice(1).filter(v => v.percentage >= MIN_MINORITY_SHARE);
    if (minority.length === 0) continue;

    const dominant = sorted[0];
    const competing = [dominant, ...minority].map(v => ({
      label: `${pattern.name}: ${v.implementation}`,
      files: [...new Set(
        v.instances
          .map(id => nodeFile(nodesById.get(id)))
          .filter((f): f is string => Boolean(f))
      )].slice(0, 5),
      share: Number((v.percentage / 100).toFixed(2)),
    }));

    conflicts.push({
      id: `pattern-variation-conflict:${pattern.id}`,
      kind: 'pattern-overlap',
      concern: pattern.description || pattern.name,
      competing,
      severity: minority.some(v => v.percentage >= 35) ? 'medium' : 'low',
      evidence: competing.flatMap(c => c.files.slice(0, 2).map(f => `${f}: ${c.label}`)),
      suggested_alignment: `"${dominant.implementation}" is the dominant ${pattern.name} style (${dominant.percentage}% of instances). Prefer it for new code unless the minority style (${minority.map(v => v.implementation).join(', ')}) is scoped to a deliberately distinct subsystem.`,
    });
  }

  return conflicts;
}







function principleViolationsFromDeviations(
  paradigmConformance: CASParadigmConformance[]
): CASPrincipleViolation[] {
  const violations: CASPrincipleViolation[] = [];

  for (const paradigm of paradigmConformance) {
    for (const deviation of paradigm.deviations) {
      if (deviation.kind === 'layer-skipping-call' || deviation.kind === 'direct-data-access') {
        violations.push({
          id: `layering:${deviation.node_id}`,
          principle: 'layering',
          file: deviation.file,
          node_id: deviation.node_id,
          detail: deviation.detail,
          severity: deviation.severity,
        });
      } else if (deviation.kind === 'parallel-implementation') {
        violations.push({
          id: `single-responsibility:${deviation.node_id}`,
          principle: 'single-responsibility',
          file: deviation.file,
          node_id: deviation.node_id,
          detail: deviation.detail,
          severity: deviation.severity,
        });
      }
    }
  }

  return violations;
}

const COUPLING_CALL_EDGES = new Set(['calls', 'invokes', 'executes', 'uses', 'depends_on', 'injects']);
const COUPLING_WRITE_EDGES = new Set(['writes', 'creates', 'updates', 'deletes', 'persists', 'saves', 'mutates']);
const COUPLING_FAN_IN_THRESHOLD = 25;
const COUPLING_MIN_NODES_FOR_SIGNAL = 30;














function hasSideEffects(
  nodeId: string,
  writeSources: Set<string>,
  exitSources: Set<string>,
  nodesById: Map<string, CASNode>
): boolean {
  if (writeSources.has(nodeId)) return true;
  if (exitSources.has(nodeId)) return true;
  const node = nodesById.get(nodeId);
  const attrs = node?.metadata?.attributes as Record<string, unknown> | undefined;
  if (attrs) {
    if (attrs.is_leaf === true && (attrs.outgoing_calls === 0 || attrs.outgoing_calls === undefined)) {
      return false;
    }
  }






  return (node?.implementation?.modifies?.length ?? 0) > 0;
}














function couplingHotspots(
  nodes: CASNode[],
  edges: CASEdge[],
  exitPoints: CASExitPoint[]
): CASPrincipleViolation[] {
  if (nodes.length < COUPLING_MIN_NODES_FOR_SIGNAL) return [];

  const fanIn = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (!COUPLING_CALL_EDGES.has(edge.type)) continue;
    const callers = fanIn.get(edge.target) || new Set<string>();
    callers.add(edge.source);
    fanIn.set(edge.target, callers);
  }
  if (fanIn.size === 0) return [];

  const writeSources = new Set<string>();
  for (const edge of edges) {
    if (COUPLING_WRITE_EDGES.has(edge.type)) writeSources.add(edge.source);
  }
  const exitSources = new Set(exitPoints.map(e => e.source_node));

  const counts = [...fanIn.values()].map(s => s.size);
  const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
  const nodesById = new Map(nodes.map(n => [n.id, n]));

  const hotspots: CASPrincipleViolation[] = [];
  for (const [targetId, callers] of fanIn) {
    if (callers.size < COUPLING_FAN_IN_THRESHOLD) continue;
    if (callers.size < mean * 3) continue;
    const node = nodesById.get(targetId);
    if (!node) continue;

    const stateful = hasSideEffects(targetId, writeSources, exitSources, nodesById);
    if (!stateful) {



      continue;
    }

    hotspots.push({
      id: `coupling:${targetId}`,
      principle: 'coupling',
      file: nodeFile(node) || '',
      node_id: targetId,
      detail: `${node.name} has ${callers.size} distinct callers (mean fan-in across the graph is ${mean.toFixed(1)}) and mutates state or hits an external system — a high-coupling hotspot where changes have wide, side-effecting blast radius`,




      severity: callers.size >= mean * 6 ? 'warning' : 'info',
    });
  }

  return hotspots.sort((a, b) => b.detail.length - a.detail.length).slice(0, 10);
}

export function buildArchitecturalConflicts(input: ArchitecturalConflictsInput): {
  conflicts: CASArchitecturalConflict[];
  principle_violations: CASPrincipleViolation[];
} {
  const nodesById = new Map(input.nodes.map(n => [n.id, n]));





  const scopesAlreadyCoveredGlobally = new Set(
    input.paradigmConformance
      .filter(p => p.paradigm === 'entry-service-repository-layering' && p.deviations.length > 0)
      .flatMap(p => p.deviations.map(d => deployableScopeOf(d.file)))
  );
  const perScopeConflicts = conflictsFromPerScopeLayering(input.nodes, input.edges, input.exitPoints ?? [])
    .filter(c => !scopesAlreadyCoveredGlobally.has(c.id.replace('per-scope-layering:', '')));

  const conflicts = [
    ...conflictsFromParadigmDeviations(input.paradigmConformance),
    ...conflictsFromPatternVariations(input.patterns, nodesById),
    ...perScopeConflicts,
  ];

  const principle_violations = [
    ...principleViolationsFromDeviations(input.paradigmConformance),
    ...couplingHotspots(input.nodes, input.edges, input.exitPoints ?? []),
  ];

  return { conflicts, principle_violations };
}
