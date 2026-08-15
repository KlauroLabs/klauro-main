







































import {
  CASNode,
  CASEdge,
  CASEntryPoint,
  SystemCapability,
  CASTemporalStability,
  CASPrincipleViolation,
  CASModuleHealth,
  CASModuleHealthFinding,
  CASModuleHealthFileStat,
} from '../../types/cas.types';




const MIN_FILES_FOR_SIGNAL = 10;


const MODIFIED_Z_THRESHOLD = 3.5;



const DEPENDENCY_EDGE_TYPES = new Set([
  'calls', 'uses', 'depends_on', 'invokes', 'delegates_to', 'maps_to', 'queries', 'wraps', 'imports', 'references',
]);

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function quantile(sortedValues: number[], q: number): number {
  if (sortedValues.length === 0) return 0;
  const pos = (sortedValues.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (sortedValues[base + 1] !== undefined) {
    return sortedValues[base] + rest * (sortedValues[base + 1] - sortedValues[base]);
  }
  return sortedValues[base];
}





function robustScale(values: number[], med: number): number {
  const deviations = values.map(v => Math.abs(v - med));
  const mad = median(deviations);
  if (mad > 0) return mad;
  const sorted = [...values].sort((a, b) => a - b);
  const iqr = quantile(sorted, 0.75) - quantile(sorted, 0.25);
  return iqr > 0 ? iqr / 1.349 : 0;
}


























function modifiedZScores(values: number[]): { med: number; scale: number; z: number[] } {
  const transformed = values.map(v => Math.cbrt(Math.max(0, v)));
  const med = median(transformed);
  const scale = robustScale(transformed, med);
  if (scale === 0) return { med, scale, z: values.map(() => 0) };
  const z = transformed.map(v => (0.6745 * (v - med)) / scale);
  return { med, scale, z };
}

export interface ModuleHealthInputs {
  nodes: CASNode[];
  edges: CASEdge[];
  entryPoints: CASEntryPoint[];
  systemCapabilities: SystemCapability[];
  temporalStability: CASTemporalStability[];
  principleViolations: CASPrincipleViolation[];
}

interface FileAgg {
  file: string;
  lines: number;
  nodeCount: number;
  fanIn: number;
  fanInFiles: Set<string>;
  commits90d: number;
  capabilityIds: Set<string>;
  layeringViolations: number;
}

export function computeModuleHealth(inputs: ModuleHealthInputs): CASModuleHealth | undefined {
  const { nodes, edges, entryPoints, systemCapabilities, temporalStability, principleViolations } = inputs;

  const byFile = new Map<string, FileAgg>();
  const nodeToFile = new Map<string, string>();

  for (const node of nodes) {
    const file = node.source?.file;
    if (!file) continue;
    nodeToFile.set(node.id, file);
    let agg = byFile.get(file);
    if (!agg) {
      agg = { file, lines: 0, nodeCount: 0, fanIn: 0, fanInFiles: new Set(), commits90d: 0, capabilityIds: new Set(), layeringViolations: 0 };
      byFile.set(file, agg);
    }
    agg.nodeCount += 1;
    const start = node.source?.line ?? 0;
    const end = node.source?.end_line ?? start;
    if (end > agg.lines) agg.lines = end;
  }

  if (byFile.size < MIN_FILES_FOR_SIGNAL) return undefined;




  for (const edge of edges) {
    if (!DEPENDENCY_EDGE_TYPES.has(edge.type)) continue;
    const targetFile = nodeToFile.get(edge.target);
    const sourceFile = nodeToFile.get(edge.source);
    if (!targetFile || !sourceFile || targetFile === sourceFile) continue;
    const agg = byFile.get(targetFile);
    if (agg) agg.fanInFiles.add(sourceFile);
  }
  for (const agg of byFile.values()) agg.fanIn = agg.fanInFiles.size;





  const churnSeenFile = new Set<string>();
  for (const stab of temporalStability) {
    const file = nodeToFile.get(stab.node_id);
    if (!file || churnSeenFile.has(file)) continue;
    const agg = byFile.get(file);
    if (agg) {
      agg.commits90d = stab.churn_metrics.commits_90d;
      churnSeenFile.add(file);
    }
  }


  const entryPointToFile = new Map<string, string>();
  for (const ep of entryPoints) {
    const file = nodeToFile.get(ep.source_node);
    if (file) entryPointToFile.set(ep.id, file);
  }
  for (const cap of systemCapabilities) {
    const filesForCap = new Set<string>();
    for (const op of cap.operations || []) {
      const file = entryPointToFile.get(op.entry_point_id);
      if (file) filesForCap.add(file);
    }
    for (const file of filesForCap) {
      const agg = byFile.get(file);
      if (agg) agg.capabilityIds.add(cap.id);
    }
  }




  for (const v of principleViolations) {
    if (v.principle !== 'layering' || !v.file) continue;
    const agg = byFile.get(v.file);
    if (agg) agg.layeringViolations += 1;
  }

  const files = [...byFile.values()];
  const totalLines = files.reduce((s, f) => s + f.lines, 0);
  const totalCommits90d = files.reduce((s, f) => s + f.commits90d, 0);

  const lineValues = files.map(f => f.lines);
  const churnValues = files.map(f => f.commits90d);
  const fanInValues = files.map(f => f.fanIn);
  const capValues = files.map(f => f.capabilityIds.size);

  const lineStats = modifiedZScores(lineValues);
  const churnStats = modifiedZScores(churnValues);
  const fanInStats = modifiedZScores(fanInValues);
  const capStats = modifiedZScores(capValues);







  const rank = (values: number[]): number[] => {
    const sorted = [...values].map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
    const r = new Array(values.length).fill(0);
    sorted.forEach(([, origIdx], pos) => { r[origIdx] = values.length > 1 ? pos / (values.length - 1) : 0; });
    return r;
  };
  const sizeRank = rank(lineValues);
  const churnRank = rank(churnValues);
  const fanInRank = rank(fanInValues);
  const danger = files.map((_, i) => 0.25 * sizeRank[i] + 0.4 * churnRank[i] + 0.35 * fanInRank[i]);
  const dangerStats = modifiedZScores(danger);




  const rawMedian = (transformedMed: number): number => Math.round(Math.pow(Math.max(0, transformedMed), 3) * 100) / 100;

  const findings: CASModuleHealthFinding[] = [];

  files.forEach((f, i) => {
    if (lineStats.z[i] > MODIFIED_Z_THRESHOLD) {
      findings.push({
        id: `size-outlier:${f.file}`,
        file: f.file,
        kind: 'size-outlier',
        metric_value: f.lines,
        robust_z: Number(lineStats.z[i].toFixed(2)),
        comparison: { median: rawMedian(lineStats.med), scale: lineStats.scale, sample_size: files.length },
        severity: lineStats.z[i] > MODIFIED_Z_THRESHOLD * 2 ? 'error' : 'warning',
        detail: `${f.file} is ${f.lines} lines across ${f.nodeCount} nodes — the codebase median is ${rawMedian(lineStats.med)} lines; this file's cube-root-scale modified z-score is ${lineStats.z[i].toFixed(1)} (outlier threshold ${MODIFIED_Z_THRESHOLD})`,
        evidence: [`nodes:${f.nodeCount}`, `lines:${f.lines}`],
      });
    }
    if (churnStats.z[i] > MODIFIED_Z_THRESHOLD && f.commits90d > 0) {
      findings.push({
        id: `change-concentration:${f.file}`,
        file: f.file,
        kind: 'change-concentration',
        metric_value: f.commits90d,
        robust_z: Number(churnStats.z[i].toFixed(2)),
        comparison: { median: rawMedian(churnStats.med), scale: churnStats.scale, sample_size: files.length },
        severity: churnStats.z[i] > MODIFIED_Z_THRESHOLD * 2 ? 'error' : 'warning',
        detail: `${f.file} absorbed ${f.commits90d} commits in the last 90 days — the codebase median is ${rawMedian(churnStats.med)}; this file's cube-root-scale modified z-score is ${churnStats.z[i].toFixed(1)} (outlier threshold ${MODIFIED_Z_THRESHOLD})`,
        evidence: [`commits_90d:${f.commits90d}`],
      });
    }
    if (fanInStats.z[i] > MODIFIED_Z_THRESHOLD && f.fanIn > 0) {
      findings.push({
        id: `fan-in-hotspot:${f.file}`,
        file: f.file,
        kind: 'fan-in-hotspot',
        metric_value: f.fanIn,
        robust_z: Number(fanInStats.z[i].toFixed(2)),
        comparison: { median: rawMedian(fanInStats.med), scale: fanInStats.scale, sample_size: files.length },
        severity: fanInStats.z[i] > MODIFIED_Z_THRESHOLD * 2 ? 'error' : 'warning',
        detail: `${f.file} is depended on by ${f.fanIn} distinct other files — the codebase median is ${rawMedian(fanInStats.med)}; this file's cube-root-scale modified z-score is ${fanInStats.z[i].toFixed(1)} (outlier threshold ${MODIFIED_Z_THRESHOLD})`,
        evidence: [`fan_in_files:${f.fanIn}`],
      });
    }
    if (f.capabilityIds.size >= 2 && capStats.z[i] > MODIFIED_Z_THRESHOLD) {
      findings.push({
        id: `mixed-concerns:${f.file}`,
        file: f.file,
        kind: 'mixed-concerns',
        metric_value: f.capabilityIds.size,
        robust_z: Number(capStats.z[i].toFixed(2)),
        comparison: { median: rawMedian(capStats.med), scale: capStats.scale, sample_size: files.length },
        severity: f.capabilityIds.size >= 5 ? 'error' : 'warning',
        detail: `${f.file} anchors ${f.capabilityIds.size} distinct capabilities — most files in this codebase anchor ${rawMedian(capStats.med)}; this file co-locates unrelated concerns`,
        evidence: [...f.capabilityIds].slice(0, 10),
      });
    }
    if (dangerStats.z[i] > MODIFIED_Z_THRESHOLD) {
      findings.push({
        id: `danger-composite:${f.file}`,
        file: f.file,
        kind: 'danger-composite',
        metric_value: Number(danger[i].toFixed(3)),
        robust_z: Number(dangerStats.z[i].toFixed(2)),
        comparison: { median: rawMedian(dangerStats.med), scale: dangerStats.scale, sample_size: files.length },
        severity: 'error',
        detail: `${f.file} is dangerous to touch: size rank ${(sizeRank[i] * 100).toFixed(0)}th pct, churn rank ${(churnRank[i] * 100).toFixed(0)}th pct, fan-in rank ${(fanInRank[i] * 100).toFixed(0)}th pct` +
          (f.layeringViolations > 0 ? `, plus ${f.layeringViolations} existing layering violation(s) in this file` : ''),
        evidence: [`lines:${f.lines}`, `commits_90d:${f.commits90d}`, `fan_in:${f.fanIn}`],
      });
    }
  });

  findings.sort((a, b) => b.robust_z - a.robust_z);

  const sizeOutlierFiles = new Set(findings.filter(f => f.kind === 'size-outlier').map(f => f.file));
  const churnOutlierFiles = new Set(findings.filter(f => f.kind === 'change-concentration').map(f => f.file));

  const sizeOutlierLines = files.filter(f => sizeOutlierFiles.has(f.file)).reduce((s, f) => s + f.lines, 0);
  const churnOutlierCommits = files.filter(f => churnOutlierFiles.has(f.file)).reduce((s, f) => s + f.commits90d, 0);

  const fileStats: CASModuleHealthFileStat[] = files
    .map(f => ({
      file: f.file,
      lines: f.lines,
      node_count: f.nodeCount,
      fan_in: f.fanIn,
      commits_90d: f.commits90d,
      capability_anchor_count: f.capabilityIds.size,
    }))
    .sort((a, b) => b.lines - a.lines);

  return {
    method: 'Median + MAD (median absolute deviation), IQR fallback when MAD is degenerate; modified z-score (Iglewicz & Hoaglin) with threshold 3.5 per metric, computed independently for size, 90-day churn, cross-file fan-in, and capability-anchor count, plus a rank-normalized composite (0.25*size + 0.4*churn + 0.35*fan-in) for overall touch-danger. All statistics relative to this codebase\'s own file distribution — no fixed cutoffs.',
    files_analyzed: files.length,
    total_lines: totalLines,
    total_commits_90d: totalCommits90d,
    concentration: {
      size_outlier_file_count: sizeOutlierFiles.size,
      size_outlier_share_of_lines: totalLines > 0 ? Number((sizeOutlierLines / totalLines).toFixed(4)) : 0,
      churn_outlier_file_count: churnOutlierFiles.size,
      churn_outlier_share_of_commits: totalCommits90d > 0 ? Number((churnOutlierCommits / totalCommits90d).toFixed(4)) : 0,
    },
    findings,
    file_stats: fileStats.slice(0, 50),
  };
}
