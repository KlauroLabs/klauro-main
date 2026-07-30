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

function topEntries(counts: Record<string, number>, limit = 10): string {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, limit);
  return entries.length > 0 ? entries.map(([k, v]) => `${k}=${v}`).join(' ') : 'none';
}
