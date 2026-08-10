/**
 * Corpus discovery — the real repos and workspaces this machine has analyzed.
 *
 * The machine holds ~2,800 unique analyzed repos and a handful of real product
 * workspaces (soon ~17 repos, zerac ~16 repos, klauro). The gauntlet must run
 * against THOSE, not a flat top-N aggregate:
 *   - single-repo scenarios   -> a diverse SAMPLE across size buckets, so the
 *                                 numbers reflect small/medium/large repos, not
 *                                 just the giants.
 *   - workspace / cross-repo  -> each REAL workspace, grounded in the summed
 *                                 sizes of its actual member repos.
 *
 * Read in-process via storage (the `list_analyses` / `list_workspace_analyses`
 * MCP tools currently blow the 20KB response budget and expose no narrowing
 * params — a noted product gap; in-process reads are the correct path here).
 */

import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { listAnalyses, type AnalysisEntry } from '../storage';
import type { RepoFact } from './projection-model';

const FIXTURE_RE = /(^|\/)(fixtures?|__fixtures__|test[-_]?fixtures|analysis-truth|testdata|node_modules)(\/|$)/;
/**
 * Transient analyses produced by the benchmark/preview machinery itself — not
 * real product repos. Excluded so corpus targets are always genuine codebases.
 */
const TRANSIENT_RE = /(greenfield|from-zero|scratch-build|scratch-dogfood|live-trial|live-trials|machine-proof|incremental-benchmark|preview-iteration|build-memory|build-out|build-relevance|domain-folder|adjacent-|growing-|-preview-|^with[-_]klauro$|^without[-_]klauro$|gauntlet-soon|gauntlet-zerac|gauntlet-klauro)/i;
/** Ephemeral run-id suffix (nanoid-like, contains an uppercase letter). */
const EPHEMERAL_SUFFIX_RE = /-(?=[a-z0-9]*[A-Z])[A-Za-z0-9]{6,10}$/;

function isTransientArtifact(e: AnalysisEntry): boolean {
  const p = e.path.replace(/\\/g, '/');
  return TRANSIENT_RE.test(e.name) || TRANSIENT_RE.test(p) || EPHEMERAL_SUFFIX_RE.test(e.name);
}

export interface WorkspaceFact {
  /** Product workspace name (e.g. soon, zerac, klauro). */
  name: string;
  repos: RepoFact[];
  total_nodes: number;
  /** Repo names declared by the workspace-level CAS that we could not match to a stored CAS. */
  unresolved: string[];
  /** The workspace-analysis file this was derived from. */
  source_file: string;
}

export interface Corpus {
  /** Deduped real single repos, largest first. */
  repos: RepoFact[];
  /** Real product workspaces with resolved member sizes. */
  workspaces: WorkspaceFact[];
  total_unique_repos: number;
  total_analyses: number;
}

/** All real (non-fixture, non-transient) unique repos, largest first — the full
 *  product corpus, not a sample. Exposed for the app's repo list. */
export function discoverAllRealRepoEntries(entries: AnalysisEntry[]): AnalysisEntry[] {
  return uniqueRealRepos(entries);
}

function uniqueRealRepos(entries: AnalysisEntry[]): AnalysisEntry[] {
  const real = entries.filter(e => e.node_count > 0 && !FIXTURE_RE.test(e.path.replace(/\\/g, '/')) && !isTransientArtifact(e));
  const byName = new Map<string, AnalysisEntry>();
  for (const e of real) {
    const cur = byName.get(e.name);
    if (!cur || cur.node_count < e.node_count) byName.set(e.name, e);
  }
  return [...byName.values()].sort((a, b) => b.node_count - a.node_count);
}

/**
 * Diverse sample across size buckets (large / medium / small) so single-repo
 * scenarios are not dominated by a few huge repos. Deterministic (no RNG).
 */
export function sampleDiverse(repos: AnalysisEntry[], limit: number): RepoFact[] {
  if (repos.length <= limit) return repos.map(toFact);
  const buckets = 3;
  const per = Math.ceil(limit / buckets);
  const third = Math.ceil(repos.length / buckets);
  const picked: AnalysisEntry[] = [];
  for (let b = 0; b < buckets; b++) {
    const slice = repos.slice(b * third, (b + 1) * third);
    const step = Math.max(1, Math.floor(slice.length / per));
    for (let i = 0; i < slice.length && picked.length < (b + 1) * per; i += step) picked.push(slice[i]);
  }
  return picked.slice(0, limit).map(toFact);
}

function toFact(e: AnalysisEntry): RepoFact {
  return { name: e.name, nodes: e.node_count, edges: e.edge_count };
}

function workspaceAnalysesDir(): string {
  return path.join(os.homedir(), '.klauro', 'analyses', 'workspace-analyses');
}

/** Strip a product prefix from a workspace-level-CAS-declared member name to match a stored CAS. */
function candidateRepoNames(member: string, product: string): string[] {
  const names = new Set<string>([member]);
  const prefix = `${product}-`;
  if (member.startsWith(prefix)) names.add(member.slice(prefix.length));
  // soon-soon-lens -> soon-lens (double-prefix), zerac-zerac-api -> zerac-api
  const parts = member.split('-');
  if (parts.length > 1) names.add(parts.slice(1).join('-'));
  return [...names];
}

/**
 * Discover real product workspaces. Groups the workspace-analysis files by
 * product prefix, takes the newest per product, and resolves each declared
 * member repo to a stored CAS so sizes are real.
 */
export async function discoverWorkspaces(entries: AnalysisEntry[]): Promise<WorkspaceFact[]> {
  const dir = workspaceAnalysesDir();
  let files: string[] = [];
  try { files = (await fs.readdir(dir)).filter(f => f.endsWith('.json')); } catch { return []; }

  const byNameSize = new Map<string, AnalysisEntry>();
  for (const e of entries) {
    const cur = byNameSize.get(e.name);
    if (!cur || cur.node_count < e.node_count) byNameSize.set(e.name, e);
  }

  // Group files by product prefix, recording size + mtime per file.
  const byProduct = new Map<string, Array<{ file: string; bytes: number; mtime: number }>>();
  for (const f of files) {
    const m = f.match(/^(?:gauntlet|spot)-([a-z0-9]+?)(?:-ai)?-/i) || f.match(/^([a-z0-9-]+?)-workspace/i);
    const product = (m ? m[1] : f.replace(/\.json$/, '')).toLowerCase();
    let st;
    try { st = await fs.stat(path.join(dir, f)); } catch { continue; }
    const arr = byProduct.get(product) || [];
    arr.push({ file: f, bytes: st.size, mtime: st.mtimeMs });
    byProduct.set(product, arr);
  }

  // The richest workspace for a product is the one declaring the most member
  // repos. Member count isn't known without reading, so per product we read a
  // bounded candidate set — the largest-by-bytes and newest files (a richer
  // workspace is also a bigger file) — and pick the one with the most members.
  // This avoids reading all ~700 files while still finding soon(17)/zerac(16).
  async function pickRichest(product: string): Promise<{ members: string[]; file: string } | null> {
    const arr = byProduct.get(product) || [];
    const byBytes = [...arr].sort((a, b) => b.bytes - a.bytes).slice(0, 6);
    const byNewest = [...arr].sort((a, b) => b.mtime - a.mtime).slice(0, 4);
    const candidates = [...new Map([...byBytes, ...byNewest].map(c => [c.file, c])).values()];
    let best: { members: string[]; file: string } | null = null;
    for (const c of candidates) {
      let j: any;
      try { j = await fs.readJson(path.join(dir, c.file)); } catch { continue; }
      const inputs: any[] = j.inputs || j.workspace?.inputs || j.summary?.inputs || [];
      const members: string[] = inputs
        .map(i => i.name || i.project_id || (i.repo_path || i.path || '').split('/').pop())
        .filter(Boolean);
      if (!best || members.length > best.members.length) best = { members, file: c.file };
    }
    return best;
  }

  const workspaces: WorkspaceFact[] = [];
  for (const product of byProduct.keys()) {
    const richest = await pickRichest(product);
    if (!richest) continue;
    const { members, file } = richest;
    if (members.length < 2) continue; // a "workspace" of one repo is just a repo

    const repos: RepoFact[] = [];
    const unresolved: string[] = [];
    for (const member of members) {
      let match: AnalysisEntry | undefined;
      for (const cand of candidateRepoNames(member, product)) {
        if (byNameSize.has(cand)) { match = byNameSize.get(cand); break; }
      }
      if (match) repos.push(toFact(match));
      else unresolved.push(member);
    }
    const total = repos.reduce((a, r) => a + r.nodes, 0);
    // Estimate sizes for unresolved members from the workspace mean so totals
    // are not understated when a member CAS is absent.
    const mean = repos.length ? total / repos.length : 1500;
    for (const u of unresolved) repos.push({ name: u, nodes: Math.round(mean), edges: 0 });

    workspaces.push({
      name: product,
      repos,
      total_nodes: repos.reduce((a, r) => a + r.nodes, 0),
      unresolved,
      source_file: file,
    });
  }

  return workspaces.sort((a, b) => b.repos.length - a.repos.length);
}

export async function discoverCorpus(opts: { maxRepos?: number } = {}): Promise<Corpus> {
  const entries = await listAnalyses();
  const uniq = uniqueRealRepos(entries);
  const repos = sampleDiverse(uniq, opts.maxRepos ?? 24);
  const workspaces = await discoverWorkspaces(entries);
  return {
    repos,
    workspaces,
    total_unique_repos: uniq.length,
    total_analyses: entries.length,
  };
}
