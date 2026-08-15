













import type { AnalysisEntry } from './storage';
import type { AnalysisTrack } from './track';

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 500;

export type AnalysisSort = 'nodes' | 'edges' | 'name' | 'recent';

export interface ListAnalysesQuery {

  limit?: number;

  offset?: number;

  name?: string;

  framework?: string;

  system_type?: string;

  min_nodes?: number;

  min_edges?: number;

  dedupe_by?: 'name' | 'path' | 'none';

  sort?: AnalysisSort;

  compact?: boolean;





  track?: AnalysisTrack;
}

export interface CompactAnalysis {
  name: string;
  path: string;
  system_type: string;
  frameworks: string[];
  node_count: number;
  edge_count: number;
  analyzed_at: string;
  cas_version?: string;

  track: AnalysisTrack;
}

export interface ListAnalysesResult {
  total_indexed: number;
  matched: number;
  returned: number;
  offset: number;
  limit: number;
  has_more: boolean;
  next_offset: number | null;
  query: Required<Pick<ListAnalysesQuery, 'sort' | 'dedupe_by' | 'compact'>> & Partial<ListAnalysesQuery>;

  hint?: string;
  analyses: Array<CompactAnalysis | AnalysisEntry>;
}

function clampLimit(limit: number | undefined): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit)));
}

function clampOffset(offset: number | undefined): number {
  if (typeof offset !== 'number' || !Number.isFinite(offset) || offset < 0) return 0;
  return Math.floor(offset);
}

function toCompact(e: AnalysisEntry): CompactAnalysis {
  return {
    name: e.name,
    path: e.path,
    system_type: e.system_type,
    frameworks: (e.frameworks || []).slice(0, 6),
    node_count: e.node_count,
    edge_count: e.edge_count,
    analyzed_at: e.analyzed_at,
    cas_version: e.cas_version,
    track: e.track ?? 'main',
  };
}

function dedupe(entries: AnalysisEntry[], by: 'name' | 'path'): AnalysisEntry[] {
  const best = new Map<string, AnalysisEntry>();
  for (const e of entries) {
    const key = by === 'name' ? e.name : e.path;
    const cur = best.get(key);
    if (!cur || cur.node_count < e.node_count) best.set(key, e);
  }
  return [...best.values()];
}

function compareBySort(sort: AnalysisSort): (a: AnalysisEntry, b: AnalysisEntry) => number {
  switch (sort) {
    case 'name':
      return (a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path);
    case 'edges':
      return (a, b) => b.edge_count - a.edge_count || a.name.localeCompare(b.name) || a.path.localeCompare(b.path);
    case 'recent':
      return (a, b) => (b.analyzed_at || '').localeCompare(a.analyzed_at || '') || a.name.localeCompare(b.name) || a.path.localeCompare(b.path);
    case 'nodes':
    default:
      return (a, b) => b.node_count - a.node_count || a.name.localeCompare(b.name) || a.path.localeCompare(b.path);
  }
}

export function listAnalysesFiltered(entries: AnalysisEntry[], rawQuery: ListAnalysesQuery = {}): ListAnalysesResult {
  const totalIndexed = entries.length;
  const limit = clampLimit(rawQuery.limit);
  const offset = clampOffset(rawQuery.offset);
  const sort: AnalysisSort = rawQuery.sort || 'nodes';
  const dedupeBy = rawQuery.dedupe_by || 'none';
  const compact = rawQuery.compact !== false;

  const nameNeedle = rawQuery.name?.trim().toLowerCase();
  const fwNeedle = rawQuery.framework?.trim().toLowerCase();
  const typeNeedle = rawQuery.system_type?.trim().toLowerCase();
  const minNodes = typeof rawQuery.min_nodes === 'number' ? rawQuery.min_nodes : undefined;
  const minEdges = typeof rawQuery.min_edges === 'number' ? rawQuery.min_edges : undefined;

  let filtered = entries.filter(e => {
    if (nameNeedle) {
      const hay = `${e.name}\n${e.path}`.toLowerCase();
      if (!hay.includes(nameNeedle)) return false;
    }
    if (fwNeedle) {
      const fws = (e.frameworks || []).map(f => f.toLowerCase());
      if (!fws.some(f => f.includes(fwNeedle))) return false;
    }
    if (typeNeedle && !(e.system_type || '').toLowerCase().includes(typeNeedle)) return false;
    if (minNodes !== undefined && e.node_count < minNodes) return false;
    if (minEdges !== undefined && e.edge_count < minEdges) return false;
    if (rawQuery.track && (e.track ?? 'main') !== rawQuery.track) return false;
    return true;
  });

  if (dedupeBy !== 'none') filtered = dedupe(filtered, dedupeBy);

  filtered.sort(compareBySort(sort));

  const matched = filtered.length;
  const page = filtered.slice(offset, offset + limit);
  const returned = page.length;
  const hasMore = offset + returned < matched;

  let hint: string | undefined;
  if (matched === 0) {
    hint = totalIndexed === 0
      ? 'No analyses stored. Run analyze_codebase on a repository first.'
      : 'No analyses matched. Loosen filters (drop name/framework/min_nodes) or check spelling.';
  } else if (hasMore) {
    hint = `${matched} matched; showing ${returned}. Page with offset=${offset + limit}, or narrow with name/framework/min_nodes/dedupe_by.`;
  } else if (matched > returned) {
    hint = `${matched} matched across ${Math.ceil(matched / limit)} pages.`;
  }

  return {
    total_indexed: totalIndexed,
    matched,
    returned,
    offset,
    limit,
    has_more: hasMore,
    next_offset: hasMore ? offset + limit : null,
    query: { sort, dedupe_by: dedupeBy, compact, ...stripUndefined(rawQuery) },
    ...(hint ? { hint } : {}),
    analyses: page.map(e => (compact ? toCompact(e) : e)),
  };
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) (out as any)[k] = v;
  }
  return out;
}
