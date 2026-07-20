import type { DataEntity, DatabaseEntity, DatabaseRelationshipType } from '../../hooks/useEntities';

/** Deterministic ERD layout — no force-directed/heavy graph library per
 *  LANE-COMMON's stroke/geometry system ("SVG with the stroke system... NOT
 *  a heavy graph lib; deterministic layout, cluster by module when large").
 *  Pure function of its inputs: same entities + relationships always produce
 *  the same node positions, so the diagram is stable across re-renders and
 *  screenshots. */

export interface ErdNode {
  id: string;
  name: string;
  cluster: string;
  fieldCount: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ErdEdge {
  id: string;
  source: string;
  target: string;
  type: DatabaseRelationshipType | string;
  field: string;
}

export interface ErdLayout {
  nodes: ErdNode[];
  edges: ErdEdge[];
  clusters: Array<{ name: string; x: number; width: number }>;
  width: number;
  height: number;
}

const NODE_WIDTH = 200;
const NODE_HEADER_HEIGHT = 32;
const NODE_ROW_HEIGHT = 4; // per-field height contribution, capped
const NODE_MIN_HEIGHT = 44;
const NODE_MAX_HEIGHT = 96;
const NODE_GAP_Y = 24;
const CLUSTER_GAP_X = 72;
const CLUSTER_LABEL_HEIGHT = 28;
const MARGIN = 24;
/** Above this many entities, group columns by module rather than one flat
 *  row — "cluster by module when large" (LANE-COMMON). */
const CLUSTER_THRESHOLD = 10;

/** Derive a stable module label from a schema_source path, e.g.
 *  "packages/analyzer-core/src/database/entities/analysis-result.entity.ts"
 *  -> "database/entities". Never fabricated — falls back to "other" when no
 *  source path is known (an honest bucket, not a guess). */
export function clusterKeyFor(sourcePath: string | undefined): string {
  if (!sourcePath) return 'other';
  const segments = sourcePath.split('/').slice(0, -1); // drop filename
  const srcIndex = segments.lastIndexOf('src');
  const afterSrc = srcIndex >= 0 ? segments.slice(srcIndex + 1) : segments;
  const tail = afterSrc.slice(-2);
  return tail.length ? tail.join('/') : 'other';
}

function nodeHeightFor(fieldCount: number): number {
  return Math.min(NODE_MAX_HEIGHT, Math.max(NODE_MIN_HEIGHT, NODE_HEADER_HEIGHT + fieldCount * NODE_ROW_HEIGHT));
}

/** Build the node/edge/cluster layout for a set of entities. `relationsByName`
 *  supplies each entity's outgoing relationships (already joined from
 *  database_schema by the caller); edges to a target outside `entities` are
 *  dropped (the diagram only draws what it can place). */
export function computeErdLayout(
  entities: DataEntity[],
  databaseEntityByNameLower: Map<string, DatabaseEntity>,
): ErdLayout {
  const nameLowerToId = new Map(entities.map(e => [e.name.toLowerCase(), e.id]));

  const clusterOf = new Map<string, string>();
  for (const entity of entities) {
    const dbEntity = databaseEntityByNameLower.get(entity.name.toLowerCase());
    clusterOf.set(entity.id, clusterKeyFor(dbEntity?.source_file ?? entity.schema_source));
  }

  const useClusters = entities.length > CLUSTER_THRESHOLD;
  const clusterNames = useClusters
    ? Array.from(new Set(clusterOf.values())).sort()
    : ['all'];

  const entitiesByCluster = new Map<string, DataEntity[]>();
  for (const entity of entities) {
    const cluster = useClusters ? clusterOf.get(entity.id)! : 'all';
    const list = entitiesByCluster.get(cluster);
    if (list) list.push(entity);
    else entitiesByCluster.set(cluster, [entity]);
  }
  for (const list of entitiesByCluster.values()) list.sort((a, b) => a.name.localeCompare(b.name));

  const nodes: ErdNode[] = [];
  const clusters: ErdLayout['clusters'] = [];
  let x = MARGIN;
  let maxColumnHeight = 0;

  for (const clusterName of clusterNames) {
    const members = entitiesByCluster.get(clusterName) ?? [];
    let y = MARGIN + (useClusters ? CLUSTER_LABEL_HEIGHT : 0);
    for (const entity of members) {
      const height = nodeHeightFor(entity.fields?.length ?? 0);
      nodes.push({
        id: entity.id,
        name: entity.name,
        cluster: clusterName,
        fieldCount: entity.fields?.length ?? 0,
        x,
        y,
        width: NODE_WIDTH,
        height,
      });
      y += height + NODE_GAP_Y;
    }
    clusters.push({ name: clusterName, x, width: NODE_WIDTH });
    maxColumnHeight = Math.max(maxColumnHeight, y);
    x += NODE_WIDTH + CLUSTER_GAP_X;
  }

  const nodeById = new Map(nodes.map(n => [n.id, n]));
  const edges: ErdEdge[] = [];
  let edgeSeq = 0;
  for (const entity of entities) {
    const dbEntity = databaseEntityByNameLower.get(entity.name.toLowerCase());
    for (const rel of dbEntity?.relationships ?? []) {
      const targetId = nameLowerToId.get(rel.target.toLowerCase());
      if (!targetId || !nodeById.has(targetId) || !nodeById.has(entity.id)) continue; // target outside this view
      edges.push({ id: `e${edgeSeq++}`, source: entity.id, target: targetId, type: rel.type, field: rel.field });
    }
  }

  return {
    nodes,
    edges,
    clusters,
    width: x - CLUSTER_GAP_X + MARGIN,
    height: maxColumnHeight + MARGIN,
  };
}
