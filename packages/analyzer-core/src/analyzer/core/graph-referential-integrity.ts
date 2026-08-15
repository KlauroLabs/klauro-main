





























export interface GraphEndpointCollections {
  nodes?: Array<{ id: string }>;
  entry_points?: Array<{ id: string }>;
  exit_points?: Array<{ id: string }>;
}

export interface DanglingEdgeSample {
  edge_id: string;
  edge_type: string;

  endpoint: 'source' | 'target' | 'both';
  unresolved_id: string;
}

export interface ReferentialIntegrityReport {
  total_edges: number;

  dangling_edges: number;

  by_endpoint: { source: number; target: number; both: number };

  by_edge_type: Record<string, number>;



  by_unresolved_id_prefix: Record<string, number>;

  samples: DanglingEdgeSample[];
  ok: boolean;
}



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




















export interface AbsoluteSourcePathSample {
  id: string;
  producer: string;
  field: 'source.file' | 'handler.file';
  file: string;
}

export interface SourcePathIntegrityReport {
  total_checked: number;

  leaked_absolute_paths: number;
  by_producer: Record<string, number>;
  samples: AbsoluteSourcePathSample[];
  ok: boolean;
}

function isPosixAbsolute(file: string): boolean {



  return /^\/|^[a-zA-Z]:[\\/]|^\\\\/.test(file);
}


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
