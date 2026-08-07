/**
 * EDGE REFERENTIAL INTEGRITY — the invariant that every edge endpoint names a
 * row that actually exists.
 *
 * WHY THIS EXISTS (measured, not hypothesized). The graph is what every other
 * surface is derived from: call chains, flows, capabilities, coverage, risk.
 * A stored analysis of a real multi-app repository carried 17,298 of 102,354
 * edges (16.9%) whose endpoint id resolved in NO id-bearing collection —
 * neither `nodes`, nor `exit_points`, nor `entry_points`. Every one of them was
 * missing its TARGET, and 17,245 were `calls` edges. The cause was a pass that
 * legitimately DROPS a row (an exit point re-classified as an in-repo call)
 * without reconciling the edges that already referenced it: a limit/filter
 * applied to one collection with no reconciliation of the references into it.
 *
 * The count was already computed — `validation.graph_integrity.dangling_edges`
 * reported 17,295 in that same stored analysis, alongside 17,295 validation
 * warnings — and nothing acted on it. A number nobody gates on is a number
 * that silently grows: the same shape was present at 1,540 on the previous
 * build and grew by an order of magnitude when one app added thousands of
 * call sites. So this module exists to make the invariant CHECKABLE by a gate,
 * with a per-class breakdown that says which producer to go fix rather than
 * only how bad it is.
 *
 * SCOPE. Pure, allocation-light, and dependency-free on purpose: it runs both
 * inside the analysis pipeline and as a standalone check over a stored
 * analysis document, so the gate and the pipeline can never disagree about
 * what the invariant means.
 */

/** The id-bearing collections an edge endpoint is allowed to name. */
export interface GraphEndpointCollections {
  nodes?: Array<{ id: string }>;
  entry_points?: Array<{ id: string }>;
  exit_points?: Array<{ id: string }>;
}

export interface DanglingEdgeSample {
  edge_id: string;
  edge_type: string;
  /** Which endpoint failed to resolve. */
  endpoint: 'source' | 'target' | 'both';
  unresolved_id: string;
}

export interface ReferentialIntegrityReport {
  total_edges: number;
  /** Edges with at least one unresolvable endpoint. */
  dangling_edges: number;
  /** Split of `dangling_edges` by which side failed. */
  by_endpoint: { source: number; target: number; both: number };
  /** Dangling edges grouped by `edge.type` — names the producing relationship. */
  by_edge_type: Record<string, number>;
  /** Dangling edges grouped by the leading id prefix of the unresolved id
   *  (`exit_sdk`, `seam_x`, …) — names the producing id scheme, which is what
   *  points at the analyzer or pass to fix. */
  by_unresolved_id_prefix: Record<string, number>;
  /** First few concrete offenders, so a failure is actionable without a re-run. */
  samples: DanglingEdgeSample[];
  ok: boolean;
}

/** Leading two underscore/colon-delimited segments of an id — enough to name the
 *  scheme (`exit_sdk`, `deployable:api`) without leaking the specific symbol. */
function idPrefixOf(id: string): string {
  const parts = String(id).split(/[_:]/);
  return parts.slice(0, 2).join('_') || String(id);
}

export function checkEdgeReferentialIntegrity(
  edges: Array<{ id?: string; type?: string; source: string; target: string }> | undefined,
  collections: GraphEndpointCollections,
  options: { maxSamples?: number } = {}
): ReferentialIntegrityReport {
  const maxSamples = options.maxSamples ?? 20;
  const endpointIds = new Set<string>();
  for (const collection of [collections.nodes, collections.entry_points, collections.exit_points]) {
    for (const row of collection || []) endpointIds.add(row.id);
  }

  const report: ReferentialIntegrityReport = {
    total_edges: (edges || []).length,
    dangling_edges: 0,
    by_endpoint: { source: 0, target: 0, both: 0 },
    by_edge_type: {},
    by_unresolved_id_prefix: {},
    samples: [],
    ok: true,
  };

  for (const edge of edges || []) {
    const sourceOk = endpointIds.has(edge.source);
    const targetOk = endpointIds.has(edge.target);
    if (sourceOk && targetOk) continue;

    const endpoint: DanglingEdgeSample['endpoint'] = !sourceOk && !targetOk ? 'both' : sourceOk ? 'target' : 'source';
    const unresolvedId = endpoint === 'target' ? edge.target : edge.source;
    report.dangling_edges++;
    report.by_endpoint[endpoint]++;
    const type = edge.type || 'unknown';
    report.by_edge_type[type] = (report.by_edge_type[type] || 0) + 1;
    const prefix = idPrefixOf(unresolvedId);
    report.by_unresolved_id_prefix[prefix] = (report.by_unresolved_id_prefix[prefix] || 0) + 1;
    if (report.samples.length < maxSamples) {
      report.samples.push({
        edge_id: edge.id || `${edge.source}->${edge.target}`,
        edge_type: type,
        endpoint,
        unresolved_id: unresolvedId,
      });
    }
  }

  report.ok = report.dangling_edges === 0;
  return report;
}

/** Human-readable one-screen summary for a gate's stderr. */
export function formatReferentialIntegrityReport(report: ReferentialIntegrityReport): string {
  if (report.ok) {
    return `edge referential integrity clean — ${report.total_edges} edge(s), 0 dangling endpoints.`;
  }
  const pct = report.total_edges > 0 ? ((report.dangling_edges / report.total_edges) * 100).toFixed(1) : '0.0';
  const lines = [
    `${report.dangling_edges} of ${report.total_edges} edge(s) (${pct}%) reference an id that exists in no id-bearing collection.`,
    `  by endpoint: source=${report.by_endpoint.source} target=${report.by_endpoint.target} both=${report.by_endpoint.both}`,
    `  by edge type: ${topEntries(report.by_edge_type)}`,
    `  by unresolved id scheme: ${topEntries(report.by_unresolved_id_prefix)}`,
  ];
  for (const sample of report.samples) {
    lines.push(`  e.g. ${sample.edge_type} edge ${sample.edge_id}: ${sample.endpoint} "${sample.unresolved_id}" unresolved`);
  }
  return lines.join('\n');
}

/**
 * Drop every edge that references an id which was just removed from an
 * id-bearing collection, in place; returns how many were dropped.
 *
 * The counterpart to any pass that legitimately discards a row. Two producers
 * were measured removing rows and leaving their references behind, so the
 * reconciliation lives in one place: a caller that removes rows and forgets
 * this leaves the graph asserting endpoints that do not exist, and every count
 * derived from a traversal inherits the error. Use this when the removed row
 * has no successor to point at; when it does (the row moved rather than
 * vanished), REPOINT the edge instead — dropping loses a real relationship.
 */
export function dropEdgesReferencingRemovedEndpoints(
  edges: Array<{ source: string; target: string }>,
  removedEndpointIds: Set<string>
): number {
  if (removedEndpointIds.size === 0) return 0;
  let writeIndex = 0;
  for (const edge of edges) {
    if (removedEndpointIds.has(edge.source) || removedEndpointIds.has(edge.target)) continue;
    edges[writeIndex++] = edge;
  }
  const dropped = edges.length - writeIndex;
  edges.length = writeIndex;
  return dropped;
}

function topEntries(counts: Record<string, number>, limit = 10): string {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, limit);
  return entries.length > 0 ? entries.map(([k, v]) => `${k}=${v}`).join(' ') : 'none';
}

/**
 * SOURCE-PATH REPO-RELATIVITY — the invariant that every persisted `file`
 * field naming a location under the analysis root is repo-relative.
 *
 * WHY THIS EXISTS. Every other field of this shape is repo-relative; an
 * analyzer that records `node.source.file` (or an entry point's
 * `handler.file`) as an ABSOLUTE path leaks the analysis sandbox's local
 * filesystem layout into customer-visible output and resolves for no
 * consumer — not the UI, not an agent, not a human reading the document on
 * a different machine. 34 analyzer files were found doing this; the generic
 * entry-point backfill then faithfully copies whatever it finds.
 *
 * A path is only flagged when it resolves UNDER the analysis root (i.e. it
 * was supposed to be relativized and was not) — an absolute path pointing
 * genuinely outside the repo (a global dependency, a generated file in a
 * shared cache) is not this defect and is left alone; forcing a relative
 * rewrite there would produce a WRONG path, which is worse than an honest
 * absolute one.
 */
export interface AbsoluteSourcePathSample {
  id: string;
  producer: string;
  field: 'source.file' | 'handler.file';
  file: string;
}

export interface SourcePathIntegrityReport {
  total_checked: number;
  /** Absolute paths that resolve under the analysis root — the defect class. */
  leaked_absolute_paths: number;
  by_producer: Record<string, number>;
  samples: AbsoluteSourcePathSample[];
  ok: boolean;
}

function isPosixAbsolute(file: string): boolean {
  // Repo-relative paths are POSIX-style throughout the CAS (relativize
  // strips both `\` and `/` separated prefixes); a leading `/` or a Windows
  // drive/UNC form is the only shape a repo-relative path never takes.
  return /^\/|^[a-zA-Z]:[\\/]|^\\\\/.test(file);
}

/** True when `file` (already known absolute) resolves under `rootPath`. */
function isUnderRoot(file: string, rootPath: string): boolean {
  const normalizedFile = file.replace(/\\/g, '/');
  const normalizedRoot = rootPath.replace(/\\/g, '/').replace(/\/+$/, '');
  return normalizedFile === normalizedRoot || normalizedFile.startsWith(`${normalizedRoot}/`);
}

export function checkSourcePathIntegrity(
  collections: {
    nodes?: Array<{ id?: string; source?: { file?: string }; analyzers?: string[]; primaryAnalyzer?: string }>;
    entry_points?: Array<{ id?: string; source_analyzer?: string; handler?: { file?: string } }>;
  },
  /** The analysis root a leaked path would have been relativized against.
   *  Persisted documents carry this at `system.root_path` (kept absolute on
   *  purpose as the resolution anchor — see relativize-project-paths.ts). */
  rootPath: string | undefined,
  options: { maxSamples?: number } = {}
): SourcePathIntegrityReport {
  const maxSamples = options.maxSamples ?? 20;
  const report: SourcePathIntegrityReport = {
    total_checked: 0,
    leaked_absolute_paths: 0,
    by_producer: {},
    samples: [],
    ok: true,
  };

  if (!rootPath) {
    // No anchor to prove a path is "under the root" against — refuse to
    // guess rather than risk false positives on genuinely external paths.
    return report;
  }

  const record = (id: string | undefined, producer: string, field: AbsoluteSourcePathSample['field'], file: string) => {
    report.leaked_absolute_paths++;
    report.by_producer[producer] = (report.by_producer[producer] || 0) + 1;
    if (report.samples.length < maxSamples) {
      report.samples.push({ id: id || 'unknown', producer, field, file });
    }
  };

  for (const node of collections.nodes || []) {
    const file = node.source?.file;
    if (!file) continue;
    report.total_checked++;
    if (isPosixAbsolute(file) && isUnderRoot(file, rootPath)) {
      record(node.id, node.primaryAnalyzer || node.analyzers?.[0] || 'unknown', 'source.file', file);
    }
  }

  for (const entryPoint of collections.entry_points || []) {
    const file = entryPoint.handler?.file;
    if (!file) continue;
    report.total_checked++;
    if (isPosixAbsolute(file) && isUnderRoot(file, rootPath)) {
      record(entryPoint.id, entryPoint.source_analyzer || 'unknown', 'handler.file', file);
    }
  }

  report.ok = report.leaked_absolute_paths === 0;
  return report;
}

/** Human-readable one-screen summary for a gate's stderr. */
export function formatSourcePathIntegrityReport(report: SourcePathIntegrityReport): string {
  if (report.ok) {
    return `source-path repo-relativity clean — ${report.total_checked} file field(s) checked, 0 leaked absolute paths.`;
  }
  const pct = report.total_checked > 0 ? ((report.leaked_absolute_paths / report.total_checked) * 100).toFixed(1) : '0.0';
  const lines = [
    `${report.leaked_absolute_paths} of ${report.total_checked} file field(s) (${pct}%) are absolute paths under the analysis root that should have been relativized.`,
    `  by producer: ${topEntries(report.by_producer)}`,
  ];
  for (const sample of report.samples) {
    lines.push(`  e.g. ${sample.producer} ${sample.field} on ${sample.id}: "${sample.file}"`);
  }
  return lines.join('\n');
}
