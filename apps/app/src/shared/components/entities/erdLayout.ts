import type { DataEntity, DatabaseEntity, DatabaseRelationshipType } from '@/shared/hooks/useEntities';
import { computeGraphNodeLayout, type GraphNode } from '@/shared/components/diagram/graphLayout';

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

export function clusterKeyFor(sourcePath: string | undefined): string {
  if (!sourcePath) return 'other';
  const segments = sourcePath.split('/').slice(0, -1);
  const srcIndex = segments.lastIndexOf('src');
  const afterSrc = srcIndex >= 0 ? segments.slice(srcIndex + 1) : segments;
  const tail = afterSrc.slice(-2);
  return tail.length ? tail.join('/') : 'other';
}

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
      if (!targetId || !nodeById.has(targetId) || !nodeById.has(entity.id)) continue;
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
