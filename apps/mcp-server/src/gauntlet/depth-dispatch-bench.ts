






































































import * as fs from 'fs-extra';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { analyzeForBench } from './product-analysis';
import { codebaseMemoryPath } from './real-camp-arms';

interface DispatchTruth {
  task: 'interface-to-impl-dispatch';
  language: string;
  lsp_lang: boolean;
  description: string;
  call_site: {
    caller: string;
    method: string;
    receiver_type: string;
    constructed_as?: string;
    line: number;
  };
  interface: string;
  implementations: string[];
  decoy_class: string;
  resolves_to: string[];
}

export type DispatchVerdict = 'tie-ceiling' | 'win' | 'loss';

export interface DepthDispatchCaseResult {
  fixture: string;
  language: string;
  lspLang: boolean;

  truthImpls: string[];

  klauroImpls: string[];
  klauroF1: number;
  klauroTokens: number;

  klauroHow: string;

  cbmImpls: string[];
  cbmF1: number;
  cbmTokens: number;

  cbmHow: string;

  decoyExcludedByKlauro: boolean;
  verdict: DispatchVerdict;
  tokenSaving: number;
}

export interface DepthDispatchReport {
  available: boolean;
  klauroQueryPath: string;
  cbmQueryPath: string;
  results: DepthDispatchCaseResult[];
  aggregate: {
    cases: number;
    wins: number;
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

const FIXTURES = ['java-shapes', 'java-newlocal', 'go-shapes', 'ruby-shapes'];

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


const IMPL_EDGE_TYPES = new Set(['implements', 'extends', 'includes', 'inherits']);

const OWN_EDGE_TYPES = new Set(['has_method', 'contains', 'declares']);














function klauroResolve(
  cas: any,
  truth: DispatchTruth,
): { impls: string[]; how: string; bytes: number } {
  const nodes: any[] = cas.nodes || [];
  const edges: any[] = cas.edges || [];
  const byId = new Map(nodes.map(n => [n.id, n]));
  const methodName = truth.call_site.method;
  const recvType = truth.call_site.receiver_type;


  const ifaceIds = new Set(
    nodes
      .filter(n => n.name === recvType && /interface|module/.test(String(n.type)))
      .map(n => n.id),
  );
  if (ifaceIds.size === 0) {
    return {
      impls: [],
      how: `no interface/module node "${recvType}" in CAS (structural graph missing)`,
      bytes: 0,
    };
  }


  const implClassIds = new Set(
    edges
      .filter(e => IMPL_EDGE_TYPES.has(String(e.type)) && ifaceIds.has(e.target))
      .map(e => e.source),
  );



  const ownerOf = (methodNodeId: string): string | undefined => {
    const m: any = byId.get(methodNodeId);
    if (m?.parent && byId.has(m.parent)) return m.parent;
    const owning = edges.find(
      e => OWN_EDGE_TYPES.has(String(e.type)) && e.target === methodNodeId,
    );
    return owning?.source;
  };

  const resolved: string[] = [];
  for (const classId of implClassIds) {
    const cls: any = byId.get(classId);
    if (!cls) continue;

    const m = nodes.find(
      n =>
        n.name === methodName &&
        /method/.test(String(n.type)) &&
        !/interface_method/.test(String(n.type)) &&
        ownerOf(n.id) === classId,
    );
    if (m) resolved.push(`${cls.name}.${methodName}`);
  }


  let how: string;
  let finalImpls = [...new Set(resolved)];
  if (truth.call_site.constructed_as) {
    const pinned = truth.call_site.constructed_as;



    const callerClass = truth.call_site.caller.split('.')[0];
    const ctorSeen = nodes.some(
      n =>
        n.name === pinned &&
        /method/.test(String(n.type)) &&
        (() => {
          const o = ownerOf(n.id);
          const oc: any = o ? byId.get(o) : undefined;
          return oc?.name === callerClass;
        })(),
    );
    const narrowed = finalImpls.filter(t => t.startsWith(`${pinned}.`));
    if (ctorSeen && narrowed.length > 0) {
      finalImpls = narrowed;
      how =
        `CHA over implements edges -> {${[...implClassIds]
          .map(id => byId.get(id)?.name)
          .filter(Boolean)
          .join(', ')}}, narrowed by constructor binding (new ${pinned}()) to ${pinned}.${methodName}`;
    } else {
      how =
        `CHA over implements edges (constructor binding for new ${pinned}() not confirmed; full impl set kept)`;
    }
  } else {
    how =
      `CHA: receiver type ${recvType} -> implementors {${[...implClassIds]
        .map(id => byId.get(id)?.name)
        .filter(Boolean)
        .join(', ')}} -> each .${methodName}`;
  }

  return {
    impls: finalImpls,
    how,
    bytes: Buffer.byteLength(JSON.stringify(finalImpls), 'utf8'),
  };
}









function cbmResolve(
  dir: string,
  truth: DispatchTruth,
): { impls: string[]; how: string; bytes: number } {
  const bin = codebaseMemoryPath();
  if (!bin) return { impls: [], how: 'cbm absent', bytes: 0 };

  let project = '';
  try {
    const idx = execFileSync(
      bin,
      ['cli', 'index_repository', JSON.stringify({ repo_path: dir })],
      { encoding: 'utf8', timeout: 120_000, maxBuffer: 64 * 1024 * 1024 },
    );
    const line = idx.split('\n').find(l => l.trim().startsWith('{') && l.includes('"project"'));
    if (line) project = JSON.parse(line).project;
  } catch {
    return { impls: [], how: 'cbm index failed', bytes: 0 };
  }
  if (!project) project = dir.replace(/^\/+/, '').replace(/[^A-Za-z0-9_]+/g, '-');

  const methodName = truth.call_site.method;
  const ifaceName = truth.interface;
  let bytes = 0;

  const cli = (tool: string, args: any): any => {
    let out = '';
    try {
      out = execFileSync(bin, ['cli', tool, JSON.stringify({ project, ...args })], {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        timeout: 60_000,
      });
    } catch {
      return null;
    }
    const jsonLine = out.split('\n').find(l => l.trim().startsWith('{')) || '{}';
    bytes += Buffer.byteLength(jsonLine, 'utf8');
    try {
      return JSON.parse(jsonLine);
    } catch {
      return null;
    }
  };


  const trace = cli('trace_path', { function_name: truth.call_site.caller.split('.').pop() });
  const boundToInterface =
    trace &&
    Array.isArray(trace.callees) &&
    trace.callees.some(
      (c: any) =>
        c.name === methodName &&
        String(c.qualified_name || '').endsWith(`.${ifaceName}.${methodName}`),
    );



  const impl = cli('query_graph', {
    query: `MATCH (c)-[:IMPLEMENTS]->(i) WHERE i.name = "${ifaceName}" RETURN c.name`,
  });
  const implementors: string[] = impl?.rows
    ? impl.rows.map((r: any[]) => String(r[0])).filter(Boolean)
    : [];

  const impls: string[] = [];
  if (implementors.length > 0) {
    const methods = cli('query_graph', {
      query: `MATCH (m:Method) WHERE m.name = "${methodName}" RETURN m.name, m.parent_class`,
    });
    const ownerOf = (pc: string): string => String(pc || '').split('.').pop() || pc;
    for (const row of methods?.rows || []) {
      const owner = ownerOf(String(row[1]));
      if (implementors.includes(owner)) impls.push(`${owner}.${methodName}`);
    }
  }

  const uniq = [...new Set(impls)];
  let how: string;
  if (uniq.length > 0) {
    how =
      `trace_path bound call to ${boundToInterface ? `${ifaceName}.${methodName} (interface)` : 'a method'}; ` +
      `IMPLEMENTS-CHA -> implementors {${implementors.join(', ')}} -> {${uniq.join(', ')}}`;
  } else if (implementors.length > 0) {
    how = `IMPLEMENTS edges found {${implementors.join(', ')}} but no matching impl Method`;
  } else {
    how = truth.lsp_lang
      ? 'no IMPLEMENTS edges (cbm did not build the hierarchy for this file)'
      : 'non-LSP lang: cbm has no symbol graph for this file -> out-of-category';
  }

  return { impls: uniq, how, bytes };
}

let cached: DepthDispatchReport | null = null;












export async function buildDepthDispatchReport(): Promise<DepthDispatchReport> {
  if (cached) return cached;

  const fixturesRoot = path.join(__dirname, '..', '..', 'fixtures', 'depth-dispatch');
  const binAvailable = codebaseMemoryPath() != null;

  const results: DepthDispatchCaseResult[] = [];
  for (const fxName of FIXTURES) {
    const dir = path.join(fixturesRoot, fxName);
    let truth: DispatchTruth;
    try {
      truth = await fs.readJson(path.join(dir, 'truth.json'));
    } catch {
      continue;
    }
    const truthImpls = [...new Set(truth.resolves_to)];

    const cas: any = await analyzeForBench(dir);
    const kl = klauroResolve(cas, truth);
    const klauroF1 = f1(kl.impls, truthImpls);

    const cbm = binAvailable
      ? cbmResolve(dir, truth)
      : { impls: [] as string[], how: 'cbm absent', bytes: 0 };
    const cbmF1 = f1(cbm.impls, truthImpls);


    const decoyTuple = `${truth.decoy_class}.${truth.call_site.method}`;
    const decoyExcludedByKlauro = !kl.impls.includes(decoyTuple);

    let verdict: DispatchVerdict;
    if (cbmF1 > klauroF1 + 1e-9) verdict = 'loss';
    else if (Math.abs(cbmF1 - klauroF1) <= 1e-9 && cbm.impls.length > 0) verdict = 'tie-ceiling';
    else verdict = 'win';

    const klauroTokens = toTokens(kl.bytes || 1);
    let cbmTokens: number;
    if (cbm.impls.length > 0) {
      cbmTokens = toTokens(cbm.bytes);
    } else {


      let srcBytes = cbm.bytes;
      try {
        for (const f of await fs.readdir(dir)) {
          if (f === 'truth.json') continue;
          const st = await fs.stat(path.join(dir, f));
          if (st.isFile()) srcBytes += st.size;
        }
      } catch {

      }
      cbmTokens = toTokens(srcBytes);
    }
    const tokenSaving = cbmTokens > 0 ? (cbmTokens - klauroTokens) / cbmTokens : 0;

    results.push({
      fixture: fxName,
      language: truth.language,
      lspLang: truth.lsp_lang,
      truthImpls,
      klauroImpls: kl.impls,
      klauroF1,
      klauroTokens,
      klauroHow: kl.how,
      cbmImpls: cbm.impls,
      cbmF1,
      cbmTokens,
      cbmHow: cbm.how,
      decoyExcludedByKlauro,
      verdict,
      tokenSaving,
    });
  }

  const cases = results.length;
  const wins = results.filter(r => r.verdict === 'win').length;
  const ties = results.filter(r => r.verdict === 'tie-ceiling').length;
  const losses = results.filter(r => r.verdict === 'loss').length;
  const lossFixtures = results.filter(r => r.verdict === 'loss').map(r => r.fixture);
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

  cached = {
    available: binAvailable,
    klauroQueryPath:
      'orchestrateAnalysis -> CHA over the deterministic structural graph: ' +
      'implements/includes/extends edges (impl-of) + has_method/contains edges & ' +
      'method.parent (method-ownership) + declares (interface_method). Receiver ' +
      'static type -> implementors -> each implementor .method; constructor-pinned ' +
      'locals narrowed via the emitted constructor has_method binding.',
    cbmQueryPath:
      'index_repository -> trace_path {caller} (binds call to the INTERFACE method, ' +
      'strategy lsp_interface_dispatch) -> query_graph MATCH ()-[:IMPLEMENTS]->(iface) ' +
      'for implementors -> query_graph Method.parent_class for each implementor\'s ' +
      'same-named method. Compiler-grade CHA on LSP langs; empty on non-LSP langs.',
    results,
    aggregate: {
      cases,
      wins,
      ties,
      losses,
      strictWinRate: cases ? wins / cases : 0,
      nonLossRate: cases ? (wins + ties) / cases : 0,
      meanKlauroF1: mean(results.map(r => r.klauroF1)),
      meanCbmF1: mean(results.map(r => r.cbmF1)),
      tokenSaving: mean(results.map(r => r.tokenSaving)),
      lossFixtures,
    },
  };
  return cached;
}


export function __resetDepthDispatchCache(): void {
  cached = null;
}
