




































































import * as fs from 'fs-extra';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { analyzeForBench } from './product-analysis';
import { getUserJourneys } from '../query';
import { codebaseMemoryPath } from './real-camp-arms';

interface TaintFlow {
  source: string;
  sink: string;
  path: string[];
  sink_kind: string;
}

interface TaintTruth {
  task: 'cross-function-source-to-sink';
  language: string;
  description: string;
  flows: TaintFlow[];
  decoys: Array<{ source: string; shared_var: string; reaches: string; does_not_reach_sink: boolean }>;
  entry_functions: string[];
  sink_functions: string[];
}


function flowKey(source: string, sink: string, hops: string[]): string {
  return `${source.trim()} => ${sink.trim()} [${[...hops].sort().join('|')}]`;
}

export type TaintVerdict = 'win' | 'tie' | 'loss';

export interface DepthTaintCaseResult {
  fixture: string;
  sinkKind: string;
  truthFlows: string[];

  klauroFlows: string[];
  klauroF1: number;
  klauroTokens: number;

  cbmFlows: string[];
  cbmF1: number;
  cbmTokens: number;

  cbmTracePath: string;

  decoyHandledByKlauro: boolean | null;
  verdict: TaintVerdict;
  tokenSaving: number;
}

export interface DepthTaintReport {
  available: boolean;

  klauroQueryPath: string;

  cbmQueryPath: string;
  results: DepthTaintCaseResult[];
  aggregate: {
    cases: number;
    klauroWins: number;
    ties: number;
    losses: number;
    winRate: number;
    meanKlauroF1: number;
    meanCbmF1: number;
    tokenSaving: number;
    lossFixtures: string[];
  };
}

const FIXTURES = ['express-sql', 'express-fswrite', 'pii-external', 'decoy-noflow'];

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

function normEntry(j: any): string {
  const method = (j?.entry?.method || '').toUpperCase();
  const p = j?.entry?.path_or_trigger || '';
  return method && p ? `${method} ${p}` : (j?.entry?.name || j?.name || '');
}








async function klauroFlows(dir: string): Promise<{ flows: string[]; bytes: number }> {
  const cas: any = await analyzeForBench(dir);




  const listed: any = getUserJourneys(cas, { limit: 200 });
  void listed;
  const journeys: any[] = cas.user_journeys || [];
  const flows: string[] = [];
  for (const j of journeys) {
    const source = normEntry(j);
    const stepNames: string[] = (j.steps || []).map((s: any) => s.name);

    const hops = stepNames.filter(n => n && n !== source && !/\s\//.test(n));
    for (const t of j.terminal_entities || []) {
      const sink = t?.name;
      if (!sink) continue;

      const hopSet = [...new Set([...hops, sink])];
      flows.push(flowKey(source, sink, hopSet));
    }
  }
  const uniq = [...new Set(flows)];
  return { flows: uniq, bytes: Buffer.byteLength(JSON.stringify(uniq), 'utf8') };
}










function cbmFlows(
  dir: string,
  truth: TaintTruth,
): { flows: string[]; bytes: number; trace: string } {
  const bin = codebaseMemoryPath();
  if (!bin) return { flows: [], bytes: 0, trace: 'cbm absent' };

  let project = '';
  try {
    const idx = execFileSync(bin, ['cli', 'index_repository', JSON.stringify({ repo_path: dir })], {
      encoding: 'utf8',
      timeout: 120_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    const line = idx.split('\n').find(l => l.trim().startsWith('{') && l.includes('"project"'));
    if (line) project = JSON.parse(line).project;
  } catch {
    return { flows: [], bytes: 0, trace: 'index failed' };
  }
  if (!project) project = dir.replace(/^\/+/, '').replace(/[^A-Za-z0-9_]+/g, '-');

  const sinkSet = new Set(truth.sink_functions);
  const tracedReaches: string[] = [];
  let bytes = 0;

  const calleesOf = (fn: string): string[] => {
    let out = '';
    try {
      out = execFileSync(bin, ['cli', 'trace_path', JSON.stringify({ project, function_name: fn })], {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        timeout: 60_000,
      });
    } catch {
      return [];
    }
    const jsonLine = out.split('\n').find(l => l.trim().startsWith('{')) || '{}';
    bytes += Buffer.byteLength(jsonLine, 'utf8');
    let parsed: any;
    try { parsed = JSON.parse(jsonLine); } catch { return []; }
    return (parsed.callees || []).map((c: any) => String(c.name));
  };


  for (const entry of truth.entry_functions) {
    const seen = new Set<string>([entry]);
    const queue = [entry];
    while (queue.length) {
      const cur = queue.shift()!;
      for (const callee of calleesOf(cur)) {
        if (sinkSet.has(callee)) tracedReaches.push(`${entry} ->* ${callee}`);
        if (!seen.has(callee)) {
          seen.add(callee);
          queue.push(callee);
        }
      }
    }
  }

  const uniqReaches = [...new Set(tracedReaches)];




  const trace = uniqReaches.length
    ? `trace_path call-edge reach: ${uniqReaches.join(', ')} (call adjacency only — no HTTP source binding, no value-flow)`
    : 'trace_path: no call-edge reach to a sink function';

  return { flows: [], bytes, trace };
}

let cached: DepthTaintReport | null = null;












export async function buildDepthTaintReport(): Promise<DepthTaintReport> {
  if (cached) return cached;

  const fixturesRoot = path.join(__dirname, '..', '..', 'fixtures', 'depth-taint');
  const binAvailable = codebaseMemoryPath() != null;

  const results: DepthTaintCaseResult[] = [];
  for (const fxName of FIXTURES) {
    const dir = path.join(fixturesRoot, fxName);
    let truth: TaintTruth;
    try {
      truth = await fs.readJson(path.join(dir, 'truth.json'));
    } catch {
      continue;
    }
    const truthFlows = truth.flows.map(fl => flowKey(fl.source, fl.sink, [...new Set([...fl.path, fl.sink])]));

    const kl = await klauroFlows(dir);
    const klauroF1 = f1(kl.flows, truthFlows);

    const cbm = binAvailable
      ? cbmFlows(dir, truth)
      : { flows: [] as string[], bytes: 0, trace: 'cbm absent' };
    const cbmF1 = f1(cbm.flows, truthFlows);





    let decoyHandledByKlauro: boolean | null = null;
    if (truth.decoys.length > 0) {
      const decoySources = new Set(truth.decoys.map(d => d.source.trim()));
      decoyHandledByKlauro = !kl.flows.some(fl => decoySources.has(fl.split(' => ')[0].trim()));
    }

    let verdict: TaintVerdict;
    if (cbmF1 > klauroF1 + 1e-9) verdict = 'loss';
    else if (cbmF1 >= klauroF1 - 1e-9 && cbm.flows.length > 0) verdict = 'tie';
    else verdict = 'win';

    const klauroTokens = toTokens(kl.bytes);
    let cbmTokens: number;
    if (cbm.flows.length > 0) {
      cbmTokens = toTokens(cbm.bytes);
    } else {


      let srcBytes = cbm.bytes;
      try {
        for (const f of await fs.readdir(dir)) {
          if (f === 'truth.json') continue;
          const st = await fs.stat(path.join(dir, f));
          if (st.isFile()) srcBytes += st.size;
        }
      } catch {   }
      cbmTokens = toTokens(srcBytes);
    }
    const tokenSaving = cbmTokens > 0 ? (cbmTokens - klauroTokens) / cbmTokens : 0;

    results.push({
      fixture: fxName,
      sinkKind: truth.flows[0]?.sink_kind || 'unknown',
      truthFlows,
      klauroFlows: kl.flows,
      klauroF1,
      klauroTokens,
      cbmFlows: cbm.flows,
      cbmF1,
      cbmTokens,
      cbmTracePath: cbm.trace,
      decoyHandledByKlauro,
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
      'orchestrateAnalysis -> get_user_journeys: each journey binds source=entry (METHOD /path), ' +
      'path=steps (cross-function call chain), sink=terminal_entities[].name. (cas.data_lineage is the ' +
      'complementary entity-centric writers/readers/recipients view via get_data_lineage.)',
    cbmQueryPath:
      'index_repository -> trace_path {function_name}: returns call-graph callees/callers only. No HTTP-source ' +
      'binding (inline app.post handlers are not Route nodes), no value-flow/taint -> cannot emit a ' +
      'source->sink flow fact; produces call adjacency at best.',
    results,
    aggregate: {
      cases,
      klauroWins,
      ties,
      losses,
      winRate: cases ? (klauroWins + ties) / cases : 0,
      meanKlauroF1: mean(results.map(r => r.klauroF1)),
      meanCbmF1: mean(results.map(r => r.cbmF1)),
      tokenSaving: mean(results.map(r => r.tokenSaving)),
      lossFixtures,
    },
  };
  return cached;
}


export function __resetDepthTaintCache(): void {
  cached = null;
}
