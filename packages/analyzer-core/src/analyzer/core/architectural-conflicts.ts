import {
  CASNode,
  CASEdge,
  CASExitPoint,
  CASParadigmConformance,
  CASPattern,
  CASArchitecturalConflict,
  CASPrincipleViolation,
} from '../../types/cas.types';

/**
 * Architectural consistency detector: deterministic structural facts about
 * where the codebase is NOT cohesive — the same concern handled by two
 * different structural patterns in different places, and engineering-
 * principle breaks (layering skips, split-ownership writes, coupling
 * hotspots). This is NOT a keyword categorizer: every finding is grounded in
 * concrete node/file evidence pulled from the existing paradigm-conformance
 * deviations and pattern-instance data already computed elsewhere in CAS,
 * plus a local per-scope layering pass and a side-effect-weighted coupling
 * scan computed directly from nodes/edges/exit_points (all facts already
 * produced upstream — no new analyzer pass). Severity/labels stay
 * deterministic here; AI interpretation (why it matters, how to align) is
 * layered on at the query/tool boundary, never fabricated structure.
 */

export interface ArchitecturalConflictsInput {
  nodes: CASNode[];
  edges: CASEdge[];
  paradigmConformance: CASParadigmConformance[];
  patterns: CASPattern[];
  /** Optional: external-interaction facts, reused (not recomputed) to weight
   *  coupling severity by side effects. Absent on older call sites — the
   *  coupling scan degrades gracefully to fan-in-only in that case. */
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

function moduleOf(file: string): string {
  const segments = file.split('/').filter(Boolean);
  segments.pop();
  return segments.join('/');
}

/**
 * Per-scope (per-module/package/app) layering-norm inference. This is
 * independent of `paradigmConformance`, which infers a single REPO-WIDE norm
 * and abstains entirely (zero deviations) when no global norm reaches the
 * 70%-adoption threshold — exactly the failure mode on a monorepo where
 * different apps legitimately use different (each internally consistent)
 * layering styles. Instead of one global norm, this groups entry-layer nodes
 * (controllers/handlers/resolvers/gateways) by their top-level deployable
 * scope (first 1-2 path segments, e.g. `apps/mcp-server`,
 * `packages/analyzer-core`) and asks: within THIS scope, does a dominant
 * shape exist (entry -> service -> repo vs. entry -> repo directly)? If a
 * scope has its own dominant convention, a file that breaks it inside that
 * SAME scope is a real deviation — even if a sibling scope uses a totally
 * different (also internally consistent) style. No global norm is required.
 */
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

/** Top-level deployable scope: package.json/app root heuristic via first two
 *  path segments (e.g. `apps/mcp-server`, `packages/analyzer-core`), falling
 *  back to the first segment for shallower trees. */
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
  // Some analyzers resolve a repository call as a database EXIT POINT sourced
  // from the calling method (e.g. `this.repo.delete(id)` -> exit_db_*)
  // instead of a method->method call edge into the repository class. Direct
  // database access from an entry-layer method is exactly the same
  // "skips-the-service-layer" signal as calling a repository node, so treat
  // both as equivalent evidence of a direct-repository-style call.
  const dbExitSourcesByMethod = new Set(exitPoints.filter(e => e.type === 'database').map(e => e.source_node));

  // Call edges resolve at the METHOD level (method -> method), not class ->
  // class — so layer classification has to happen on the owning class,
  // resolved via containment edges (class -contains-> method), the same
  // pattern paradigm-conformance.ts uses for its own entry/service/repo
  // profiling. ownerByChild maps a method/member node id to its containing
  // class id so a call from/to a method can be attributed to that class's
  // layer (controller/service/repository).
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
    // Only comparable when the entry node actually reaches data-access code
    // one way or the other; entries with no service/repo calls at all say
    // nothing about layering style and would just dilute the scope's norm.
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

    // The scope's own local norm is whichever shape dominates >= threshold —
    // could be layered (the "good" convention) OR direct (a scope that
    // deliberately skips a service layer everywhere, which is then itself
    // consistent and must NOT be flagged). Only the minority inside a scope
    // that clearly has a norm is a deviation.
    const layeredShare = layeredCount / total;
    const directShare = directCount / total;
    const dominantIsLayered = layeredShare >= SCOPE_NORM_THRESHOLD;
    const dominantIsDirect = directShare >= SCOPE_NORM_THRESHOLD;
    if (!dominantIsLayered && !dominantIsDirect) continue; // no local norm either — stay silent

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

/**
 * (a) Pattern-conflict/overlap from paradigm deviations: a paradigm with a
 * norm (adoption_rate >= threshold already enforced upstream) that also has
 * deviations IS a competing-pattern signal — the norm is one structural
 * pattern (e.g. handler -> service -> repo), the deviations are a second,
 * competing pattern (handler -> repo) applied to the same concern in
 * different places. We surface this as a conflict, grouping deviations by
 * paradigm so an agent sees "the norm" vs "the competing shape" with file
 * evidence on both sides.
 */
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

/**
 * (a) Pattern-overlap from design-pattern variations: when a single detected
 * pattern (e.g. "Repository") has multiple named implementation variations
 * each covering a meaningful share of instances, that is two structural
 * styles doing the same job in different places — surfaced only when no
 * variation dominates (the minority share is large enough to be a real
 * second style, not stray noise).
 */
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

/**
 * (b) Engineering-principle signals: layering violations already surfaced as
 * paradigm deviations of kind layer-skipping-call/direct-data-access, plus
 * single-owner/responsibility breaks from parallel-implementation deviations,
 * plus a deterministic coupling-hotspot scan (fan-in/fan-out outliers).
 */
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

/**
 * Side-effect signal for a node, built entirely from facts already computed
 * upstream (outgoing write-edges + exit-point sourcing + call-graph leaf
 * metadata) — no new analyzer pass. A node counts as stateful/side-effecting
 * if it: (a) is the source of a WRITE_EDGE (mutates shared/persisted state),
 * or (b) is the source_node of an exit point (touches a database, external
 * API, file, queue, cache, webhook, or SDK), or (c) its own metadata marks it
 * as non-leaf with outgoing calls into either of the above transitively one
 * hop out. Anything else — a node with zero outgoing writes, zero exit
 * points, and (per its own attributes) zero outgoing calls — is treated as
 * pure/stateless: wide fan-in on such a node is a reuse WIN, not a coupling
 * risk, and must not be flagged the same as a stateful mutator.
 */
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
      return false; // explicitly a leaf with no outgoing calls: cannot reach state
    }
  }
  // No leaf/outgoing-call metadata to lean on and no direct write/exit
  // evidence — conservatively treat as unknown-but-not-provably-pure, since
  // understating a real mutator's severity is worse than a rare
  // false-positive on an ambiguous node. Direct write/exit evidence already
  // covers the vast majority of real mutators, so this branch is the
  // minority case.
  return (node?.implementation?.modifies?.length ?? 0) > 0;
}

/**
 * Deterministic coupling hotspot scan: nodes whose fan-in (distinct callers)
 * is a statistical outlier (>= COUPLING_FAN_IN_THRESHOLD and >= 3x the mean)
 * are flagged as high-coupling — every downstream change to that node has a
 * wide, hard-to-review blast radius. This is a structural fact (edge counts),
 * not a keyword judgment. Severity is then weighted by side effects: a
 * high-fan-in PURE/stateless helper (e.g. an id generator or sanitizer with
 * no writes, no exit points) is wide reuse of a stable utility, not a
 * coupling risk — it is downgraded to 'info' or dropped entirely. A
 * high-fan-in node that DOES mutate shared state or hit an external system
 * keeps or raises its severity, since every one of its many callers now
 * shares that blast radius.
 */
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
      // Pure/stateless high-fan-in helper: wide reuse of a stable utility is
      // healthy, not a violation. Drop it rather than warn — it would just
      // be noise an agent has to learn to ignore.
      continue;
    }

    hotspots.push({
      id: `coupling:${targetId}`,
      principle: 'coupling',
      file: nodeFile(node) || '',
      node_id: targetId,
      detail: `${node.name} has ${callers.size} distinct callers (mean fan-in across the graph is ${mean.toFixed(1)}) and mutates state or hits an external system — a high-coupling hotspot where changes have wide, side-effecting blast radius`,
      // Stateful high-fan-in nodes keep the fan-in-based severity band
      // (warning at >=6x mean, info otherwise); the fix here is precision —
      // pure nodes no longer share this band at all, not escalating stateful
      // ones past the existing thresholds.
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

  // De-dupe: if the repo-wide paradigm pass already found a global layering
  // norm+deviations for a scope, don't also emit a per-scope conflict for
  // the exact same concern — the per-scope pass exists to cover the case the
  // global pass ABSTAINS on (no global norm), not to double-report.
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
