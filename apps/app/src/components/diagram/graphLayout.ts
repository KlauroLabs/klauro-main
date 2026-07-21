/** Deterministic node/edge layout, generalized from src/components/entities/
 *  erdLayout.ts (extracted per LANE-COMMON's file-discipline note — erdLayout
 *  now delegates its node positioning here rather than duplicating the
 *  column/cluster algorithm). No force-directed/heavy graph library, per the
 *  design language ("SVG with the stroke system... deterministic layout,
 *  cluster by module when large"). Pure function of its inputs: identical
 *  nodes always produce identical positions, so every consumer (ERD, the
 *  workspace system map, the codebase architecture diagram) renders stably
 *  across re-renders and screenshots.
 *
 *  Domain-specific concerns (what an edge's `type`/`field` means, how a
 *  cluster key is derived from a source path, etc.) stay in the caller —
 *  this module only knows about generic nodes with an optional cluster/
 *  weight and positions them into columns. */

export interface GraphNode {
  id: string;
  label: string;
  cluster?: string;
  /** Drives per-node height, e.g. a field count or member count — purely a
   *  sizing hint, never a truth claim about relationships. */
  weight?: number;
  /** Optional second line of text under the label (e.g. a kind/domain tag).
   *  Purely presentational — never affects layout. */
  subtitle?: string;
}

export interface PositionedGraphNode extends GraphNode {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface GraphLayoutCluster {
  name: string;
  x: number;
  width: number;
}

export interface GraphNodeLayout {
  nodes: PositionedGraphNode[];
  clusters: GraphLayoutCluster[];
  width: number;
  height: number;
}

export interface GraphLayoutOptions {
  nodeWidth?: number;
  headerHeight?: number;
  weightRowHeight?: number;
  minHeight?: number;
  maxHeight?: number;
  gapY?: number;
  clusterGapX?: number;
  clusterLabelHeight?: number;
  margin?: number;
  /** Above this many nodes, group columns by `cluster` rather than one flat
   *  column — "cluster by module when large" (LANE-COMMON). */
  clusterThreshold?: number;
}

const DEFAULTS: Required<GraphLayoutOptions> = {
  nodeWidth: 200,
  headerHeight: 32,
  weightRowHeight: 4,
  minHeight: 44,
  maxHeight: 96,
  gapY: 24,
  clusterGapX: 72,
  clusterLabelHeight: 28,
  margin: 24,
  clusterThreshold: 10,
};

/** Build a column-based layout for a set of nodes. When `nodes.length` is at
 *  or under `clusterThreshold`, every node shares one unlabeled column
 *  ("all"); above it, nodes group into one column per distinct `cluster`
 *  value (alphabetical), with `cluster ?? 'other'` an honest bucket for
 *  nodes that don't carry one, never a guess. */
export function computeGraphNodeLayout(nodes: GraphNode[], options: GraphLayoutOptions = {}): GraphNodeLayout {
  const o = { ...DEFAULTS, ...options };

  const useClusters = nodes.length > o.clusterThreshold;
  const clusterNames = useClusters ? Array.from(new Set(nodes.map(n => n.cluster ?? 'other'))).sort() : ['all'];

  const byCluster = new Map<string, GraphNode[]>();
  for (const node of nodes) {
    const cluster = useClusters ? (node.cluster ?? 'other') : 'all';
    const list = byCluster.get(cluster);
    if (list) list.push(node);
    else byCluster.set(cluster, [node]);
  }
  for (const list of byCluster.values()) list.sort((a, b) => a.label.localeCompare(b.label));

  const positioned: PositionedGraphNode[] = [];
  const clusters: GraphLayoutCluster[] = [];
  let x = o.margin;
  let maxColumnHeight = 0;

  for (const clusterName of clusterNames) {
    const members = byCluster.get(clusterName) ?? [];
    let y = o.margin + (useClusters ? o.clusterLabelHeight : 0);
    for (const node of members) {
      const height = Math.min(o.maxHeight, Math.max(o.minHeight, o.headerHeight + (node.weight ?? 0) * o.weightRowHeight));
      positioned.push({ ...node, x, y, width: o.nodeWidth, height });
      y += height + o.gapY;
    }
    clusters.push({ name: clusterName, x, width: o.nodeWidth });
    maxColumnHeight = Math.max(maxColumnHeight, y);
    x += o.nodeWidth + o.clusterGapX;
  }

  return {
    nodes: positioned,
    clusters,
    width: x - o.clusterGapX + o.margin,
    height: maxColumnHeight + o.margin,
  };
}

/** An edge is only drawable once both endpoints are placed — a caller with a
 *  wider dataset than the diagrammed set (e.g. an edge to an entity outside
 *  the current view) should drop it rather than draw a dangling line. */
export function filterEdgesToKnownNodes<E extends { source: string; target: string }>(
  edges: E[],
  nodeIds: ReadonlySet<string>,
): E[] {
  return edges.filter(e => nodeIds.has(e.source) && nodeIds.has(e.target));
}
