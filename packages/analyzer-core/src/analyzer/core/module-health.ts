/**
 * Module Health — "which parts of this system are dangerous to touch, and
 * why" (docs/SPEC-ABSTRACTION-TIERS.md Tier 2, §4: architecture/principles
 * adherence health — violations, overlap, drift). This module answers the
 * size/churn/coupling/mixed-concern slice of that question at FILE
 * granularity; layering/coupling/pattern-conflict findings already live in
 * principle_violations/architectural_conflicts (architectural-conflicts.ts)
 * and are cross-referenced here by file, never recomputed.
 *
 * COMPOSITION ONLY: every input below is already computed elsewhere in the
 * pipeline —
 *  - node counts + line spans per file: `nodes` (tier 1, node.source)
 *  - churn: `temporalStability` (built by buildTemporalStability from git)
 *  - fan-in: `edges` (tier 1 call/import graph)
 *  - capability anchors per file: `systemCapabilities[].operations` joined
 *    through `entryPoints` to `node.source.file`
 * This module adds no new evidence collection, only aggregation + statistics.
 *
 * THE HARD CONSTRAINT: no fixed thresholds ("files over N lines"). Every
 * finding is a file being a statistical OUTLIER within THIS codebase's own
 * distribution, so a 3,000-line file is a finding in a 200-line-median repo
 * and silence in a 2,500-line-median one. Method: median + MAD (median
 * absolute deviation), the standard robust (outlier-resistant) location/scale
 * pair — a single 30k-line file cannot drag the yardstick the way it would
 * drag a mean/stdev computation, which is exactly the failure mode a
 * god-file detector must not have. The modified z-score
 * (0.6745 * (x - median) / MAD, Iglewicz & Hoaglin 1993) is compared against
 * the conventional outlier threshold of 3.5. When MAD is degenerate (0 —
 * happens when most files cluster at an identical size/churn value, e.g. a
 * repo of near-identical small modules) the scale falls back to a
 * MAD-equivalent derived from the interquartile range (IQR / 1.349) so a
 * legitimately tight distribution still gets a working denominator instead
 * of an undefined or infinite z-score.
 *
 * BOTH EXTREMES MUST WORK: a tidy repo with no outliers returns an empty
 * `findings` array — never manufactured filler. A huge repo is not
 * truncated: every finding that clears the statistical bar is included
 * (findings are, by construction, a small minority of files).
 */

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

/** Minimum files for the distribution to be statistically meaningful — below
 *  this, "outlier" is not a meaningful concept (mirrors the
 *  COUPLING_MIN_NODES_FOR_SIGNAL convention in architectural-conflicts.ts). */
const MIN_FILES_FOR_SIGNAL = 10;

/** Iglewicz & Hoaglin (1993) conventional modified-z outlier threshold. */
const MODIFIED_Z_THRESHOLD = 3.5;

/** Edge types that count as "depends on" for file-level fan-in — the same
 *  call-ish family used by structural-importance.ts, plus imports. */
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

/** Robust dispersion estimate: MAD, with an IQR-derived fallback when MAD is
 *  degenerate (a tight/identical-valued distribution). 1.349 is the constant
 *  that makes IQR-derived scale consistent with MAD under a normal
 *  reference distribution — standard practice for this fallback. */
function robustScale(values: number[], med: number): number {
  const deviations = values.map(v => Math.abs(v - med));
  const mad = median(deviations);
  if (mad > 0) return mad;
  const sorted = [...values].sort((a, b) => a - b);
  const iqr = quantile(sorted, 0.75) - quantile(sorted, 0.25);
  return iqr > 0 ? iqr / 1.349 : 0;
}

/** Modified z-scores for a set of (file, value) pairs. Returns 0 for every
 *  entry when the distribution has no usable scale (all values identical) —
 *  that is the "no findings" case, not a divide-by-zero to guard against.
 *
 *  Computed on a cube-root transform of value, not the raw value.
 *  Lines/churn/fan-in are count-type metrics that span orders of magnitude
 *  in any real codebase
 *  (a repo mixes many tiny barrel/DTO files with a handful of large ones) —
 *  their distribution is right-skewed/multiplicative, not additive. Two
 *  transforms were measured against this codebase's own real file
 *  distribution (2,528 source files, task #122 verification run):
 *  - Raw (no transform): 3.5-threshold flagged ~24% of files as
 *    "size outliers" — every file even moderately above the ~70-line
 *    median of mostly-tiny (barrel/DTO) files. Noise, not "outliers named".
 *  - log1p: over-corrects the other way — orchestrator.ts (31,568 lines,
 *    the confirmed god file) scored only z=3.3, just UNDER the 3.5 bar.
 *  Cube root (Box-Cox lambda=1/3) is the standard variance-stabilizing
 *  transform for count/Poisson-like data (heavier-tailed than log1p's
 *  implicit lambda=0) and lands in between: it flagged 1.2% of files here
 *  while giving orchestrator.ts z=11.0 and the second-largest real god file
 *  in this repo (cross-codebase-analysis.ts, 14,005 lines) z=8.0 — both
 *  comfortably clear of the bar with headroom, and the flagged set stays a
 *  small, genuinely-exceptional minority rather than a quarter of the repo.
 *  `med`/`scale` are reported back on the transformed scale for provenance;
 *  findings report the raw metric_value for readability. */
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
    if (end > agg.lines) agg.lines = end; // max end_line ~= file length (tier-1 spans, no re-read of source)
  }

  if (byFile.size < MIN_FILES_FOR_SIGNAL) return undefined;

  // Fan-in: distinct SOURCE FILES with a dependency edge into any node whose
  // file is the target — file-to-file, so intra-file structure never counts
  // as coupling against itself.
  for (const edge of edges) {
    if (!DEPENDENCY_EDGE_TYPES.has(edge.type)) continue;
    const targetFile = nodeToFile.get(edge.target);
    const sourceFile = nodeToFile.get(edge.source);
    if (!targetFile || !sourceFile || targetFile === sourceFile) continue;
    const agg = byFile.get(targetFile);
    if (agg) agg.fanInFiles.add(sourceFile);
  }
  for (const agg of byFile.values()) agg.fanIn = agg.fanInFiles.size;

  // Churn: temporal_stability is already one row per node with file-level git
  // metrics duplicated across every node in that file — take the metrics once
  // per file rather than summing (summing would multiply a file's real churn
  // by its node count).
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

  // Capability anchors: operation -> entry point -> node -> file.
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

  // Layering violations composed in by file (not recomputed — cross-reference
  // only) so a size/churn/fan-in finding can note it co-occurs with an
  // already-detected layering break in the same file.
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

  // Composite "danger" score: rank-normalized (0..1) blend of size, churn,
  // fan-in — a file dangerous to touch is some combination of "big",
  // "constantly changing", and "everything depends on it", not any one alone.
  // Weighted toward churn+fan-in per the owner's framing (a huge untouched
  // file is lower risk than a medium one that is both hot and widely relied
  // on).
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

  // Report medians back on the RAW scale (expm1 of the log-space median) for
  // human-readable detail strings — the stats themselves stay log-space
  // internally (see modifiedZScores), this is display-only.
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
