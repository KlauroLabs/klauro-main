





































































import * as fs from 'fs-extra';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { analyzeForBench } from './product-analysis';
import { diffBehavior } from '../../../../packages/analyzer-core/src/analyzer/core/behavior-diff';
import { codebaseMemoryPath } from './real-camp-arms';
import type { CASBehaviorDiff } from '../../../../packages/analyzer-core/src/types/cas.types';


export type BehavioralKind = 'auth-removed' | 'journey-broken' | 'capability-added';

interface BehavioralTruth {
  case: string;
  language: string;
  control: boolean;
  description: string;
  behavioral_changes: Array<{ kind: BehavioralKind; detail: string }>;
}

export type BehavioralDiffVerdict = 'win' | 'tie' | 'loss';

export interface DepthBehavioralDiffCaseResult {
  fixture: string;
  control: boolean;

  truthKinds: BehavioralKind[];

  klauroKinds: BehavioralKind[];

  klauroRiskFlags: string[];
  klauroF1: number;
  klauroTokens: number;

  cbmKinds: BehavioralKind[];
  cbmF1: number;
  cbmTokens: number;

  cbmDetectChanges: string;

  controlCleanByKlauro: boolean | null;
  verdict: BehavioralDiffVerdict;
  tokenSaving: number;
}

export interface DepthBehavioralDiffReport {
  available: boolean;

  klauroQueryPath: string;

  cbmQueryPath: string;
  results: DepthBehavioralDiffCaseResult[];
  aggregate: {
    cases: number;
    klauroWins: number;
    ties: number;
    losses: number;
    strictWinRate: number;
    nonLossRate: number;
    meanKlauroF1: number;
    meanCbmF1: number;
    tokenSaving: number;
    lossFixtures: string[];
  };
}

const FIXTURES = ['auth-removed', 'journey-broken', 'capability-added', 'control-rename'];

function f1(produced: string[], truth: string[]): number {
  const prod = [...new Set(produced)];
  const truthSet = [...new Set(truth)];
  const tp = prod.filter(r => truthSet.includes(r)).length;
  const precision = prod.length ? tp / prod.length : truthSet.length ? 0 : 1;
  const recall = truthSet.length ? tp / truthSet.length : 1;
  return precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
}

function toTokens(bytes: number): number {
  return Math.max(1, Math.round(bytes / 4));
}





function klauroKindsFromDiff(diff: CASBehaviorDiff): BehavioralKind[] {
  const kinds = new Set<BehavioralKind>();



  const lostGuard = diff.security.newly_unguarded_entries.some(e => e.reason === 'lost-guard');
  const changedLostAuth = diff.entry_point_flows.changed.some(c =>
    c.what.some(w => /lost auth boundary|removed security boundary/i.test(w)),
  );
  if (lostGuard || changedLostAuth || diff.security.boundaries_removed.length > 0) {
    kinds.add('auth-removed');
  }


  if (diff.entry_point_flows.removed.length > 0 || diff.entry_point_flows.changed.some(change =>
    change.what.some(item => item.startsWith("removed terminal entity"))
  )) kinds.add("journey-broken");





  if (diff.entry_point_flows.added.length > 0) {
    kinds.add('capability-added');
  }

  return [...kinds];
}






async function klauroBehavioralDiff(
  caseDir: string,
): Promise<{ kinds: BehavioralKind[]; riskFlags: string[]; bytes: number }> {
  const before: any = await analyzeForBench(path.join(caseDir, 'before'));
  const after: any = await analyzeForBench(path.join(caseDir, 'after'));
  const diff = diffBehavior(before, after);
  const kinds = klauroKindsFromDiff(diff);




  const payload = {
    behavioral_change_kinds: kinds,
    risk_flags: diff.summary.risk_flags,
    entry_point_flows: {
      added: diff.entry_point_flows.added.map(j => j.entry),
      removed: diff.entry_point_flows.removed.map(j => j.entry),
      changed: diff.entry_point_flows.changed,
    },
    security: {
      boundaries_removed: diff.security.boundaries_removed,
      newly_unguarded_entries: diff.security.newly_unguarded_entries,
    },
    capabilities: { added: diff.capabilities.added, removed: diff.capabilities.removed },
  };
  return {
    kinds,
    riskFlags: diff.summary.risk_flags,
    bytes: Buffer.byteLength(JSON.stringify(payload), 'utf8'),
  };
}










function cbmBehavioralDiff(
  caseDir: string,
): { kinds: BehavioralKind[]; detail: string; bytes: number } {
  const bin = codebaseMemoryPath();
  if (!bin) return { kinds: [], detail: 'cbm absent', bytes: 0 };

  const afterDir = path.join(caseDir, 'after');
  let project = '';
  try {
    const idx = execFileSync(bin, ['cli', 'index_repository', JSON.stringify({ repo_path: afterDir })], {
      encoding: 'utf8',
      timeout: 120_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    const line = idx.split('\n').find(l => l.trim().startsWith('{') && l.includes('"project"'));
    if (line) project = JSON.parse(line).project;
  } catch {
    return { kinds: [], detail: 'index failed', bytes: 0 };
  }
  if (!project) project = afterDir.replace(/^\/+/, '').replace(/[^A-Za-z0-9_]+/g, '-');

  const runTool = (tool: string): { json: any; bytes: number } => {
    try {
      const out = execFileSync(bin, ['cli', tool, JSON.stringify({ project })], {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        timeout: 60_000,
      });
      const jsonLine = out.split('\n').find(l => l.trim().startsWith('{')) || '{}';
      return { json: JSON.parse(jsonLine), bytes: Buffer.byteLength(jsonLine, 'utf8') };
    } catch {
      return { json: {}, bytes: 0 };
    }
  };

  const changes = runTool('detect_changes');
  const status = runTool('index_status');



  const changedCount =
    typeof changes.json.changed_count === 'number'
      ? changes.json.changed_count
      : (changes.json.changed_files || []).length;
  const impacted = (changes.json.impacted_symbols || []).length;
  const detail =
    `detect_changes: ${changedCount} changed files, ${impacted} impacted symbols (git file churn, no behavioral semantics); ` +
    `index_status: ${status.json.nodes ?? '?'} nodes / ${status.json.edges ?? '?'} edges (single-snapshot static index — no auth/journey/capability/boundary delta)`;

  return { kinds: [], detail, bytes: changes.bytes };
}

let cached: DepthBehavioralDiffReport | null = null;












export async function buildDepthBehavioralDiffReport(): Promise<DepthBehavioralDiffReport> {
  if (cached) return cached;

  const fixturesRoot = path.join(__dirname, '..', '..', 'fixtures', 'depth-behavioral-diff');
  const binAvailable = codebaseMemoryPath() != null;

  const results: DepthBehavioralDiffCaseResult[] = [];
  for (const fxName of FIXTURES) {
    const dir = path.join(fixturesRoot, fxName);
    let truth: BehavioralTruth;
    try {
      truth = await fs.readJson(path.join(dir, 'truth.json'));
    } catch {
      continue;
    }
    const truthKinds = truth.behavioral_changes.map(c => c.kind);

    const kl = await klauroBehavioralDiff(dir);
    const klauroF1 = f1(kl.kinds, truthKinds);

    const cbm = binAvailable
      ? cbmBehavioralDiff(dir)
      : { kinds: [] as BehavioralKind[], detail: 'cbm absent', bytes: 0 };
    const cbmF1 = f1(cbm.kinds, truthKinds);


    const controlCleanByKlauro = truth.control ? kl.kinds.length === 0 : null;

    let verdict: BehavioralDiffVerdict;
    if (cbmF1 > klauroF1 + 1e-9) verdict = 'loss';
    else if (cbmF1 >= klauroF1 - 1e-9 && cbm.kinds.length > 0) verdict = 'tie';
    else verdict = 'win';

    const klauroTokens = toTokens(kl.bytes);
    let cbmTokens: number;
    if (cbm.kinds.length > 0) {
      cbmTokens = toTokens(cbm.bytes);
    } else {



      let srcBytes = cbm.bytes;
      try {
        for (const half of ['before', 'after']) {
          const halfDir = path.join(dir, half);
          for (const f of await fs.readdir(halfDir)) {
            const st = await fs.stat(path.join(halfDir, f));
            if (st.isFile()) srcBytes += st.size;
          }
        }
      } catch {

      }
      cbmTokens = toTokens(srcBytes);
    }
    const tokenSaving = cbmTokens > 0 ? (cbmTokens - klauroTokens) / cbmTokens : 0;

    results.push({
      fixture: fxName,
      control: truth.control,
      truthKinds,
      klauroKinds: kl.kinds,
      klauroRiskFlags: kl.riskFlags,
      klauroF1,
      klauroTokens,
      cbmKinds: cbm.kinds,
      cbmF1,
      cbmTokens,
      cbmDetectChanges: cbm.detail,
      controlCleanByKlauro,
      verdict,
      tokenSaving,
    });
  }

  const cases = results.length;
  const klauroWins = results.filter(r => r.verdict === 'win').length;
  const ties = results.filter(r => r.verdict === 'tie').length;
  const losses = results.filter(r => r.verdict === 'loss').length;
  const lossFixtures = results.filter(r => r.verdict === 'loss').map(r => r.fixture);
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

  cached = {
    available: binAvailable,
    klauroQueryPath:
      'orchestrateAnalysis(before) + orchestrateAnalysis(after) -> diffBehavior(before, after) ' +
      '(diffBehaviorAgainstSnapshot MCP tool): a STRUCTURED behavioral delta over the CAS behavior ' +
      'pillars — entry-point flows (added/removed/changed), security boundaries (newly unguarded / lost guard), ' +
      'capabilities (added/removed), data_lineage, paradigm_conformance — with human risk_flags.',
    cbmQueryPath:
      'index_repository(after) -> detect_changes + index_status: detect_changes returns a git changed-FILE ' +
      'list with impacted_symbols:[] (textual churn, no behavioral semantics); index_status returns single-' +
      'snapshot node/edge counts. cbm is a static one-snapshot index with no behavioral-delta concept.',
    results,
    aggregate: {
      cases,
      klauroWins,
      ties,
      losses,
      strictWinRate: cases ? klauroWins / cases : 0,
      nonLossRate: cases ? (klauroWins + ties) / cases : 0,
      meanKlauroF1: mean(results.map(r => r.klauroF1)),
      meanCbmF1: mean(results.map(r => r.cbmF1)),
      tokenSaving: mean(results.map(r => r.tokenSaving)),
      lossFixtures,
    },
  };
  return cached;
}


export function __resetDepthBehavioralDiffCache(): void {
  cached = null;
}
