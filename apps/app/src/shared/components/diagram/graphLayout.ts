export interface GraphNode {
  id: string;
  label: string;
  cluster?: string;

  weight?: number;

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

export function filterEdgesToKnownNodes<E extends { source: string; target: string }>(
  edges: E[],
  nodeIds: ReadonlySet<string>,
): E[] {
  return edges.filter(e => nodeIds.has(e.source) && nodeIds.has(e.target));
}
