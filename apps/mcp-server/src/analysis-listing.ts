/**
 * Narrowing, pagination, and compact projection for the analysis-listing MCP
 * tools (`list_analyses`, `list_workspace_analyses`).
 *
 * Why this exists: a real machine accumulates thousands of analyses (this one
 * has ~9,600). Returning them all blows the MCP response budget and is useless
 * to an agent. These tools must let an agent ASK for what it needs — by name,
 * size, framework — and page through results deterministically.
 *
 * Pure, validated, and unit-tested. No I/O here; callers pass the already-loaded
 * entries. Enterprise posture: every bound is clamped, ordering is total and
 * stable, and the response always tells the caller how to get the next page.
 */

import type { AnalysisEntry } from './storage';
import type { AnalysisTrack } from './track';

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 500;

export type AnalysisSort = 'nodes' | 'edges' | 'name' | 'recent';

export interface ListAnalysesQuery {
  /** Page size. Clamped to [1, MAX_LIMIT]. */
  limit?: number;
  /** Page offset. Negative values are treated as 0. */
  offset?: number;
  /** Case-insensitive substring matched against name AND path. */
  name?: string;
  /** Case-insensitive substring matched against any framework. */
  framework?: string;
  /** Case-insensitive substring matched against system_type. */
  system_type?: string;
  /** Keep only analyses with at least this many nodes. */
  min_nodes?: number;
  /** Keep only analyses with at least this many edges. */
  min_edges?: number;
  /** Collapse re-analyses: keep the largest entry per name or per path. */
  dedupe_by?: 'name' | 'path' | 'none';
  /** Sort key (default 'nodes' desc; 'name' asc; 'recent' by analyzed_at desc). */
  sort?: AnalysisSort;
  /** When false, return the full AnalysisEntry instead of the compact shape. */
  compact?: boolean;
  /**
   * Optional track filter. When set, keep only entries on this track. Omitted
   * (default) shows every track — backward compatible; nothing shown today is
   * hidden. Legacy entries with no track are treated as 'main'.
   */
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
  /** Which analysis track this entry belongs to. Legacy entries → 'main'. */
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
  /** Guidance the agent can act on when the match set is large or empty. */
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
