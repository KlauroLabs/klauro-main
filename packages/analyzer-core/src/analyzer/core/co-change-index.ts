


















import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';






export interface CoChangePartner {

  file: string;

  probability: number;

  support: number;



  lift: number;
}











export type CoChangeIndex = Record<string, CoChangePartner[]>;

export interface CoChangeAggregationOptions {


  minSupport?: number;


  minLift?: number;



  topK?: number;





  maxFilesPerCommit?: number;




  laplaceAlpha?: number;
}

const DEFAULT_OPTIONS: Required<CoChangeAggregationOptions> = {
  minSupport: 3,
  minLift: 2,
  topK: 10,
  maxFilesPerCommit: 50,
  laplaceAlpha: 1,
};





























export function aggregateCoChange(
  commitFileSets: string[][],
  options: CoChangeAggregationOptions = {}
): CoChangeIndex {
  const opts = { ...DEFAULT_OPTIONS, ...options };




  const commits: string[][] = [];
  for (const files of commitFileSets) {
    const unique = [...new Set(files)];
    if (unique.length === 0 || unique.length > opts.maxFilesPerCommit) continue;
    commits.push(unique);
  }

  const totalCommits = commits.length;
  const commitCount = new Map<string, number>();
  const pairCount = new Map<string, Map<string, number>>();

  const bump = (a: string, b: string) => {
    let inner = pairCount.get(a);
    if (!inner) {
      inner = new Map();
      pairCount.set(a, inner);
    }
    inner.set(b, (inner.get(b) ?? 0) + 1);
  };

  for (const files of commits) {
    for (const f of files) {
      commitCount.set(f, (commitCount.get(f) ?? 0) + 1);
    }


    for (let i = 0; i < files.length; i++) {
      for (let j = i + 1; j < files.length; j++) {
        bump(files[i], files[j]);
        bump(files[j], files[i]);
      }
    }
  }

  if (totalCommits === 0) return {};

  const index: CoChangeIndex = {};

  for (const [a, partners] of pairCount) {
    const aCount = commitCount.get(a) ?? 0;
    const candidates: CoChangePartner[] = [];

    for (const [b, support] of partners) {
      if (support < opts.minSupport) continue;
      const bCount = commitCount.get(b) ?? 0;
      const probability = (support + opts.laplaceAlpha) / (aCount + opts.laplaceAlpha);
      const baseline = bCount / totalCommits;
      const lift = baseline > 0 ? probability / baseline : 0;
      if (lift <= opts.minLift) continue;
      candidates.push({ file: b, probability, support, lift });
    }

    if (candidates.length === 0) continue;

    candidates.sort((x, y) => {
      if (y.probability !== x.probability) return y.probability - x.probability;
      if (y.support !== x.support) return y.support - x.support;
      if (y.lift !== x.lift) return y.lift - x.lift;
      return x.file.localeCompare(y.file);
    });




    index[a] = candidates.slice(0, opts.topK);
  }

  return index;
}











export function parseNameOnlyLog(output: string): string[][] {
  const commits: string[][] = [];
  let current: string[] | null = null;

  for (const rawLine of output.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;



    if (/^[0-9a-f]{40}$/.test(line)) {
      if (current) commits.push(current);
      current = [];
      continue;
    }

    if (current) current.push(line);
  }
  if (current) commits.push(current);

  return commits;
}





export interface CoChangeSidecar {

  version: 1;


  head_commit: string;

  generated_at: string;

  commits_considered: number;

  files_indexed: number;


  options: Required<CoChangeAggregationOptions>;


  truncated: boolean;
  index: CoChangeIndex;
}

const DEFAULT_COMMIT_WINDOW = 500;

function runGit(projectPath: string, args: string[], maxBuffer = 50 * 1024 * 1024): string | null {
  try {
    return execFileSync('git', args, { cwd: projectPath, stdio: 'pipe', maxBuffer }).toString();
  } catch {
    return null;
  }
}










export function computeCoChangeIndexForRepo(
  projectPath: string,
  options: CoChangeAggregationOptions & { commitWindow?: number } = {}
): { index: CoChangeIndex; commitsConsidered: number; headCommit: string } | null {
  const headOut = runGit(projectPath, ['rev-parse', 'HEAD']);
  if (headOut === null) return null;
  const headCommit = headOut.trim();

  const commitWindow = options.commitWindow ?? DEFAULT_COMMIT_WINDOW;
  const logOut = runGit(projectPath, [
    'log',
    `-n`,
    String(commitWindow),
    '--format=%H',
    '--name-only',
  ]);
  if (logOut === null) return null;

  const commitFileSets = parseNameOnlyLog(logOut);
  const index = aggregateCoChange(commitFileSets, options);

  return { index, commitsConsidered: commitFileSets.length, headCommit };
}

function isTruncated(index: CoChangeIndex, topK: number): boolean {





  return Object.values(index).some((partners) => partners.length >= topK);
}

function sidecarPath(projectPath: string): string {
  return path.join(projectPath, '.klauro', 'co-change-index.json');
}










export function writeCoChangeIndexSidecar(
  projectPath: string,
  options: CoChangeAggregationOptions & { commitWindow?: number } = {}
): CoChangeSidecar | null {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const computed = computeCoChangeIndexForRepo(projectPath, options);
  if (!computed) return null;

  const sidecar: CoChangeSidecar = {
    version: 1,
    head_commit: computed.headCommit,
    generated_at: new Date().toISOString(),
    commits_considered: computed.commitsConsidered,
    files_indexed: Object.keys(computed.index).length,
    options: opts,
    truncated: isTruncated(computed.index, opts.topK),
    index: computed.index,
  };

  try {
    const dir = path.dirname(sidecarPath(projectPath));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(sidecarPath(projectPath), JSON.stringify(sidecar), 'utf8');
  } catch {


  }

  return sidecar;
}


export function readCoChangeIndexSidecar(projectPath: string): CoChangeSidecar | null {
  try {
    const raw = fs.readFileSync(sidecarPath(projectPath), 'utf8');
    const parsed = JSON.parse(raw) as CoChangeSidecar;
    if (parsed && parsed.version === 1 && parsed.index) return parsed;
    return null;
  } catch {
    return null;
  }
}

const inMemoryCache = new Map<string, CoChangeSidecar>();









export function getOrComputeCoChangeIndex(
  projectPath: string,
  options: CoChangeAggregationOptions & { commitWindow?: number } = {}
): CoChangeIndex | null {
  const headOut = runGit(projectPath, ['rev-parse', 'HEAD']);
  if (headOut === null) return null;
  const headCommit = headOut.trim();

  const cached = inMemoryCache.get(projectPath);
  if (cached && cached.head_commit === headCommit) return cached.index;

  const onDisk = readCoChangeIndexSidecar(projectPath);
  if (onDisk && onDisk.head_commit === headCommit) {
    inMemoryCache.set(projectPath, onDisk);
    return onDisk.index;
  }

  const written = writeCoChangeIndexSidecar(projectPath, options);
  if (!written) return null;
  inMemoryCache.set(projectPath, written);
  return written.index;
}










export function lookupCoChangeProbability(
  index: CoChangeIndex,
  fileA: string,
  fileB: string
): CoChangePartner | undefined {
  const forward = index[fileA]?.find((p) => p.file === fileB);
  const backward = index[fileB]?.find((p) => p.file === fileA);
  if (forward && backward) return forward.probability >= backward.probability ? forward : backward;
  return forward ?? backward;
}
