import type { EntryPoint } from '../../hooks/useEntryPoints';
import type { DasUnitSummary } from './dasIndex';
import type { CasNode, DataEntity } from './dasTypes';

/**
 * Per-unit slice built from what GET /api/projects/:id/cas already exposes
 * (repo-wide entry_points/nodes/data_entities), scoped by matching against
 * this unit's `member_deployable_ids` / root paths. This is root-path/id
 * attribution, NOT the true DAS reachability-closure slice (which also
 * walks the call graph and tags cross-unit shared code) — the das-scoped
 * MCP tool (get_summary with a `scope`) is the source of truth for that and
 * isn't exposed over HTTP yet. Counts here can differ slightly from the
 * MCP-scoped view for that reason; every section that reads this says so.
 */

export interface UnitCapability {
  capability_id: string;
  capability_name: string;
  role: string;
}

export function scopeEntryPoints(allEntryPoints: EntryPoint[], unit: DasUnitSummary): EntryPoint[] {
  const ids = new Set(unit.member_deployable_ids);
  return allEntryPoints.filter(ep => ep.deployable_id && ids.has(ep.deployable_id));
}

export function scopeCapabilities(scopedEntryPoints: EntryPoint[]): UnitCapability[] {
  const byId = new Map<string, UnitCapability>();
  for (const ep of scopedEntryPoints) {
    for (const cap of ep.capabilities ?? []) {
      if (!byId.has(cap.capability_id)) {
        byId.set(cap.capability_id, { capability_id: cap.capability_id, capability_name: cap.capability_name, role: cap.role });
      }
    }
  }
  return Array.from(byId.values()).sort((a, b) => a.capability_name.localeCompare(b.capability_name));
}

function isPathPrefix(rootPath: string, filePath: string): boolean {
  if (!rootPath || rootPath === '.') return true;
  if (filePath === rootPath) return true;
  return filePath.startsWith(`${rootPath}/`);
}

function underAnyRoot(filePath: string, roots: string[]): boolean {
  return roots.some(root => isPathPrefix(root, filePath));
}

/** Distinct source files reachable under this unit's root + member roots,
 *  read directly off CASOutput.nodes[].source.file — a directory-prefix
 *  view, not a reachability closure. */
export function scopeFiles(nodes: CasNode[], unit: DasUnitSummary): string[] {
  const roots = [unit.root_path, ...unit.member_root_paths];
  const files = new Set<string>();
  for (const n of nodes) {
    const file = n.source?.file;
    if (file && underAnyRoot(file, roots)) files.add(file);
  }
  return Array.from(files).sort();
}

/** A data entity is scoped to this unit when ANY node in its lifecycle
 *  (created/read/updated/deleted by) resolves to a file under the unit's
 *  roots. Same directory-prefix caveat as scopeFiles. */
export function scopeEntities(entities: DataEntity[], nodesById: Map<string, CasNode>, unit: DasUnitSummary): DataEntity[] {
  const roots = [unit.root_path, ...unit.member_root_paths];
  return entities.filter(entity => {
    const refs = [...entity.lifecycle.created_by, ...entity.lifecycle.read_by, ...entity.lifecycle.updated_by, ...entity.lifecycle.deleted_by];
    return refs.some(nodeId => {
      const file = nodesById.get(nodeId)?.source?.file;
      return file && underAnyRoot(file, roots);
    });
  });
}

export function buildNodesById(nodes: CasNode[]): Map<string, CasNode> {
  return new Map(nodes.map(n => [n.id, n]));
}
