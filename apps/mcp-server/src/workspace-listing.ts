












export interface WorkspaceListEntry {
  id: string;
  name: string;
  generated_at?: string;
  saved_at?: string;
  codebase_count?: number;
  interface_count?: number;
  link_count?: number;
  unmatched_interface_count?: number;
  inputs?: Array<{ project_id?: string; codebase_id?: string; repo_path?: string; path?: string; cas_generated_at?: string }>;
  file: string;
}

export const WS_DEFAULT_LIMIT = 50;
export const WS_MAX_LIMIT = 200;

export type WorkspaceSort = 'repos' | 'recent' | 'name';

export interface ListWorkspaceQuery {
  limit?: number;
  offset?: number;

  name?: string;

  min_repos?: number;

  dedupe_by?: 'name' | 'none';

  sort?: WorkspaceSort;

  compact?: boolean;

  max_members?: number;
}

export interface CompactWorkspace {
  id: string;
  name: string;

  workspace: string;
  generated_at?: string;
  repo_count: number;
  interface_count?: number;
  link_count?: number;
  member_repos: string[];
  member_repos_truncated?: number;
  file: string;
}

export interface ListWorkspaceResult {
  total_indexed: number;
  matched: number;
  returned: number;
  offset: number;
  limit: number;
  has_more: boolean;
  next_offset: number | null;
  query: Partial<ListWorkspaceQuery>;
  hint?: string;
  workspaces: Array<CompactWorkspace | WorkspaceListEntry>;
}

function clamp(n: number | undefined, def: number, max: number): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) return def;
  return Math.max(1, Math.min(max, Math.floor(n)));
}








export function normalizeWorkspaceName(name: string): string {
  let n = (name || '').toLowerCase();
  n = n.replace(/^(?:gauntlet|spot)-/, '');
  n = n.replace(/-workspace$/, '');




  const stamp = n.match(/-([a-z0-9]{6,})-([a-z0-9]{4,})((?:-[a-z0-9]+)*)$/);
  if (stamp && typeof stamp.index === 'number') {
    const id = stamp[1] + stamp[2];
    const hasDigit = /\d/.test(id);


    const runIdShape = stamp[1].length === 8 && stamp[2].length === 5;
    if (hasDigit || runIdShape) n = n.slice(0, stamp.index);
  }

  n = n.replace(/-\d{10,}(?:-[a-z0-9]+)*$/, '');

  n = n.replace(/-ai-[a-z0-9]+$/, '');
  n = n.replace(/-ai$/, '');

  const parts = n.split('-');
  if (parts.length >= 2 && parts[0] === parts[1]) n = parts.slice(1).join('-');
  return n || (name || '').toLowerCase();
}

export function memberRepoNames(entry: WorkspaceListEntry): string[] {
  const inputs = entry.inputs || [];
  const names: string[] = [];
  for (const i of inputs) {
    const raw = i.project_id || i.codebase_id || i.repo_path || i.path || '';
    const name = String(raw).split(/[\\/]/).pop() || String(raw);
    if (name) names.push(name);
  }
  return names;
}

function repoCount(entry: WorkspaceListEntry): number {
  if (typeof entry.codebase_count === 'number' && entry.codebase_count > 0) return entry.codebase_count;
  return (entry.inputs || []).length;
}

function dedupeByName(entries: WorkspaceListEntry[]): WorkspaceListEntry[] {


  const best = new Map<string, WorkspaceListEntry>();
  for (const e of entries) {
    const key = normalizeWorkspaceName(e.name);
    const cur = best.get(key);
    if (!cur) { best.set(key, e); continue; }
    const richer = repoCount(e) > repoCount(cur);
    const sameButNewer = repoCount(e) === repoCount(cur) && tsOf(e) > tsOf(cur);
    if (richer || sameButNewer) best.set(key, e);
  }
  return [...best.values()];
}

function tsOf(e: WorkspaceListEntry): string {
  return e.generated_at || e.saved_at || '';
}

function compareBySort(sort: WorkspaceSort): (a: WorkspaceListEntry, b: WorkspaceListEntry) => number {
  switch (sort) {
    case 'name':
      return (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
    case 'recent':
      return (a, b) => tsOf(b).localeCompare(tsOf(a)) || a.name.localeCompare(b.name);
    case 'repos':
    default:
      return (a, b) => repoCount(b) - repoCount(a) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
  }
}

function toCompact(e: WorkspaceListEntry, maxMembers: number): CompactWorkspace {
  const all = memberRepoNames(e);
  const shown = all.slice(0, maxMembers);
  return {
    id: e.id,
    name: e.name,
    workspace: normalizeWorkspaceName(e.name),
    generated_at: tsOf(e) || undefined,
    repo_count: repoCount(e),
    interface_count: e.interface_count,
    link_count: e.link_count,
    member_repos: shown,
    ...(all.length > shown.length ? { member_repos_truncated: all.length - shown.length } : {}),
    file: e.file,
  };
}

export function listWorkspaceAnalysesFiltered(entries: WorkspaceListEntry[], rawQuery: ListWorkspaceQuery = {}): ListWorkspaceResult {
  const totalIndexed = entries.length;
  const limit = clamp(rawQuery.limit, WS_DEFAULT_LIMIT, WS_MAX_LIMIT);
  const offset = typeof rawQuery.offset === 'number' && rawQuery.offset > 0 ? Math.floor(rawQuery.offset) : 0;
  const sort: WorkspaceSort = rawQuery.sort || 'repos';
  const dedupe = rawQuery.dedupe_by || 'name';
  const compact = rawQuery.compact !== false;
  const maxMembers = clamp(rawQuery.max_members, 20, 200);

  const nameNeedle = rawQuery.name?.trim().toLowerCase();
  const minRepos = typeof rawQuery.min_repos === 'number' ? rawQuery.min_repos : undefined;

  let filtered = entries.filter(e => {
    if (nameNeedle) {
      const hay = `${e.name}\n${e.id}`.toLowerCase();
      if (!hay.includes(nameNeedle)) return false;
    }
    if (minRepos !== undefined && repoCount(e) < minRepos) return false;
    return true;
  });

  if (dedupe === 'name') filtered = dedupeByName(filtered);
  filtered.sort(compareBySort(sort));

  const matched = filtered.length;
  const page = filtered.slice(offset, offset + limit);
  const returned = page.length;
  const hasMore = offset + returned < matched;

  let hint: string | undefined;
  if (matched === 0) {
    hint = totalIndexed === 0
      ? 'No workspace analyses stored. Run run_workspace_analysis first.'
      : 'No workspaces matched. Loosen filters (drop name/min_repos).';
  } else if (hasMore) {
    hint = `${matched} matched; showing ${returned}. Page with offset=${offset + limit}.`;
  }

  return {
    total_indexed: totalIndexed,
    matched,
    returned,
    offset,
    limit,
    has_more: hasMore,
    next_offset: hasMore ? offset + limit : null,
    query: { sort, dedupe_by: dedupe, compact, ...stripUndefined(rawQuery) },
    ...(hint ? { hint } : {}),
    workspaces: page.map(e => (compact ? toCompact(e, maxMembers) : e)),
  };
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) (out as any)[k] = v;
  return out;
}
