import type { DataEntity, DatabaseEntity, DatabaseRelationshipType } from '../../hooks/useEntities';
import { computeGraphNodeLayout, type GraphNode } from '../diagram/graphLayout';

/** Deterministic ERD layout — no force-directed/heavy graph library per
 *  LANE-COMMON's stroke/geometry system ("SVG with the stroke system... NOT
 *  a heavy graph lib; deterministic layout, cluster by module when large").
 *  Pure function of its inputs: same entities + relationships always produce
 *  the same node positions, so the diagram is stable across re-renders and
 *  screenshots. Node POSITIONING (columns/clustering/height-from-weight) is
 *  delegated to the shared src/components/diagram/graphLayout.ts util (built
 *  for the clickables-diagrams lane's workspace-map/architecture diagrams);
 *  this file keeps the ERD-specific concerns: cluster-key derivation from a
 *  schema source path, and edge construction from database_schema
 *  relationships (a shape graphLayout.ts deliberately knows nothing about). */

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

/** Build the node/edge/cluster layout for a set of entities. `relationsByName`
 *  supplies each entity's outgoing relationships (already joined from
 *  database_schema by the caller); edges to a target outside `entities` are
 *  dropped (the diagram only draws what it can place). Node positioning is
 *  computed by the shared graphLayout util; this function's own job is
 *  mapping entities into generic GraphNodes (weight = field count, for the
 *  same per-field height growth the original bespoke algorithm had) and
 *  building the ERD-specific typed edges. */
export function computeErdLayout(
  entities: DataEntity[],
  databaseEntityByNameLower: Map<string, DatabaseEntity>,
): ErdLayout {
  const nameLowerToId = new Map(entities.map(e => [e.name.toLowerCase(), e.id]));

  const graphNodes: GraphNode[] = entities.map(entity => {
    const dbEntity = databaseEntityByNameLower.get(entity.name.toLowerCase());
    return {
      id: entity.id,
      label: entity.name,
      cluster: clusterKeyFor(dbEntity?.source_file ?? entity.schema_source),
      weight: entity.fields?.length ?? 0,
    };
  });

  const positioned = computeGraphNodeLayout(graphNodes);
  const nodes: ErdNode[] = positioned.nodes.map(n => ({
    id: n.id,
    name: n.label,
    cluster: n.cluster ?? 'all',
    fieldCount: n.weight ?? 0,
    x: n.x,
    y: n.y,
    width: n.width,
    height: n.height,
  }));

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
    clusters: positioned.clusters,
    width: positioned.width,
    height: positioned.height,
  };
}
