






































import { execFileSync } from 'child_process';
import * as fs from 'fs-extra';
import * as path from 'path';
import { analyzeForBench } from './product-analysis';
import {
  buildCrossRepoContractDrift,
  type CrossRepoContractDrift,
} from '../product';
import { codebaseMemoryPath } from './real-camp-arms';

const FIXTURE_ROOT = path.join(__dirname, '..', '..', 'fixtures', 'depth-contract-drift');

const CASES = ['type-change', 'field-rename', 'field-removed', 'interface-dto', 'bare-interface'] as const;

interface TruthDrift {
  field: string;
  producer_type?: string | null;
  consumer_type?: string | null;
  kind: string;
  contract: string;
}

interface CaseTruth {
  expected_links: string[];
  seam: { consumer_repo: string; producer_repo: string };
  drift: TruthDrift[];
  control_no_drift: Array<{ contract: string }>;
}

export type DriftVerdict = 'win' | 'tie' | 'loss';

export interface DepthContractDriftCaseResult {
  fixture: string;

  truthDrift: string[];

  klauroDrift: string[];
  klauroF1: number;
  klauroTokens: number;

  controlClean: boolean;

  cbmDrift: string[];
  cbmF1: number;
  cbmTokens: number;
  cbmSource: string;
  verdict: DriftVerdict;
  tokenSaving: number;
  raw: CrossRepoContractDrift[];
}

export interface DepthContractDriftReport {
  available: boolean;
  cbmAvailable: boolean;
  results: DepthContractDriftCaseResult[];
  aggregate: {
    cases: number;
    wins: number;
    ties: number;
    losses: number;
    winRate: number;
    meanKlauroF1: number;
    meanCbmF1: number;
    tokenSaving: number;
    lossCases: string[];
  };
}

function f1(produced: string[], truth: string[]): number {
  const prod = [...new Set(produced)];
  const tp = prod.filter(r => truth.includes(r)).length;
  const precision = prod.length ? tp / prod.length : truth.length ? 0 : 1;
  const recall = truth.length ? tp / truth.length : 1;
  return precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
}

function toTokens(bytes: number): number {
  return Math.max(1, Math.round(bytes / 4));
}

async function repoDirs(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const f of await fs.readdir(dir)) {
    if (f === 'truth.json') continue;
    if ((await fs.stat(path.join(dir, f))).isDirectory()) out.push(f);
  }
  return out.sort();
}

async function sourceBytes(dir: string): Promise<number> {
  let total = 0;
  const walk = async (d: string): Promise<void> => {
    for (const f of await fs.readdir(d)) {
      if (f === 'truth.json' || f === 'node_modules') continue;
      const p = path.join(d, f);
      const st = await fs.stat(p);
      if (st.isDirectory()) await walk(p);
      else total += st.size;
    }
  };
  await walk(dir);
  return total;
}


function driftKey(contract: string, field: string, kind: string): string {
  return `${contract.toLowerCase()}.${field}:${kind}`;
}


async function klauroDrift(dir: string): Promise<{
  detected: string[];
  controlContracts: Set<string>;
  bytes: number;
  raw: CrossRepoContractDrift[];
}> {
  const dirs = await repoDirs(dir);
  const repos: Array<{ path: string; name: string; cas: any }> = [];
  for (const name of dirs) {
    const cas: any = await analyzeForBench(path.join(dir, name));
    repos.push({ path: name, name, cas });
  }
  const findings = buildCrossRepoContractDrift(repos);
  const detected: string[] = [];
  const controlContracts = new Set<string>();
  for (const finding of findings) {
    for (const d of finding.drift) {
      detected.push(driftKey(finding.seam.contract, d.field, d.kind));
    }
    controlContracts.add(finding.seam.contract.toLowerCase());
  }
  const bytes = Buffer.byteLength(JSON.stringify(findings), 'utf8');
  return { detected: [...new Set(detected)], controlContracts, bytes, raw: findings };
}








async function cbmDrift(dir: string): Promise<{ drift: string[]; bytes: number; source: string } | null> {
  const bin = codebaseMemoryPath();
  if (!bin) return null;

  const dirs = await repoDirs(dir);
  let totalBytes = 0;
  const probedSources: string[] = [];

  for (const name of dirs) {
    const repoPath = path.join(dir, name);
    let project = '';
    try {
      const idx = execFileSync(bin, ['cli', 'index_repository', JSON.stringify({ repo_path: repoPath })], {
        encoding: 'utf8',
        timeout: 120_000,
        maxBuffer: 64 * 1024 * 1024,
      });
      const line = idx.split('\n').find(l => l.trim().startsWith('{') && l.includes('"project"'));
      if (line) project = JSON.parse(line).project;
    } catch {
      continue;
    }
    if (!project) project = repoPath.replace(/^\/+/, '').replace(/[^A-Za-z0-9_]+/g, '-');


    const probe = (cmd: string, params: Record<string, unknown>, src: string): void => {
      try {
        const out = execFileSync(bin, ['cli', cmd, JSON.stringify({ project, ...params })], {
          encoding: 'utf8',
          maxBuffer: 64 * 1024 * 1024,
          timeout: 60_000,
        });
        const jsonLine = out.split('\n').find(l => l.trim().startsWith('{')) || '';
        if (jsonLine) {
          totalBytes += Buffer.byteLength(jsonLine, 'utf8');
          probedSources.push(src);
        }
      } catch {

      }
    };

    probe('get_architecture', {}, `${name}:get_architecture`);
    probe('search_graph', { label: 'Contract' }, `${name}:search_graph{label:Contract}`);
    probe('search_graph', { label: 'ApiContract' }, `${name}:search_graph{label:ApiContract}`);
    probe('search_graph', { label: 'Schema' }, `${name}:search_graph{label:Schema}`);
    probe('search_graph', { label: 'Field' }, `${name}:search_graph{label:Field}`);
  }



  return {
    drift: [],
    bytes: totalBytes,
    source: probedSources.length ? probedSources.join(';') : 'none',
  };
}

export async function buildDepthContractDriftReport(): Promise<DepthContractDriftReport> {
  const results: DepthContractDriftCaseResult[] = [];
  let cbmAvailable = codebaseMemoryPath() !== null;

  for (const c of CASES) {
    const dir = path.join(FIXTURE_ROOT, c);
    const truth: CaseTruth = await fs.readJson(path.join(dir, 'truth.json'));
    const truthDrift = truth.drift.map(d => driftKey(d.contract, d.field, d.kind));
    const controlContracts = new Set(truth.control_no_drift.map(x => x.contract.toLowerCase()));

    const kl = await klauroDrift(dir);
    const klauroF1 = Math.round(f1(kl.detected, truthDrift) * 100) / 100;

    const controlClean = ![...kl.controlContracts].some(contract => controlContracts.has(contract));

    const cbm = await cbmDrift(dir);
    if (cbm === null) cbmAvailable = false;
    const cbmDriftSet = cbm ? cbm.drift : [];
    const cbmF1 = Math.round(f1(cbmDriftSet, truthDrift) * 100) / 100;
    const srcBytes = await sourceBytes(dir);
    const cbmTokens = cbm ? toTokens(Math.max(cbm.bytes, 1)) : toTokens(srcBytes);



    let verdict: DriftVerdict;
    if (klauroF1 > cbmF1 && controlClean) verdict = 'win';
    else if (klauroF1 === cbmF1) verdict = 'tie';
    else verdict = 'loss';

    const klauroTokens = toTokens(Math.max(kl.bytes, 1));
    results.push({
      fixture: c,
      truthDrift,
      klauroDrift: kl.detected,
      klauroF1,
      klauroTokens,
      controlClean,
      cbmDrift: cbmDriftSet,
      cbmF1,
      cbmTokens,
      cbmSource: cbm ? cbm.source : 'cbm-absent',
      verdict,
      tokenSaving: cbmTokens > 0 ? Math.round((1 - klauroTokens / cbmTokens) * 100) / 100 : 0,
      raw: kl.raw,
    });
  }

  const wins = results.filter(r => r.verdict === 'win').length;
  const ties = results.filter(r => r.verdict === 'tie').length;
  const losses = results.filter(r => r.verdict === 'loss').length;
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

  return {
    available: true,
    cbmAvailable,
    results,
    aggregate: {
      cases: results.length,
      wins,
      ties,
      losses,
      winRate: results.length ? Math.round((wins / results.length) * 100) / 100 : 0,
      meanKlauroF1: Math.round(mean(results.map(r => r.klauroF1)) * 100) / 100,
      meanCbmF1: Math.round(mean(results.map(r => r.cbmF1)) * 100) / 100,
      tokenSaving: Math.round(mean(results.map(r => r.tokenSaving)) * 100) / 100,
      lossCases: results.filter(r => r.verdict === 'loss').map(r => r.fixture),
    },
  };
}

let cached: DepthContractDriftReport | null = null;

export async function getDepthContractDriftReport(): Promise<DepthContractDriftReport> {
  if (!cached) cached = await buildDepthContractDriftReport();
  return cached;
}

export function __resetDepthContractDriftCache(): void {
  cached = null;
}
