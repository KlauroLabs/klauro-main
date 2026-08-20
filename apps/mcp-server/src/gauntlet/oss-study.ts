












































import { execFileSync } from 'child_process';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';

import { analyzeForBench } from './product-analysis';
import { devDataRoot } from './dev-data';
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



export const OSS_STUDY_REPOS: OssStudyRepo[] = [
  { name: 'is-plain-obj', url: 'https://github.com/sindresorhus/is-plain-obj.git' },
  { name: 'is-number', url: 'https://github.com/jonschlinkert/is-number.git' },
  { name: 'xid', url: 'https://github.com/rs/xid.git' },
  { name: 'records', url: 'https://github.com/kennethreitz/records.git' },
];



const CORPUS_ROOT = path.join(devDataRoot(), 'oss-study-corpus');

export type OssVerdict = 'win' | 'tie-ceiling' | 'loss' | 'unmeasured';

export interface OssCompetitorArm {
  arm: 'codebase-memory' | 'ctags' | 'scip' | 'moderne';
  available: boolean;

  names: string[];


  unavailable_reason?: string;
}





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




  competitor_arms: OssCompetitorArm[];
  verdict: OssVerdict;
  note: string;
}

export interface OssStudySummary {
  compared: number;
  unmeasured: number;
  wins: number;
  ties: number;
  losses: number;
  strictWinRate: number | null;
  nonLossRate: number | null;
  avgKlauroToCompetitorTokenRatio: number | null;
  tokenRatioComparedPairs: number;
  tokenRatioExcludedPairs: number;
  tokenRatioNote: string;
  reason?: string;
}

export interface OssStudyReport {
  repos: OssRepoResult[];
  summary: OssStudySummary;
}

function tokensOf(s: string): number {
  return Math.round(Buffer.byteLength(s, 'utf8') / 4);
}



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



function cbmProjectId(dir: string): string {
  return dir.replace(/^\/+/, '').replace(/[^A-Za-z0-9_]+/g, '-');
}




function codebaseMemoryNames(dir: string): string[] | null {
  const bin = codebaseMemoryPath();
  if (!bin) return null;
  const project = cbmProjectId(dir);
  try {
    execFileSync(bin, ['cli', 'index_repository', '--repo-path', dir, '--name', project], {
      stdio: 'ignore',
      timeout: 180_000,
    });
  } catch {
    return null;
  }
  let out = '';
  try {
    out = execFileSync(
      bin,
      ['cli', 'search_graph', '--project', project, '--format', 'json', '--limit', '100000'],
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














  const names = new Set<string>();
  for (const group of parsed.groups || []) {
    const filePath = String(group.file || '');
    if (!isRepositorySourceFile(dir, filePath)) continue;
    for (const row of group.rows || []) {
      const name = String(row[0] || '');
      const label = String(row[1] || '');
      if (name && (label === 'Function' || label === 'Method')) names.add(name);
    }
  }
  return [...names];
}





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

function isRepositorySourceFile(dir: string, filePath: string): boolean {
  if (!filePath || isNonSourceFile(filePath)) return false;
  const root = path.resolve(dir);
  const resolvedFile = path.resolve(root, filePath);
  if (!resolvedFile.startsWith(`${root}${path.sep}`)) return false;
  return fs.statSync(resolvedFile, { throwIfNoEntry: false })?.isFile() === true;
}



const CALLABLE_CTAG_KINDS = new Set([
  'function',
  'generator',
  'method',
  'procedure',
  'prototype',
  'subroutine',
]);

export function parseCallableCtags(output: string): string[] {
  const names = new Set<string>();
  for (const line of output.split('\n')) {
    if (!line.startsWith('{')) continue;
    let tag: Record<string, unknown>;
    try {
      tag = JSON.parse(line);
    } catch {
      continue;
    }
    const name = typeof tag.name === 'string' ? tag.name : '';
    const kind = typeof tag.kind === 'string' ? tag.kind.toLowerCase() : '';
    const filePath = typeof tag.path === 'string' ? tag.path : '';
    const extras = Array.isArray(tag.extras) ? tag.extras : String(tag.extras || '').split(',');
    const pattern = typeof tag.pattern === 'string' ? tag.pattern.replace(/^\/\^?/, '').replace(/\$\/$/, '') : '';
    const aliasesCallable = /=\s*[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\s*;?$/.test(pattern)
      && !/\bfunction\b|=>/.test(pattern);
    if (
      name
      && CALLABLE_CTAG_KINDS.has(kind)
      && !isNonSourceFile(filePath)
      && !extras.includes('anonymous')
      && !aliasesCallable
    ) names.add(name);
  }
  return [...names];
}

function ctagsNames(dir: string): string[] | null {
  if (!ctagsAvailable()) return null;
  let out = '';
  try {
    out = execFileSync(
      'ctags',
      ['-R', '--output-format=json', '--fields=+EK', '--kinds-all=*', '-f', '-', dir],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 60_000 },
    );
  } catch {
    return null;
  }
  return parseCallableCtags(out);
}






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







function runCompetitorArm(dir: string): OssCompetitorArms {
  const all: OssCompetitorArm[] = [];
  const cbmNames = codebaseMemoryNames(dir);
  if (cbmNames !== null) {
    all.push({ arm: 'codebase-memory', available: cbmNames.length > 0, names: cbmNames });
  }
  const ctNames = ctagsNames(dir);
  if (ctNames !== null) {
    all.push({ arm: 'ctags', available: ctNames.length > 0, names: ctNames });
  }
  all.push(scipArm(dir));
  all.push(moderneArm(dir));
  const primary = all.find(arm => arm.arm === 'codebase-memory')
    || all.find(arm => arm.arm === 'ctags')
    || null;
  return { primary, all };
}


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









function decideVerdict(
  klauroFnNames: string[],
  klauroSymbolCount: number,
  arms: OssCompetitorArm[],
): { verdict: OssVerdict; note: string } {
  const available = arms.filter(a => a.available);

  if (available.length === 0) {
    const skipped = arms.filter(a => !a.available && a.unavailable_reason);
    const skippedNote = skipped.length
      ? `: ${skipped.map(a => `${a.arm}: ${a.unavailable_reason}`).join('; ')}`
      : '';
    return {
      verdict: 'unmeasured',
      note: `no competitor arm produced a comparable result${skippedNote}; Klauro extracted ${klauroSymbolCount}`,
    };
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
    note: `symbol-name parity with ${available.map(a => a.arm).join(', ')}`,
  };
}

export function summarizeOssStudy(rows: OssRepoResult[]): OssStudySummary {
  const compared = rows.filter(row => row.cloned && row.verdict !== 'unmeasured');
  const wins = compared.filter(row => row.verdict === 'win').length;
  const ties = compared.filter(row => row.verdict === 'tie-ceiling').length;
  const losses = compared.filter(row => row.verdict === 'loss').length;
  const ratiosByRepo: number[] = [];
  let tokenRatioComparedPairs = 0;
  let tokenRatioExcludedPairs = 0;
  for (const row of compared) {
    const rowRatios: number[] = [];
    const klauroNames = [...new Set(row.klauro.fnNames)].sort();
    const klauroPayload = JSON.stringify(klauroNames);
    for (const arm of row.competitor_arms) {
      if (!arm.available) continue;
      const competitorNames = [...new Set(arm.names)].sort();
      if (
        klauroNames.length !== competitorNames.length
        || klauroNames.some((name, index) => name !== competitorNames[index])
      ) {
        tokenRatioExcludedPairs++;
        continue;
      }
      const klauroTokens = tokensOf(klauroPayload);
      const competitorTokens = tokensOf(JSON.stringify(competitorNames));
      if (klauroTokens > 0 && competitorTokens > 0) {
        rowRatios.push(klauroTokens / competitorTokens);
        tokenRatioComparedPairs++;
      }
    }
    if (rowRatios.length) {
      ratiosByRepo.push(rowRatios.reduce((left, right) => left + right, 0) / rowRatios.length);
    }
  }
  return {
    compared: compared.length,
    unmeasured: rows.filter(row => row.cloned && row.verdict === 'unmeasured').length,
    wins,
    ties,
    losses,
    strictWinRate: compared.length ? wins / compared.length : null,
    nonLossRate: compared.length ? (wins + ties) / compared.length : null,
    avgKlauroToCompetitorTokenRatio: ratiosByRepo.length
      ? ratiosByRepo.reduce((left, right) => left + right, 0) / ratiosByRepo.length
      : null,
    tokenRatioComparedPairs,
    tokenRatioExcludedPairs,
    tokenRatioNote: 'Token ratios include only arms returning the exact same normalized symbol set; differing coverage is excluded rather than presented as payload efficiency.',
  };
}








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
          verdict: 'unmeasured',
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
          verdict: 'unmeasured',
          note: `analyzeForBench failed: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`,
        });
        continue;
      }

      const { fnNames, functions, classes } = klauroNames(cas);
      const klauroPayload = JSON.stringify([...new Set(fnNames)].sort());
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

  const summary = summarizeOssStudy(rows);
  if (rows.every(row => !row.cloned)) {
    summary.reason = 'no repos cloned (offline) and no fallback corpus present under ' + CORPUS_ROOT;
  } else if (summary.compared === 0) {
    summary.reason = 'no competitor arm produced a comparable result';
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
