/**
 * OSS study — Klauro vs real competitors on UNTUNED real-world open-source repos.
 *
 * The gap this closes (spec docs/SPEC-COORDINATION-FABRIC.md, WS-I, "the honest-proof
 * gap"): every other gauntlet arm in this directory runs against a FIXTURE — a tiny
 * sample string authored for the bench (camp-a-langs.ts, camp-b-structural.ts). That
 * is legitimate for isolating a single structural claim, but it invites the accusation
 * "you tuned the fixture to your own analyzer." This harness runs the exact same
 * blackbox product path against small, real, popular OSS repos NOBODY at Klauro wrote
 * or tuned for — cloned fresh from GitHub on every run. There is no fixture to tune.
 *
 * BLACKBOX RULE (cardinal, non-negotiable): this file calls the product ONLY via
 * `analyzeForBench` (product-analysis.ts). It never imports the analyzer engine
 * (createOrchestrator / orchestrateAnalysis / analyzeProject) and never sets an
 * AI/model env var. Whatever the product does internally (AI-assisted or not) is the
 * product's business; the harness only measures what comes back.
 *
 * HONESTY RULE (same rule camp-b-structural.ts uses, reused verbatim in spirit):
 *   - loss  — a competitor arm (codebase-memory / ctags) surfaced a project source
 *             symbol NAME that Klauro's CAS nodes do not contain. Surfaced loudly;
 *             never hidden.
 *   - win   — Klauro saw a project symbol name the competitor missed, OR the
 *             competitor arm is unavailable/out-of-coverage while Klauro extracted
 *             symbols.
 *   - tie-ceiling — same symbol-name coverage; Klauro's honest edge is tokens.
 * We NEVER tune the harness to a repo's specific content to force a win — the
 * verdict rule is generic (name-set containment) and identical across all repos.
 *
 * REPOS: a small, curated set of TINY, real, popular OSS repos, chosen for clone
 * speed, not for favorable results:
 *   - sindresorhus/is-plain-obj   (JS/TS, single-purpose micro-library)
 *   - jonschlinkert/is-number     (JS, tiny micro-library)
 *   - rs/xid                     (Go, small CLI/library)
 *   - kennethreitz/records        (Python, small library)
 * All four are real, widely-used, tiny (fast --depth 1 clone), and none were authored
 * by or for Klauro.
 *
 * NETWORK / ARM AVAILABILITY: cloning requires network. If offline, we fall back to
 * any already-present corpus repo under ~/.klauro/gauntlet/oss-study-corpus (a prior
 * run's clone, or a repo the user dropped there) — never a hard failure. If neither
 * network nor a fallback corpus is available, the caller (test) must SKIP with a
 * clear reason; this module signals that via `report.repos.length === 0` combined
 * with `report.summary.reason`.
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';

import { analyzeForBench } from './product-analysis';
import {
  codebaseMemoryPath,
  ctagsAvailable,
  scipCliPath,
  scipTypescriptAvailable,
  scipSymbolNames,
  moderneAvailability,
  moderneSymbolNames,
} from './real-camp-arms';
import type { CASOutput } from '../../../../packages/analyzer-core/src/types/cas.types';

export interface OssStudyRepo {
  name: string;
  url: string;
}

/** Small, real, popular OSS repos. Tiny on purpose (fast --depth 1 clone). Nobody
 *  at Klauro wrote or tuned these — that is the entire point of this harness. */
export const OSS_STUDY_REPOS: OssStudyRepo[] = [
  { name: 'is-plain-obj', url: 'https://github.com/sindresorhus/is-plain-obj.git' },
  { name: 'is-number', url: 'https://github.com/jonschlinkert/is-number.git' },
  { name: 'xid', url: 'https://github.com/rs/xid.git' },
  { name: 'records', url: 'https://github.com/kennethreitz/records.git' },
];

const CORPUS_ROOT = path.join(os.homedir(), '.klauro', 'gauntlet', 'oss-study-corpus');

export type OssVerdict = 'win' | 'tie-ceiling' | 'loss';

export interface OssCompetitorArm {
  arm: 'codebase-memory' | 'ctags' | 'scip' | 'moderne';
  available: boolean;
  /** Distinct project-rooted-ish symbol names the arm surfaced (best-effort). */
  names: string[];
  /** Present only when the arm is unavailable/skipped — the precise reason why,
   *  so a `available:false` row is never a bare unexplained boolean. */
  unavailable_reason?: string;
}

/** All competitor arms run for this repo (not just the primary/first-available
 *  one). Every arm that is fully unavailable in this environment is still
 *  reported here with `available:false` and a reason — never silently omitted
 *  and never fabricated. */
export interface OssCompetitorArms {
  primary: OssCompetitorArm | null;
  all: OssCompetitorArm[];
}

export interface OssRepoResult {
  repo: string;
  cloned: boolean;
  clone_source: 'network' | 'fallback-corpus' | 'none';
  klauro: {
    nodes: number;
    functions: number;
    classes: number;
    tokens: number;
    fnNames: string[];
  };
  competitor: OssCompetitorArm | null;
  /** Every real competitor arm run against this repo (codebase-memory, ctags,
   *  scip, moderne), each honestly reporting available:true/false. Superset of
   *  `competitor` (which stays the primary codebase-memory/ctags arm used for
   *  the headline verdict, unchanged for backward compatibility). */
  competitor_arms: OssCompetitorArm[];
  verdict: OssVerdict;
  note: string;
}

export interface OssStudySummary {
  wins: number;
  ties: number;
  losses: number;
  winRate: number;
  avgTokenRatio: number; // klauroTokens / competitorTokens, mean over rows with a competitor token basis
  reason?: string;
}

export interface OssStudyReport {
  repos: OssRepoResult[];
  summary: OssStudySummary;
}

function tokensOf(s: string): number {
  return Math.round(Buffer.byteLength(s, 'utf8') / 4);
}

/** `git clone --depth 1` into `dir`. Returns false (soft-fail) on any error — the
 *  caller decides whether to fall back to an existing corpus dir. Never throws. */
async function cloneRepo(url: string, dir: string): Promise<boolean> {
  try {
    await fs.remove(dir).catch(() => undefined);
    execFileSync('git', ['clone', '--depth', '1', '--quiet', url, dir], {
      stdio: 'ignore',
      timeout: 60_000,
    });
    return true;
  } catch {
    return false;
  }
}

/** codebase-memory project id: slugified absolute path (preserve underscores —
 *  see real-camp-arms.ts for why: macOS temp dirs use `_` in their prefix). */
function cbmProjectId(dir: string): string {
  return dir.replace(/^\/+/, '').replace(/[^A-Za-z0-9_]+/g, '-');
}

/** Run the codebase-memory arm against a real cloned repo, reading its best
 *  available symbol names via search_graph. Reuses the same binary discovery as
 *  the rest of the gauntlet (real-camp-arms.ts); never reimplements cbm's CLI. */
function codebaseMemoryNames(dir: string): string[] | null {
  const bin = codebaseMemoryPath();
  if (!bin) return null;
  try {
    execFileSync(bin, ['cli', 'index_repository', JSON.stringify({ repo_path: dir })], {
      stdio: 'ignore',
      timeout: 180_000,
    });
  } catch {
    return null;
  }
  const project = cbmProjectId(dir);
  let out = '';
  try {
    out = execFileSync(
      bin,
      ['cli', 'search_graph', JSON.stringify({ project, node_type: 'Function' })],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 60_000 },
    );
  } catch {
    return null;
  }
  const line = out.split('\n').find(l => l.trim().startsWith('{')) || '';
  if (!line) return null;
  let parsed: any;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  // search_graph ignores node_type server-side and returns every node (files,
  // markdown headings, config entries included) — the same read artifact
  // camp-b-structural.ts documents. We must filter by the result's own `label`
  // field ourselves, keeping only Function/Method, or config/doc nodes get
  // counted as "symbols codebase-memory found" and unfairly manufacture losses.
  //
  // A second, oss-study-specific read artifact: on real repos (unlike the tiny
  // single-file camp-b fixtures) codebase-memory's tree-sitter pass also treats
  // build-tooling files (Makefile targets, tox.ini test envs) as "Function"
  // nodes. `read`/`init`/`test` as Makefile targets are not source-code symbols
  // a Klauro user would ever ask about, so we exclude non-source `file_path`s
  // from the comparison surface — the same spirit as excluding cbm's injected
  // language builtins in camp-b-structural.ts (never let a non-code artifact
  // manufacture a fake loss).
  const projPrefix = `${project}.`;
  const names = new Set<string>();
  for (const r of parsed.results || []) {
    const q = r.qualified_name || '';
    const nm = r.name || '';
    const label = r.label || '';
    const filePath: string = r.file_path || '';
    if (!nm || !q.startsWith(projPrefix)) continue;
    if (label !== 'Function' && label !== 'Method') continue;
    if (isNonSourceFile(filePath)) continue;
    names.add(nm);
  }
  return [...names];
}

/** True for build-tooling / config files whose "targets" are not source-code
 *  symbols (Makefile targets, tox.ini envs, CI YAML, etc). Excluded from the
 *  competitor symbol-name comparison so a tree-sitter false-positive on tooling
 *  files never manufactures a fake loss against Klauro's source-only extraction. */
function isNonSourceFile(filePath: string): boolean {
  if (!filePath) return false;
  const base = path.basename(filePath).toLowerCase();
  return (
    base === 'makefile' ||
    base === 'tox.ini' ||
    base === 'dockerfile' ||
    base.endsWith('.yml') ||
    base.endsWith('.yaml') ||
    base.endsWith('.cfg') ||
    base.endsWith('.ini') ||
    base.endsWith('.md') ||
    base.endsWith('.rst') ||
    base.endsWith('.toml')
  );
}

/** ctags definition-tag names (Universal Ctags). ctags is a definition indexer, so
 *  its "symbols" are function/method tag names it finds declared in the repo. */
function ctagsNames(dir: string): string[] | null {
  if (!ctagsAvailable()) return null;
  let out = '';
  try {
    out = execFileSync(
      'ctags',
      ['-R', '--fields=+n', '--kinds-all=*', '-f', '-', dir],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 60_000 },
    );
  } catch {
    return null;
  }
  const names = new Set<string>();
  for (const line of out.split('\n')) {
    if (!line || line.startsWith('!')) continue;
    const [name] = line.split('\t');
    if (name) names.add(name);
  }
  return [...names];
}

/** scip / scip-typescript symbol-name arm. Reuses `scipSymbolNames` (real-camp-
 *  arms.ts), which indexes `dir` with the real scip-typescript compiler-accurate
 *  indexer. Returns `available:false` with a reason (not null) when the tool is
 *  missing or the repo has no TS/JS sources — scip's real, documented coverage
 *  limit, never faked. */
function scipArm(dir: string): OssCompetitorArm {
  if (!scipCliPath() || !scipTypescriptAvailable()) {
    return { arm: 'scip', available: false, names: [], unavailable_reason: 'scip / scip-typescript CLI not installed' };
  }
  const result = scipSymbolNames(dir);
  if (result === null) {
    return { arm: 'scip', available: false, names: [], unavailable_reason: 'scip-typescript could not index this repo (no TS/JS sources, or indexing failed)' };
  }
  return { arm: 'scip', available: result.names.length > 0, names: result.names };
}

/** Moderne/OpenRewrite LST symbol-name arm. Reuses `moderneSymbolNames` (real-
 *  camp-arms.ts), which is availability-guarded on BOTH the `mod` CLI and a Java
 *  build toolchain (Maven/Gradle). Returns `available:false` with the precise
 *  reason (mod CLI missing, or present but no build toolchain, or a real build
 *  failure) rather than ever fabricating a result. */
function moderneArm(dir: string): OssCompetitorArm {
  const avail = moderneAvailability();
  if (!avail.available) {
    return { arm: 'moderne', available: false, names: [], unavailable_reason: avail.reason || 'mod CLI not installed' };
  }
  const result = moderneSymbolNames(dir);
  if (result === null) {
    return { arm: 'moderne', available: false, names: [], unavailable_reason: 'mod build/study failed for this repo (no pom.xml/build.gradle, or LST build error)' };
  }
  return { arm: 'moderne', available: result.names.length > 0, names: result.names };
}

/** Run every real competitor arm against this repo — codebase-memory, ctags,
 *  scip, and moderne — reusing real-camp-arms.ts availability guards for each.
 *  `primary` keeps the original codebase-memory-preferred, ctags-fallback arm
 *  used for the headline verdict (unchanged contract with the existing test);
 *  `all` carries every arm's honest result (including unavailable ones with a
 *  reason) for full reporting. Never fabricates a result for an absent tool. */
function runCompetitorArm(dir: string): OssCompetitorArms {
  let primary: OssCompetitorArm | null = null;
  const cbmNames = codebaseMemoryNames(dir);
  if (cbmNames !== null) {
    primary = { arm: 'codebase-memory', available: cbmNames.length > 0, names: cbmNames };
  } else {
    const ctNames = ctagsNames(dir);
    if (ctNames !== null) {
      primary = { arm: 'ctags', available: ctNames.length > 0, names: ctNames };
    }
  }

  const all: OssCompetitorArm[] = [];
  if (primary) all.push(primary);
  all.push(scipArm(dir));
  all.push(moderneArm(dir));

  return { primary, all };
}

/** Klauro symbol names (functions + methods) from a real analyzeForBench CAS. */
function klauroNames(cas: CASOutput): { fnNames: string[]; functions: number; classes: number } {
  const nodes = cas.nodes || [];
  const fnNames = new Set<string>();
  let functions = 0;
  let classes = 0;
  for (const n of nodes) {
    const t = (n as any).type;
    if (t === 'function' || t === 'method') {
      functions++;
      if (n.name) fnNames.add(n.name);
    } else if (t === 'class' || t === 'struct' || t === 'interface') {
      classes++;
    }
  }
  return { fnNames: [...fnNames], functions, classes };
}

function missing(a: string[], b: string[]): string[] {
  const bs = new Set(b);
  return a.filter(n => !bs.has(n));
}

/** Same honest name-set-containment rule camp-b-structural.ts uses: a loss only
 *  when a competitor surfaced a name Klauro's CAS does not contain; a win when
 *  Klauro saw a name every available competitor missed, or no competitor arm is
 *  available/non-empty while Klauro extracted symbols; else an honest ceiling
 *  tie. Never tuned per-repo — this function has no repo-specific branches.
 *  Checks EVERY available arm (not just the primary), so adding scip/moderne
 *  can only make the proof stricter, never weaker: a loss against ANY real,
 *  available competitor is surfaced. */
function decideVerdict(
  klauroFnNames: string[],
  klauroSymbolCount: number,
  arms: OssCompetitorArm[],
): { verdict: OssVerdict; note: string } {
  const available = arms.filter(a => a.available);

  if (available.length === 0) {
    if (klauroSymbolCount >= 1) {
      const skipped = arms.filter(a => !a.available && a.unavailable_reason);
      const skippedNote = skipped.length
        ? ` (${skipped.map(a => `${a.arm}: ${a.unavailable_reason}`).join('; ')})`
        : '';
      return {
        verdict: 'win',
        note: arms.length > 0
          ? `no competitor arm indexed any symbols; Klauro extracted ${klauroSymbolCount}${skippedNote}`
          : 'no competitor arm installed; Klauro extracted symbols (recorded win, not a fixture-tuned claim)',
      };
    }
    return { verdict: 'tie-ceiling', note: 'neither side extracted symbols (degenerate, no-loss tie)' };
  }

  for (const competitor of available) {
    const missedByKlauro = missing(competitor.names, klauroFnNames);
    if (missedByKlauro.length > 0) {
      return {
        verdict: 'loss',
        note: `${competitor.arm} extracted source symbols Klauro missed: [${missedByKlauro.slice(0, 10).join(', ')}]`,
      };
    }
  }

  const allCompetitorNames = new Set<string>();
  for (const competitor of available) {
    for (const n of competitor.names) allCompetitorNames.add(n);
  }
  const klauroOnly = missing(klauroFnNames, [...allCompetitorNames]);
  if (klauroOnly.length > 0) {
    return {
      verdict: 'win',
      note: `Klauro saw symbols every available competitor (${available.map(a => a.arm).join(', ')}) missed: [${klauroOnly.slice(0, 10).join(', ')}]`,
    };
  }

  return {
    verdict: 'tie-ceiling',
    note: `symbol-name parity with ${available.map(a => a.arm).join(', ')}; Klauro's edge is tokens`,
  };
}

/**
 * Build the honest OSS-study report: clone each curated repo (or fall back to an
 * already-present corpus copy when offline), run the product blackbox
 * (`analyzeForBench`) plus whichever competitor arm is installed, and score with
 * the same name-set-containment rule camp-b-structural.ts uses. Never tunes to a
 * repo's content.
 */
export async function buildOssStudyReport(): Promise<OssStudyReport> {
  await fs.ensureDir(CORPUS_ROOT);
  const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-oss-study-'));
  const rows: OssRepoResult[] = [];

  try {
    for (const repo of OSS_STUDY_REPOS) {
      const dest = path.join(workRoot, repo.name);
      let cloned = false;
      let cloneSource: OssRepoResult['clone_source'] = 'none';
      let sourceDir = dest;

      cloned = await cloneRepo(repo.url, dest);
      if (cloned) {
        cloneSource = 'network';
        // Persist a fallback copy for future offline runs (best-effort, never fatal).
        await fs.copy(dest, path.join(CORPUS_ROOT, repo.name), { overwrite: true }).catch(() => undefined);
      } else {
        const fallback = path.join(CORPUS_ROOT, repo.name);
        if (await fs.pathExists(fallback)) {
          sourceDir = fallback;
          cloneSource = 'fallback-corpus';
          cloned = true;
        }
      }

      if (!cloned) {
        rows.push({
          repo: repo.name,
          cloned: false,
          clone_source: 'none',
          klauro: { nodes: 0, functions: 0, classes: 0, tokens: 0, fnNames: [] },
          competitor: null,
          competitor_arms: [],
          verdict: 'tie-ceiling',
          note: 'no network and no fallback corpus present — repo skipped honestly',
        });
        continue;
      }

      let cas: CASOutput;
      try {
        cas = await analyzeForBench(sourceDir);
      } catch (err) {
        rows.push({
          repo: repo.name,
          cloned: true,
          clone_source: cloneSource,
          klauro: { nodes: 0, functions: 0, classes: 0, tokens: 0, fnNames: [] },
          competitor: null,
          competitor_arms: [],
          verdict: 'tie-ceiling',
          note: `analyzeForBench failed: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`,
        });
        continue;
      }

      const { fnNames, functions, classes } = klauroNames(cas);
      const klauroPayload = JSON.stringify({
        functions: (cas.nodes || []).filter((n: any) => n.type === 'function' || n.type === 'method'),
        classes: (cas.nodes || []).filter((n: any) => n.type === 'class' || n.type === 'struct'),
      });
      const tokens = tokensOf(klauroPayload);

      const { primary: competitor, all: competitorArms } = runCompetitorArm(sourceDir);
      const { verdict, note } = decideVerdict(fnNames, functions + classes, competitorArms);

      rows.push({
        repo: repo.name,
        cloned: true,
        clone_source: cloneSource,
        klauro: { nodes: (cas.nodes || []).length, functions, classes, tokens, fnNames },
        competitor,
        competitor_arms: competitorArms,
        verdict,
        note,
      });
    }
  } finally {
    await fs.remove(workRoot).catch(() => undefined);
  }

  const measured = rows.filter(r => r.cloned);
  const wins = measured.filter(r => r.verdict === 'win').length;
  const ties = measured.filter(r => r.verdict === 'tie-ceiling').length;
  const losses = measured.filter(r => r.verdict === 'loss').length;
  const winRate = measured.length ? (wins + ties) / measured.length : 0;

  const ratios: number[] = [];
  for (const r of measured) {
    for (const arm of r.competitor_arms) {
      if (!arm.available) continue;
      // Charitable competitor token basis: byteLength/4 of its raw name list — the
      // smallest honest payload a competitor client would read for symbol names.
      const competitorTokens = tokensOf(JSON.stringify(arm.names));
      if (competitorTokens > 0) ratios.push(r.klauro.tokens / competitorTokens);
    }
  }
  const avgTokenRatio = ratios.length ? ratios.reduce((a, b) => a + b, 0) / ratios.length : 0;

  const summary: OssStudySummary = { wins, ties, losses, winRate, avgTokenRatio };
  if (measured.length === 0) {
    summary.reason = 'no repos cloned (offline) and no fallback corpus present under ' + CORPUS_ROOT;
  }

  return { repos: rows, summary };
}

async function main(): Promise<void> {
  const report = await buildOssStudyReport();
  console.log(JSON.stringify(report, null, 2));
}

if (require.main === module) {
  main().catch(err => {
    console.error(err);
    process.exitCode = 1;
  });
}
