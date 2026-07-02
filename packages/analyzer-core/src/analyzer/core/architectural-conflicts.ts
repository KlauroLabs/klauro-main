import {
  CASNode,
  CASEdge,
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
 * deviations and pattern-instance data already computed elsewhere in CAS.
 * Severity/labels stay deterministic here; AI interpretation (why it matters,
 * how to align) is layered on at the query/tool boundary, never fabricated
 * structure.
 */

export interface ArchitecturalConflictsInput {
  nodes: CASNode[];
  edges: CASEdge[];
  paradigmConformance: CASParadigmConformance[];
  patterns: CASPattern[];
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
const COUPLING_FAN_IN_THRESHOLD = 25;
const COUPLING_MIN_NODES_FOR_SIGNAL = 30;

/**
 * Deterministic coupling hotspot scan: nodes whose fan-in (distinct callers)
 * is a statistical outlier (>= COUPLING_FAN_IN_THRESHOLD and >= 3x the mean)
 * are flagged as high-coupling — every downstream change to that node has a
 * wide, hard-to-review blast radius. This is a structural fact (edge counts),
 * not a keyword judgment.
 */
function couplingHotspots(nodes: CASNode[], edges: CASEdge[]): CASPrincipleViolation[] {
  if (nodes.length < COUPLING_MIN_NODES_FOR_SIGNAL) return [];

  const fanIn = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (!COUPLING_CALL_EDGES.has(edge.type)) continue;
    const callers = fanIn.get(edge.target) || new Set<string>();
    callers.add(edge.source);
    fanIn.set(edge.target, callers);
  }
  if (fanIn.size === 0) return [];

  const counts = [...fanIn.values()].map(s => s.size);
  const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
  const nodesById = new Map(nodes.map(n => [n.id, n]));

  const hotspots: CASPrincipleViolation[] = [];
  for (const [targetId, callers] of fanIn) {
    if (callers.size < COUPLING_FAN_IN_THRESHOLD) continue;
    if (callers.size < mean * 3) continue;
    const node = nodesById.get(targetId);
    if (!node) continue;
    hotspots.push({
      id: `coupling:${targetId}`,
      principle: 'coupling',
      file: nodeFile(node) || '',
      node_id: targetId,
      detail: `${node.name} has ${callers.size} distinct callers (mean fan-in across the graph is ${mean.toFixed(1)}) — a high-coupling hotspot where changes have wide blast radius`,
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

  const conflicts = [
    ...conflictsFromParadigmDeviations(input.paradigmConformance),
    ...conflictsFromPatternVariations(input.patterns, nodesById),
  ];

  const principle_violations = [
    ...principleViolationsFromDeviations(input.paradigmConformance),
    ...couplingHotspots(input.nodes, input.edges),
  ];

  return { conflicts, principle_violations };
}
