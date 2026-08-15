
















import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { listAnalyses, type AnalysisEntry } from '../storage';
import type { RepoFact } from './projection-model';

const FIXTURE_RE = /(^|\/)(fixtures?|__fixtures__|test[-_]?fixtures|analysis-truth|testdata|node_modules)(\/|$)/;




const TRANSIENT_RE = /(greenfield|from-zero|scratch-build|scratch-dogfood|live-trial|live-trials|machine-proof|incremental-benchmark|preview-iteration|build-memory|build-out|build-relevance|domain-folder|adjacent-|growing-|-preview-|^with[-_]klauro$|^without[-_]klauro$|gauntlet-soon|gauntlet-zerac|gauntlet-klauro)/i;

const EPHEMERAL_SUFFIX_RE = /-(?=[a-z0-9]*[A-Z])[A-Za-z0-9]{6,10}$/;

function isTransientArtifact(e: AnalysisEntry): boolean {
  const p = e.path.replace(/\\/g, '/');
  return TRANSIENT_RE.test(e.name) || TRANSIENT_RE.test(p) || EPHEMERAL_SUFFIX_RE.test(e.name);
}

export interface WorkspaceFact {

  name: string;
  repos: RepoFact[];
  total_nodes: number;

  unresolved: string[];

  source_file: string;
}

export interface Corpus {

  repos: RepoFact[];

  workspaces: WorkspaceFact[];
  total_unique_repos: number;
  total_analyses: number;
}



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


function candidateRepoNames(member: string, product: string): string[] {
  const names = new Set<string>([member]);
  const prefix = `${product}-`;
  if (member.startsWith(prefix)) names.add(member.slice(prefix.length));

  const parts = member.split('-');
  if (parts.length > 1) names.add(parts.slice(1).join('-'));
  return [...names];
}






export async function discoverWorkspaces(entries: AnalysisEntry[]): Promise<WorkspaceFact[]> {
  const dir = workspaceAnalysesDir();
  let files: string[] = [];
  try { files = (await fs.readdir(dir)).filter(f => f.endsWith('.json')); } catch { return []; }

  const byNameSize = new Map<string, AnalysisEntry>();
  for (const e of entries) {
    const cur = byNameSize.get(e.name);
    if (!cur || cur.node_count < e.node_count) byNameSize.set(e.name, e);
  }


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
    if (members.length < 2) continue;

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
