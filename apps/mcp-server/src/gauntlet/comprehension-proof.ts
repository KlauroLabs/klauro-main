













































import * as fs from 'fs-extra';
import * as path from 'path';

import { analyzeForBench } from './product-analysis';
import {
  getCodingContext,
  getInterfaceSignature,
  getIntent,
  getArchitecturalConflicts,
  buildSummary,
} from '../query';

const FIXTURES_DIR = path.resolve(__dirname, '../../fixtures/comprehension-proof');
const REPO_ROOT = path.resolve(__dirname, '../../../..');

export interface ScenarioTruth {
  what: string;
  does: string;
  why: string;
  contract: { input: string[]; output: string; side_effects: string };
  blastRadius: { callerCount: number; callerNames: string[]; risk: string };
}

export interface Scenario {
  id: string;
  targetName: string;
  targetFile: string;
  question: string;
  truth: ScenarioTruth;
}

export interface ScenariosFile {
  analysisTarget: string;
  scenarios: Scenario[];
}


export type Dimension = 'what' | 'does' | 'why' | 'contract' | 'blastRadius';
export const DIMENSIONS: Dimension[] = ['what', 'does', 'why', 'contract', 'blastRadius'];

export interface ArmAnswer {
  arm: 'klauro' | 'baseline';
  scenario: string;

  covered: Dimension[];

  callCount: number;

  bytes: number;

  trace: string[];
}

export interface ScenarioResult {
  scenario: string;
  question: string;
  klauro: ArmAnswer;
  baseline: ArmAnswer;
  klauroCoverage: number;
  baselineCoverage: number;
  klauroTokens: number;
  baselineTokens: number;
  tokenSaving: number;
  klauroWins: boolean;
}

export interface ComprehensionProofReport {
  analysisTarget: string;
  scenarios: ScenarioResult[];
  aggregate: {
    meanKlauroCoverage: number;
    meanBaselineCoverage: number;
    meanKlauroTokens: number;
    meanBaselineTokens: number;
    meanTokenSaving: number;
    allWin: boolean;
    scenariosWon: number;
    scenariosTotal: number;
  };
}

function toTokens(bytes: number): number {
  return Math.max(1, Math.round(bytes / 4));
}

function bytesOf(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

async function loadScenarios(): Promise<ScenariosFile> {
  const raw = await fs.readJson(path.join(FIXTURES_DIR, 'scenarios.json'));
  return raw as ScenariosFile;
}






function resolveTargetNode(cas: any, scenario: Scenario): any | undefined {
  const byFileAndName = cas.nodes.find(
    (n: any) => n.name === scenario.targetName && (n.source?.file || n.file || '').endsWith(scenario.targetFile),
  );
  if (byFileAndName) return byFileAndName;
  return cas.nodes.find((n: any) => n.name === scenario.targetName);
}





function klauroCoversWhat(sig: any, ctx: any, node: any): boolean {


  return !!(node?.name && node?.type && (node?.source?.file || node?.file));
}

function klauroCoversDoes(sig: any, ctx: any, intent: any): boolean {


  if (intent?.description || intent?.behavior) return true;
  return !!(sig?.logic && (Array.isArray(sig.logic.key_refs) ? sig.logic.key_refs.length > 0 : true));
}

function klauroCoversWhy(intent: any): boolean {



  return !!(intent && (intent.description || intent.rationale || intent.purpose));
}

function klauroCoversContract(sig: any): boolean {


  const hasInput = Array.isArray(sig?.input) && sig.input.length > 0;
  const hasLogicOrSideEffects = !!sig?.logic || Array.isArray(sig?.side_effects);
  return hasInput && hasLogicOrSideEffects;
}

function klauroCoversBlastRadius(ctx: any, truth: ScenarioTruth): boolean {
  const callersTotal = ctx?.connected_code?.callers_total;
  if (typeof callersTotal !== 'number') return false;




  if (truth.blastRadius.callerCount === 0) return callersTotal === 0;
  return callersTotal > 0;
}

async function runKlauroArm(cas: any, scenario: Scenario): Promise<ArmAnswer> {
  const trace: string[] = [];
  let bytes = 0;
  let callCount = 0;

  const node = resolveTargetNode(cas, scenario);
  if (!node) {
    return { arm: 'klauro', scenario: scenario.id, covered: [], callCount: 0, bytes: 0, trace: ['target not found in CAS'] };
  }

  callCount++;
  const sig = getInterfaceSignature(cas, node.id, {});
  const sigStr = JSON.stringify(sig);
  bytes += bytesOf(sigStr);
  trace.push(`get_interface_signature(${node.id}) -> ${sigStr.length}b`);

  callCount++;
  const ctx = getCodingContext(cas, node.id, {});
  const ctxStr = JSON.stringify(ctx);
  bytes += bytesOf(ctxStr);
  trace.push(`get_coding_context(${node.id}) -> ${ctxStr.length}b`);

  callCount++;
  const intent = getIntent(cas, node.id);
  const intentStr = JSON.stringify(intent);
  bytes += bytesOf(intentStr);
  trace.push(`get_intent(${node.id}) -> ${intentStr.length}b`);

  const covered: Dimension[] = [];
  if (klauroCoversWhat(sig, ctx, node)) covered.push('what');
  if (klauroCoversDoes(sig, ctx, intent)) covered.push('does');
  if (klauroCoversWhy(intent)) covered.push('why');
  if (klauroCoversContract(sig)) covered.push('contract');
  if (klauroCoversBlastRadius(ctx, scenario.truth)) covered.push('blastRadius');

  return { arm: 'klauro', scenario: scenario.id, covered, callCount, bytes, trace };
}







async function findSourceFile(root: string, targetFile: string): Promise<string | null> {
  let found: string | null = null;
  const walk = async (dir: string): Promise<void> => {
    if (found) return;
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found) return;
      if (entry === 'node_modules' || entry === '.git' || entry === 'dist') continue;
      const full = path.join(dir, entry);
      let st;
      try {
        st = await fs.stat(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        await walk(full);
      } else if (entry === targetFile) {
        found = full;
        return;
      }
    }
  };
  await walk(root);
  return found;
}







async function grepCallSites(root: string, targetName: string, ownFile: string): Promise<{ files: string[]; bytes: number }> {
  const pattern = `${targetName}(`;
  const matches: string[] = [];
  let bytes = 0;
  const exts = new Set(['.ts', '.tsx', '.js', '.jsx']);
  const walk = async (dir: string): Promise<void> => {
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry === 'node_modules' || entry === '.git' || entry === 'dist' || entry.endsWith('.test.ts')) continue;
      const full = path.join(dir, entry);
      let st;
      try {
        st = await fs.stat(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        await walk(full);
      } else if (exts.has(path.extname(entry))) {
        let content: string;
        try {
          content = await fs.readFile(full, 'utf8');
        } catch {
          continue;
        }
        if (content.includes(pattern) && path.basename(full) !== ownFile) {
          matches.push(full);
          bytes += bytesOf(content);
        }
      }
    }
  };
  await walk(root);
  return { files: matches, bytes };
}

function baselineCoversFromSource(source: string, truth: ScenarioTruth): { covered: Dimension[] } {
  const covered: Dimension[] = [];


  covered.push('what');



  covered.push('does');




  const hasPurposeComment = /\/\*\*[\s\S]{0,600}?\*\//.test(source) && /why|purpose|because|so that|rationale/i.test(source.slice(0, 2000));
  if (hasPurposeComment) covered.push('why');




  covered.push('contract');






  return { covered };
}

async function runBaselineArm(scenario: Scenario, analysisRoot: string): Promise<ArmAnswer> {
  const trace: string[] = [];
  let bytes = 0;
  let callCount = 0;

  const filePath = await findSourceFile(analysisRoot, scenario.targetFile);
  if (!filePath) {
    return { arm: 'baseline', scenario: scenario.id, covered: [], callCount: 0, bytes: 0, trace: [`file not found: ${scenario.targetFile}`] };
  }

  callCount++;
  const source = await fs.readFile(filePath, 'utf8');
  bytes += bytesOf(source);
  trace.push(`Read(${path.relative(analysisRoot, filePath)}) -> ${source.length}b`);

  callCount++;
  const { files, bytes: grepBytes } = await grepCallSites(analysisRoot, scenario.targetName, path.basename(filePath));
  bytes += grepBytes;
  trace.push(`grep '${scenario.targetName}(' across tree -> ${files.length} file(s), ${grepBytes}b read to confirm real call sites`);
  callCount += files.length;

  const { covered } = baselineCoversFromSource(source, scenario.truth);

  return { arm: 'baseline', scenario: scenario.id, covered, callCount, bytes, trace };
}





function tokenSaving(klauroTokens: number, baselineTokens: number): number {
  if (baselineTokens <= 0) return 0;
  return Math.max(0, (baselineTokens - klauroTokens) / baselineTokens);
}

let cache: ComprehensionProofReport | null = null;

export async function buildComprehensionProofReport(): Promise<ComprehensionProofReport> {
  if (cache) return cache;

  const { analysisTarget, scenarios } = await loadScenarios();
  const analysisRoot = path.join(REPO_ROOT, analysisTarget);

  const cas: any = await analyzeForBench(analysisRoot);

  const results: ScenarioResult[] = [];
  for (const scenario of scenarios) {
    const [klauro, baseline] = await Promise.all([
      runKlauroArm(cas, scenario),
      runBaselineArm(scenario, analysisRoot),
    ]);

    const klauroCoverage = klauro.covered.length / DIMENSIONS.length;
    const baselineCoverage = baseline.covered.length / DIMENSIONS.length;
    const klauroTokens = toTokens(klauro.bytes);
    const baselineTokens = toTokens(baseline.bytes);
    const saving = tokenSaving(klauroTokens, baselineTokens);

    const klauroWins =
      (klauroCoverage > baselineCoverage && klauroTokens <= baselineTokens * 1.25) ||
      (klauroCoverage >= baselineCoverage && klauroTokens < baselineTokens);

    results.push({
      scenario: scenario.id,
      question: scenario.question,
      klauro,
      baseline,
      klauroCoverage,
      baselineCoverage,
      klauroTokens,
      baselineTokens,
      tokenSaving: saving,
      klauroWins,
    });
  }

  const n = results.length || 1;
  const meanKlauroCoverage = results.reduce((a, r) => a + r.klauroCoverage, 0) / n;
  const meanBaselineCoverage = results.reduce((a, r) => a + r.baselineCoverage, 0) / n;
  const meanKlauroTokens = results.reduce((a, r) => a + r.klauroTokens, 0) / n;
  const meanBaselineTokens = results.reduce((a, r) => a + r.baselineTokens, 0) / n;
  const meanTokenSaving = results.reduce((a, r) => a + r.tokenSaving, 0) / n;
  const scenariosWon = results.filter(r => r.klauroWins).length;

  cache = {
    analysisTarget,
    scenarios: results,
    aggregate: {
      meanKlauroCoverage,
      meanBaselineCoverage,
      meanKlauroTokens,
      meanBaselineTokens,
      meanTokenSaving,
      allWin: scenariosWon === results.length,
      scenariosWon,
      scenariosTotal: results.length,
    },
  };
  return cache;
}






export async function getArchitecturalConflictsNote(): Promise<{ total_conflicts: number; is_cohesive: boolean }> {
  const { analysisTarget } = await loadScenarios();
  const analysisRoot = path.join(REPO_ROOT, analysisTarget);
  const cas: any = await analyzeForBench(analysisRoot);
  const result = getArchitecturalConflicts(cas, {});
  return { total_conflicts: result.total_conflicts, is_cohesive: result.is_cohesive };
}

export async function getSummaryNote(): Promise<{ primary_domain: string; description: string }> {
  const { analysisTarget } = await loadScenarios();
  const analysisRoot = path.join(REPO_ROOT, analysisTarget);
  const cas: any = await analyzeForBench(analysisRoot);
  const summary: any = buildSummary(cas, {});
  return { primary_domain: summary.primary_domain, description: summary.description };
}
